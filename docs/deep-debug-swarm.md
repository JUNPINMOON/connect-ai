# Connect AI Deep Debug Swarm

Purpose: run a read-only multi-agent review over Connect AI transport, queue, CLI health, vault/memory, UI/runtime, and policy gates.

## Operating Model

- Gemini lanes: 6 read-only reviewer agents.
- Antigravity lanes: 6 read-only reviewer agents.
- Gemini lanes use explicit `--model` flags and record requested/observed model evidence.
- Antigravity lanes currently use the globally selected Antigravity model because `agy.exe 1.0.3` does not expose a per-run `--model` flag. The runner records the observed global model from CLI logs.
- Antigravity direct evidence is counted only when the source is direct `agy`, stdout, or transcript. Gemini fallback evidence is marked as fallback and does not count as Antigravity direct coverage.
- Reports are written under `reports/deep-debug-swarm/<timestamp>/`.
- The swarm must not enqueue tasks, claim workers, edit files, write to the vault, authenticate, approve, deploy, or send external messages.

## Commands

Dry-run lane list:

```powershell
npm run agent:deep-debug -- --dry-run
```

Gemini-only smoke:

```powershell
npm run agent:deep-debug -- --provider gemini --context-lite
```

Antigravity-only direct smoke with bounded `agy` wait and fallback disabled:

```powershell
npm run agent:deep-debug -- --provider antigravity --context-lite --no-fallback --force-agy --timeout-ms 300000 --antigravity-print-timeout 90s
```

Full 12-lane direct review:

```powershell
npm run agent:deep-debug -- --context-lite --no-fallback --force-agy --timeout-ms 300000 --antigravity-print-timeout 90s
```

Synthesize a completed swarm run into prioritized repair slices:

```powershell
node scripts/deep-debug-swarm-synthesis.js --reports reports\deep-debug-swarm\<timestamp> --out-dir reports\deep-debug-swarm\<timestamp>\synthesis
```

Dispatch reviewer tasks for executor work waiting at `ready_for_verification`:

```powershell
npm run agent:verify-dispatch
```

Actually enqueue reviewer tasks:

```powershell
npm run agent:verify-dispatch -- --execute
```

Apply verifier decisions back to source tasks after the reviewer records `검증 판정: accept|reject|needs_human`:

```powershell
npm run agent:verify-dispatch -- --apply --execute
```

Read-only blocked queue triage:

```powershell
npm run agent:blocked-triage
```

Dry-run blocked retry planner:

```powershell
npm run agent:blocked-retry
```

Execute only safe Green/read-only blocked retries after CLI health is READY:

```powershell
npm run agent:blocked-retry -- --execute
```

Run Claude queue work with an explicit turn budget:

```powershell
npm run agent:run -- --execute --only claude --max 1 --claude-timeout-ms 600000 --claude-max-turns 20
```

Verify the sidebar chat routing contract without mutating the queue:

```powershell
npm run agent:webview-smoke
```

Verify the real Antigravity/Gemini planner CLI can return parseable planner JSON:

```powershell
npm run agent:planner-smoke
```

Run transport audit plus the slower live planner CLI smoke:

```powershell
npm run agent:transport-audit -- --planner-smoke
```

Summarize the latest deep-debug swarm report coverage without starting agents:

```powershell
npm run agent:swarm-status
```

## Current Verified Status

- `node --test scripts/deep-debug-swarm.test.js scripts/antigravity-reviewer.test.js scripts/gemini-executor.test.js` passed: 36/36.
- `node --test scripts/deep-debug-swarm-synthesis.test.js` passed: 3/3.
- Historical Gemini CLI probe evidence observed `gemini-3.1-pro-preview` in a swarm run, but the current executable allowlist in `scripts/gemini-executor.js` is limited to `gemini-2.5-flash` and `gemini-2.5-pro`. Do not dispatch 3.x preview IDs until the executor contract, MCP schema, dispatcher, and tests are updated together.
- Gemini 6-lane run passed: `reports/deep-debug-swarm/20260528T035815Z/`.
- Antigravity 6-lane direct run passed with `--no-fallback --force-agy`: `reports/deep-debug-swarm/20260528T040318Z/`.
- Full 12-lane direct run passed with `--no-fallback --force-agy`: `reports/deep-debug-swarm/20260528T041047Z/`.
- Synthesis of the full run produced 7 prioritized repair items: `reports/deep-debug-swarm/20260528T041047Z/synthesis/`.
- Confirmed model diversity in the full run: `gemini-3.1-pro-preview`, `gemini-2.5-pro`, `gemini-2.5-flash`, and `Gemini 3.5 Flash (Medium)`.
- Antigravity direct source is currently transcript-based and all 6 Antigravity lanes observed `Gemini 3.5 Flash (Medium)`.
- Safe read-only retry execution closed the three retryable Claude Green tasks:
  - `aq-20260526155227-6ea6ad` — job-search weekly status report.
  - `aq-20260526155227-a220d2` — stock market/risk data analysis.
  - `aq-20260526155227-c24d2d` — stock operating-risk review.
  - `aq-20260526155228-898d5c` — stock weekly risk-report draft.

