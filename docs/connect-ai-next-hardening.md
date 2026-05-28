# Connect AI Next Hardening Backlog

Current snapshot: 2026-05-28.

## Verified Now

- Connect Chat defaults away from local LLM: `connectAiLab.localLlmEnabled=false`.
- Planner provider default is `antigravity`.
- Antigravity direct `agy --print` is currently quota-limited, so planner smoke succeeds through Gemini fallback.
- Sidebar and dashboard now surface quota/fallback state instead of showing a misleading normal Antigravity state.
- UI runtime smoke now executes sidebar/dashboard webview JavaScript in jsdom:
  - Sidebar: `Planner: Gemini fallback` plus `fallback limited` classes when Antigravity direct is quota-limited.
  - Dashboard Team Room: Antigravity renders as `office-person blocked office-person-antigravity` and displays `quota 제한`/`RATE_LIMITED`.
- Deep-debug swarm has Gemini coverage plus Antigravity-prompt fallback evidence, but Antigravity direct coverage is incomplete while `agy --print` is quota-limited. Fallback output must not be counted as completed Antigravity direct work.
- Queue dry-run currently processes 0 items; remaining blocked items are not active queued work.
- Blocked backlog is now classified by read-only triage:
  - total blocked: 8
  - verified archive candidates: 5
  - retry candidates: 0
  - user decision required before closure/action: 7
  - failed synthetic probe evidence: 1
- Real Green E2E queue probe passed once through Codex:
  - Task: `aq-probe-20260527192048-34464`
  - Path: Connect AI chat-style queue add -> `run-queue --only codex --id <probe>` -> `codex-worker` -> `result-validator`
  - Validator: `invalidCount=0`
  - File edits: none inside the worker task; only the synthetic queue evidence task was added/updated.
- A failed earlier probe exposed two fixes that are now covered by tests:
  - Windows read-only Codex sandbox can block local read commands, so `codex-worker` uses the existing Windows sandbox bypass path while preserving the read-only task contract.
  - Codex final answers that start with `BLOCKED` or say evidence was not verified are now marked `blocked`, not `done`.

## Next Best Slices

1. **Live UI reload smoke**
   - Status: automated runtime smoke added; manual VS Code reload visual confirmation still recommended.
   - Reload VS Code.
   - Confirm sidebar planner chip shows `Planner: Gemini fallback` while Antigravity quota is limited.
   - Confirm Team Room marks Antigravity limited/blocked rather than normal ready.
   - Automated runtime smoke: `npm run agent:ui-runtime-smoke`

2. **Real Green End-To-End Queue Probe**
   - Status: passed once on 2026-05-28 KST.
   - Create one synthetic read-only Green task.
   - Let Codex executor process it once.
   - Require result-validator evidence.
   - Do not touch protected paths.
   - Dry-run command: `npm run agent:e2e-probe`
   - Real one-task probe: `npm run agent:e2e-probe -- --execute`

3. **Antigravity Quota Reset Recheck**
   - After quota reset, run `npm run agent:planner-smoke -- --print-timeout 45s`.
   - Expected improved state: `source=stdout` or `source=transcript`, `directStatus=READY`.
   - If still fallback, inspect latest `C:\Users\mjb58\.gemini\antigravity-cli\log\cli-*.log`.

4. **Dashboard Runtime Browser Smoke**
   - Use a browser/webview smoke where possible to verify rendered layout, not only static source contracts.
   - Check no overlap in sidebar header, planner chip, model dropdown, and Team Room cards.
   - Current automated coverage: jsdom runtime smoke verifies sidebar planner fallback class/text and dashboard Team Room quota-limited Antigravity state.

5. **Blocked Backlog Closure Policy**
   - Keep human-gated items blocked.
   - Archive or supersede duplicate broad tasks only with explicit evidence and a verifier pass.
   - Automated triage command: `npm run agent:blocked-triage -- --output json`
   - Dry-run closure plan: `npm run agent:blocked-closure`
   - Human-approved closure: `npm run agent:blocked-closure -- --execute --human-approved --id <task-id>` or `--all`
   - Current policy: no automatic closure. Superseded broad tasks are closure candidates only after evidence review and explicit user/verifier decision.
   - Failed synthetic probes stay blocked as evidence until a newer probe passes and is independently validated.

## Current Known Truth

Connect AI is usable for cautious commands, but not complete as the final Gemini + Antigravity multi-agent operating system. It is currently in a safer fallback mode: Gemini handles planner output while Antigravity direct quota is limited, and Antigravity lanes remain incomplete until direct `agy`/transcript/stdout evidence returns.

## Operator Readiness Command

- Quick readiness: `npm run agent:readiness`
- Readiness with live planner smoke: `npm run agent:readiness -- --planner-smoke`
- Machine-readable output: `npm run agent:readiness -- --planner-smoke --json`

This command is read-only. It summarizes transport audit, queue state, planner/local LLM defaults, blocked backlog triage, and current findings into:

- `READY`: no material finding and no active queue work.
- `LIMITED_READY`: Green Connect Chat work is usable, but a known limitation such as Antigravity quota fallback remains.
- `BUSY_BUT_USABLE`: Green work is possible, but queue has active work.
- `NEEDS_TRIAGE` / `NOT_READY`: fix P1/P0 findings before new worker dispatch.
