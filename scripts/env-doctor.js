#!/usr/bin/env node
"use strict";
// env-doctor.js - Connect AI 환경 건강 진단 (자가 검증 최적화 버전)
// 사용법: node scripts/env-doctor.js

const { execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const warnings = [];
const ok = [];

function sh(cmd) {
  try { 
    return execSync(cmd, { encoding: "utf8", windowsHide: true, timeout: 15000 }); 
  } catch { 
    return ""; 
  }
}

// 1. 디스크 여유 공간 체크 (Windows)
try {
  if (process.platform === "win32") {
    const out = sh('powershell -NoProfile -Command "$d = Get-PSDrive C; \'{0} {1}\' -f $d.Free, ($d.Used + $d.Free)"').trim();
    if (out) {
      const parts = out.split(/\s+/).map(Number);
      if (parts.length >= 2 && !parts.some(isNaN)) {
        const [free, total] = parts;
        const pct = total > 0 ? Math.round(free / total * 100) : 100;
        if (pct < 10) {
          warnings.push(`디스크 C: 여유 공간 ${pct}%로 위험 (10% 미만)`);
        } else {
          ok.push(`디스크 C: ${pct}% 여유 공간 (정상)`);
        }
      } else {
        warnings.push(`디스크 C: 디스크 공간 정보를 파싱할 수 없음 (출력 포맷 불일치)`);
      }
    } else {
      warnings.push(`디스크 C: 디스크 공간 확인 명령어 응답 없음`);
    }
  }
} catch (e) {
  warnings.push(`디스크 C: 공간 조회 중 예외 발생: ${e.message}`);
}

// 2. 오래된 node/codex 프로세스 체크 (메모리 및 CPU 대기 누수 감지)
try {
  if (process.platform === "win32") {
    // StartTime 접근 권한 오류 방지를 위해 ErrorAction SilentlyContinue 적용
    const ps = "$p = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match 'codex|node' }; $old = $p | Where-Object { try { $_.StartTime -lt (Get-Date).AddHours(-12) } catch { $false } }; $count = @($old).Count; $sum = if ($count -gt 0) { ($old | Measure-Object WorkingSet -Sum).Sum } else { 0 }; '{0} {1}' -f $count, $sum";
    const out = sh(`powershell -NoProfile -Command "${ps}"`).trim();
    if (out) {
      const parts = out.split(/\s+/).map(Number);
      if (parts.length >= 2 && !parts.some(isNaN)) {
        const [count, sumBytes] = parts;
        if (count >= 5) {
          warnings.push(`12시간 이상 대기 중인 오래된 codex/node 프로세스가 ${count}개(${Math.round(sumBytes/1024/1024)}MB) 감지되었습니다. 불필요할 경우 정리를 권장합니다.`);
        } else if (count > 0) {
          ok.push(`12시간 이상 대기 중인 오래된 프로세스 ${count}개 감지 (안정 영역)`);
        } else {
          ok.push(`오래된 좀비 codex/node 프로세스 없음 (정상)`);
        }
      }
    }
  }
} catch (e) {
  /* 무시 */
}

// 3. CLI 인증 토큰 만료 여부 검사 (path.join 플랫폼 독립성 준수)
const userHome = process.env.USERPROFILE || process.env.HOME || "";
if (userHome) {
  const authChecks = [
    { name: "Codex", path: path.join(userHome, ".codex", "auth.json") },
    { name: "Gemini", path: path.join(userHome, ".gemini", "oauth_creds.json") },
  ];
  for (const a of authChecks) {
    try {
      if (fs.existsSync(a.path)) {
        const st = fs.statSync(a.path);
        const days = Math.round((Date.now() - st.mtimeMs) / 86400000);
        if (days > 25) {
          warnings.push(`${a.name} 인증 토큰이 갱신된 지 ${days}일이 경과하여 곧 만료될 수 있으니 재로그인을 권장합니다.`);
        } else {
          ok.push(`${a.name} 인증 상태 정상 (${days}일 전 갱신됨)`);
        }
      } else {
        warnings.push(`${a.name} 인증 설정 파일이 존재하지 않습니다. (${a.path})`);
      }
    } catch (e) {
      warnings.push(`${a.name} 인증 상태 검사 실패: ${e.message}`);
    }
  }
}

// 4. 로컬 대시보드 및 AI 서비스 포트 진단 (TcpClient 소켓 연결 타임아웃 150ms 극단적 최적화 - 대기 장애 원천 차단)
const ports = [
  { n: "Ollama", p: 11434 }, 
  { n: "n8n", p: 5678 }, 
  { n: "Agent Dashboard", p: 9000 }
];

for (const svc of ports) {
  try {
    // Test-NetConnection 대신 TcpClient를 이용하여 150ms 만에 신속 진단 완료 (닫혀 있어도 대기 지연 전혀 없음!)
    const ps = `$t = New-Object System.Net.Sockets.TcpClient; $ar = $t.BeginConnect('127.0.0.1', ${svc.p}, $null, $null); $wait = $ar.AsyncWaitHandle.WaitOne(150); if ($wait -and $t.Connected) { $t.Close(); 'True' } else { if ($t.Connected) { $t.Close() }; 'False' }`;
    const alive = sh(`powershell -NoProfile -Command "${ps}"`).trim().includes("True");
    if (!alive) {
      warnings.push(`${svc.n} (포트 ${svc.p}) 응답 없음 - 서비스가 활성화되어 있는지 확인해 주세요.`);
    } else {
      ok.push(`${svc.n} 포트 정상 연결됨 (${svc.p})`);
    }
  } catch (e) {
    warnings.push(`${svc.n} 진단 중 예외 발생: ${e.message}`);
  }
}

console.log(JSON.stringify({ ok, warnings, healthy: warnings.length === 0 }, null, 2));