## Findings Already Integrated

- Long prompts are passed to `antigravity-reviewer.js` by temporary prompt file, not a huge command-line argument.
- `antigravity-reviewer.js` retries Gemini fallback and can mark fallback output as success.
- Antigravity transcript extraction now prefers substantive model content over short trailing model events.
- CEO planner parsing now scans all balanced JSON objects and chooses the object containing `tasks`.
- Truncated planner recovery now handles both `agent` before `task` and `task` before `agent` object snippets.
- `classifyToAgent()` now routes by deterministic keywords first and does not call the local LLM when `connectAiLab.localLlmEnabled=false`.
- `transport-audit` now flags an unguarded local-LLM classifier path as `CLASSIFIER_LOCAL_LLM_UNGUARDED`.
- `transport-audit` now inspects VS Code/Cursor user settings for `plannerProvider` and `localLlmEnabled` overrides, not only package defaults.
- `cli-health-check` no longer uses Node `shell:true` for Windows shim commands, removing the `DEP0190` warning from routine health checks.
- `webview-roundtrip-smoke` verifies the visible sidebar contract: chat textarea, `corporate:true` prompt posting, planner chip, prompt handler corporate routing, Antigravity fallback when local LLM is disabled, and fast read-only diagnostics.
- `transport-audit` now includes the webview roundtrip smoke summary so one audit catches both transport and visible sidebar routing drift.
- `planner-cli-smoke` verifies that the Antigravity/Gemini CLI planner path returns parseable `{brief,tasks}` JSON for a read-only command. Current live smoke succeeded through `gemini-fallback`, which means the fallback safety net works while direct Antigravity stdout remains unreliable.
- `swarm-status` summarizes report coverage across the expected 6 Gemini + 6 Antigravity lanes without starting new agents. It treats Gemini fallback on Antigravity prompts as fallback evidence, not as completed Antigravity direct coverage.
- `cli-health-check` and `transport-audit -- --planner-smoke` now distinguish “Antigravity CLI is installed” from “direct `agy --print` can answer.” If direct Antigravity hits quota, health reports `RATE_LIMITED` and the planner smoke reports `source=gemini-fallback, direct=RATE_LIMITED`.
- The sidebar planner chip now distinguishes `Planner: Antigravity`, `Planner: Gemini fallback`, and local planner mode. The dashboard Team Room treats `RATE_LIMITED`/quota states as blocked/limited instead of normal idle.
- `ready_for_verification` now has a dry-run-first dispatcher that creates read-only Gemini/Antigravity verification tasks only when `--execute` is explicit, plus an `--apply` gate that closes source tasks only after explicit verifier verdict evidence.
- Blocked queue now has a read-only triage report that separates superseded work, transient CLI failures, and human-gated items.

## Latest Report Paths

- Gemini 6-lane pass: `reports/deep-debug-swarm/20260528T035815Z/`
- Antigravity 6-lane direct pass: `reports/deep-debug-swarm/20260528T040318Z/`
- Full 12-lane direct pass: `reports/deep-debug-swarm/20260528T041047Z/`
- Full 12-lane synthesis: `reports/deep-debug-swarm/20260528T041047Z/synthesis/`

## Current Blocked Queue Triage

Latest read-only triage reported:

- `superseded_or_duplicate`: 5
- `needs_human`: 2
- `retry_after_health_check`: 0

Safe handling:

- Do not auto-retry `needs_human`.
- Retry `retry_after_health_check` only after current CLI health is READY and the task is still Green/read-only.
- Do not mark `superseded_or_duplicate` done without evidence and separate verification.
- Remaining blocked items should stay blocked until the user explicitly decides whether to archive/close superseded broad tasks and how to handle Hermes autonomy/approval-test decisions.

## Remaining Risks

- Full 12-lane execution is slow and consumes Gemini/Antigravity quota.
- Antigravity CLI has no verified per-lane model flag, so Antigravity lane diversity is persona/domain based, not per-lane model based.
- Source-control integrity is the top current risk: the latest inventory found 318 dirty/untracked entries, including 207 track candidates and 83 archive/runtime candidates.
- Queue still has a blocked backlog and must not be auto-closed without verifier evidence or human approval.
- `ready_for_verification` dispatch/apply must remain verifier-gated; executor output alone is not DONE.
- Generated reports are reviewer evidence only. Codex must verify any proposed fix against source, tests, and runtime audits.
