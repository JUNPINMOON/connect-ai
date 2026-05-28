# Connect AI Control Plane Handoff - 2026-05-27

## What Changed

- Added central agent policy: Codex/Claude are executors, Gemini/Antigravity are reviewers, Hermes is observer.
- Added Green/Yellow/Red risk classification with fail-closed default to Yellow.
- Added human-approval guard for Red work and fabricated approval claims.
- Added CLI health writer for worker session/install state.
- Added result validator for done/blocked queue outputs.
- Added parallel queue dry-run/execute selector with role, risk, assignee, and write-scope checks.
- Added Team Room dashboard surface for worker status/health.
- Connected Hermes integration to the central risk policy and blocked Red-risk Hermes execution before routing.
- Added operating runbooks under `docs/`.

## Review Feedback Applied

Antigravity found:

- risk classification failed open to Green,
- broad write tasks without write scope could run in parallel,
- validation was partly reactive.

Applied fixes:

- unknown tasks now default to Yellow unless clearly read-only,
- broad write tasks conflict with other write work,
- Red risk is blocked at queue update and Hermes routing boundaries.

Gemini found:

- Hermes integration had separate action/risk classification that could drift from queue policy.

Applied fix:

- `src/hermes-integration.js` now imports the central policy and refuses Red-risk execution.

## Verification

Passed:

- `node --test scripts\agent-policy.test.js scripts\agent-queue.test.js scripts\cli-health-check.test.js scripts\result-validator.test.js scripts\run-queue-parallel.test.js scripts\google-reviewer-worker.test.js scripts\antigravity-reviewer.test.js scripts\claude-worker.test.js`
- `node --test scripts\hermes-integration.test.js scripts\agent-policy.test.js scripts\agent-queue.test.js scripts\run-queue-parallel.test.js scripts\result-validator.test.js scripts\cli-health-check.test.js`
- `npm run compile`
- `npm run smoke:local`
- `npm run agent:health`
- `npm run agent:run:parallel`
- `npm run agent:validate -- --recent-hours 0.25`

Known notes:

- `npm run agent:validate -- --recent-hours 3` still flags historical Hermes/approval-era done tasks. That is expected evidence of the old failure mode, not a new failure from this patch.
- Gemini Pro capacity returned 429 during review, then Gemini CLI fell back to Flash and produced a valid review.
- No real stock/job queued work was executed while the user was asleep; the system dry-run shows it can select safe parallel work, but protected-project work should still be started deliberately.

## Next Morning Action

Open the dashboard and check Team Room. Then run:

```powershell
npm run agent:health
npm run agent:run:parallel
```

If the selected tasks look correct, execute a small wave:

```powershell
npm run agent:run:parallel -- --execute --max-workers 2
```

After the wave:

```powershell
npm run agent:validate -- --recent-hours 8
```
