# nightly-maintenance.ps1 — Connect AI 야간 정리 후보 리포트
# Windows Task Scheduler가 매일 새벽 실행하더라도 기본은 read-only dry-run이다.
$ErrorActionPreference = "Continue"
$repo = "C:\Users\mjb58\antigravity-projects\connect-ai"
$logDir = "$env:USERPROFILE\.connect-ai-logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir "nightly-maintenance.log"
$ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"

Set-Location $repo
"[$ts] nightly-maintenance 시작" | Add-Content $log

# node 경로 (PATH에 없을 수 있으니 탐색)
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = "C:\Program Files\nodejs\node.exe" }

if (Test-Path $node) {
    $out = & $node "scripts\maintenance.js" --days 7 --dry-run 2>&1 | Out-String
    "[$ts] $out" | Add-Content $log
    "[$ts] exit=$LASTEXITCODE" | Add-Content $log
} else {
    "[$ts] ERROR: node 못 찾음" | Add-Content $log
}

# 로그 자체도 비대해지지 않게: 1000줄 넘으면 최근 500줄만 유지
$lines = @(Get-Content $log -ErrorAction SilentlyContinue)
if ($lines.Count -gt 1000) {
    $lines | Select-Object -Last 500 | Set-Content $log
}
