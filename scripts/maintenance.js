#!/usr/bin/env node
"use strict";
// maintenance.js — Connect AI 환경 정리 후보 리포트.
// 기본값은 report-only다. 실제 삭제는 --execute가 있을 때만 수행한다.
// 사용: node scripts/maintenance.js [--dry-run] [--execute] [--days N]
//   --dry-run : 삭제 안 하고 대상만 출력 (기본)
//   --execute --human-approved : N일보다 오래된 잔재 삭제 적용
//   --days N  : N일보다 오래된 잔재를 삭제/후보 표시 (기본 7)

const fs = require("node:fs");
const path = require("node:path");

let envPaths;
try { envPaths = require("./env-paths.js"); } catch { envPaths = null; }

function getArg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] || fallback) : fallback;
}
const executeRequested = process.argv.includes("--execute");
const humanApproved = process.argv.includes("--human-approved");
const blockedReason = executeRequested && !humanApproved
  ? "HUMAN_APPROVAL_REQUIRED_FOR_DESTRUCTIVE_CLEANUP"
  : "";
const execute = executeRequested && humanApproved && !process.argv.includes("--dry-run");
const dryRun = !execute;
const maxAgeDays = parseInt(getArg("days", "7"), 10) || 7;
const maxAgeMs = maxAgeDays * 86400000;

function queueDir() {
  if (envPaths && envPaths.agentQueuePath) return path.dirname(envPaths.agentQueuePath());
  const appdata = process.env.APPDATA;
  if (appdata) return path.join(appdata, "Code", "User", "globalStorage", "connectailab.connect-ai-lab", "phase3");
  return null;
}

// 정리 대상 패턴: 잔재성 파일만. 활성 큐(agent-queue.json)와 최신 백업 1개는 보존.
const JUNK_PATTERNS = [
  /\.tmp-\d+/,            // 원자적 쓰기 임시파일(고아)
  /\.corrupt-\d+/,        // 손상본
  /bak-before-/,          // 수동 백업
  /\.log$/,               // 로그
];

function scan(dir, results) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { scan(full, results); continue; }
    if (JUNK_PATTERNS.some((re) => re.test(e.name))) {
      try {
        const st = fs.statSync(full);
        results.push({ path: full, name: e.name, ageMs: Date.now() - st.mtimeMs, size: st.size });
      } catch { /* */ }
    }
  }
}

// 오래된 세션 폴더 정리: companyDir/sessions/<timestamp>/
// 작업 이력이므로 최근 N개(기본 30)는 무조건 보존, 그보다 오래된 것만 maxAgeMs 경과 시 삭제.
function cleanupSessions(dryRun, maxAgeMs, keepRecent) {
  const result = { scanned: 0, deleteCandidates: 0, deleted: 0, freedKB: 0 };
  let companyDir;
  try { companyDir = envPaths && envPaths.companyDir ? envPaths.companyDir() : null; } catch { companyDir = null; }
  if (!companyDir) return result;
  const sessDir = path.join(companyDir, "sessions");
  let entries;
  try { entries = fs.readdirSync(sessDir, { withFileTypes: true }).filter((e) => e.isDirectory()); }
  catch { return result; }
  result.scanned = entries.length;
  // 이름(타임스탬프)순 정렬 → 최근 keepRecent개는 보존
  const sorted = entries.map((e) => e.name).sort();
  const deletable = sorted.slice(0, Math.max(0, sorted.length - keepRecent));
  for (const name of deletable) {
    const full = path.join(sessDir, name);
    try {
      const st = fs.statSync(full);
      if (Date.now() - st.mtimeMs <= maxAgeMs) continue; // 아직 안 오래됨
      // 크기 집계
      let size = 0;
      const stack = [full];
      while (stack.length) {
        const cur = stack.pop();
        for (const c of fs.readdirSync(cur, { withFileTypes: true })) {
          const cp = path.join(cur, c.name);
          if (c.isDirectory()) stack.push(cp);
          else { try { size += fs.statSync(cp).size; } catch { /* */ } }
        }
      }
      result.freedKB += Math.round(size / 1024);
      result.deleteCandidates += 1;
      if (!dryRun) {
        fs.rmSync(full, { recursive: true, force: true });
        result.deleted += 1;
      }
    } catch { /* */ }
  }
  return result;
}

function main() {
  const dirs = [];
  const qd = queueDir();
  if (qd) {
    dirs.push(path.dirname(qd)); // connect-ai-lab 루트(phase2/phase3 포함)
  }
  // WSL 로그
  if (process.env.HOME) dirs.push(path.join(process.env.HOME, ".connect-ai-logs"));

  const found = [];
  for (const d of dirs) scan(d, found);

  // bak-before- 는 가장 최근 1개 보존
  const baks = found.filter((f) => /bak-before-/.test(f.name)).sort((a, b) => a.ageMs - b.ageMs);
  const keepBak = baks.length ? baks[0].path : null;

  const toDelete = found.filter((f) => {
    if (f.path === keepBak) return false;       // 최신 백업 보존
    if (/bak-before-/.test(f.name)) return true; // 나머지 백업은 나이 무관 삭제
    return f.ageMs > maxAgeMs;                    // 그 외는 N일 경과분만
  });

  let freed = 0;
  let deleted = 0;
  for (const f of toDelete) {
    freed += f.size;
    if (!dryRun) {
      try {
        fs.unlinkSync(f.path);
        deleted += 1;
      } catch { /* */ }
    }
  }

  // 오래된 세션 폴더도 정리(최근 30개 보존, maxAgeDays 경과분)
  const sessionCleanup = cleanupSessions(dryRun, maxAgeMs, 30);

  console.log(JSON.stringify({
    dryRun,
    execute,
    executeRequested,
    humanApproved,
    blockedReason,
    maxAgeDays,
    scannedDirs: dirs,
    candidates: found.length,
    deleteCandidates: toDelete.length,
    deleted,
    freedKB: Math.round(freed / 1024),
    keptLatestBackup: keepBak ? path.basename(keepBak) : null,
    sessions: sessionCleanup,
  }, null, 2));
  if (blockedReason) process.exit(2);
}

main();
