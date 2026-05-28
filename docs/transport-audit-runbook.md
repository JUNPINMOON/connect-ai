# Connect AI Transport Audit Runbook

Use this when Connect AI appears to route a chat prompt incorrectly, claims work
is complete without evidence, uses a local LLM unexpectedly, or VS Code/Cursor
seems to run an old extension bundle.

## First Command

```powershell
npm run agent:transport-audit
```

This is read-only. It does not enqueue tasks, claim tasks, run workers, promote
verified claims, or write session files.

## What It Checks

- Queue file path and status counts.
- Queue lock age.
- Worker status and worker health files.
- `plannerProvider` default is `antigravity`.
- `localLlmEnabled` default is `false`.
- `run-queue.js` dry-run works without queue mutation.
- VS Code and Cursor installed `out/extension.js` bundles match the repo bundle.

## Expected Healthy Result

- `findings: none`
- `planner default: antigravity`
- `local LLM default: false`
- `run dry-run: exit 0, mutatesQueue=false`
- Both installed extension bundles say `matches source=true`

## If It Fails

- `INSTALLED_BUNDLE_STALE`: run `npm run compile`, then copy `out/extension.js`
  and `package.json` to the installed VS Code/Cursor extension folders.
- `LOCAL_LLM_DEFAULT_ENABLED`: set `connectAiLab.localLlmEnabled` default to
  `false` and reload VS Code/Cursor.
- `PLANNER_NOT_ANTIGRAVITY`: set `connectAiLab.plannerProvider` default to
  `antigravity`.
- `STALE_QUEUE_LOCK`: inspect the lock owner before removing it. Do not delete
  a fresh lock while a worker may be active.
- `RUN_QUEUE_DRY_RUN_FAILED`: fix `scripts/run-queue.js` or queue JSON parsing
  before running any worker.

## Read-Only Worker Handoff Test

Paste this in Connect AI after reloading the window:

```text
테스트용 Green worker 하달 점검만 해라.
목표: 이 채팅 명령이 실제 agent queue에 등록될 수 있는지, Codex/Claude executor 중 누가 선택되는지, 어떤 실행 경로를 타는지 보고해라.
금지: 파일 수정, 실제 worker 실행, 큐 상태 변경.
출력: 현재 큐 상태, 선택 executor, 예상 실행 명령, blocked 여부.
```

Healthy behavior starts with:

```text
Worker 하달 점검
```

It must not show `CEO · DISPATCH PROTOCOL`, `SESSION COMPLETE`, `_company`
session creation, `verified.md` promotion, or `decisions.md` learning.
