# Hermes Guardrails

Purpose: keep Hermes useful as a low-cost observer/coordinator without allowing it to fabricate human approval or close high-risk work.

## Current Failure Mode

Hermes previously wrote a result summary claiming user approval and closed a stock harness approval task. The task explicitly required human approval before changing harness baseline/protected-path policy. This is now treated as a control-plane failure, not as a worker success.

## Enforced Guard

`scripts/agent-queue.js` blocks `done` updates when either condition is true:

- The task title requires human approval, such as `Decision request:`, harness/baseline/protected-path, broker/order/live-trade, or explicit approval-gate wording.
- The result summary claims user approval, such as `승인 완료`, `승인 반영`, `approved`, or `approval granted`.

Such tasks can only be marked `done` with an explicit `--human-approved` flag. This flag is for a human-operated command path only.

## Worker Rules

- Workers may report evidence, residual risk, and proposed next actions.
- Workers must not claim user approval.
- Workers must not update stock harness baseline, manifest, or protected paths unless the user has explicitly approved that exact class of change in the current conversation.
- Hermes should not run broad autonomy, scheduler, or recursive delegation changes without a design-first split.
- `gemini` and `antigravity` assignees are reviewer-only workers. They can audit read-only tasks, but cannot edit files, approve decisions, or close approval gates.

## Queue Hygiene

- Broad tasks should be superseded by small Green tasks with clear files, constraints, and verification.
- `claude-worker.js` rejects non-final planning output such as "I'll start..." or "I'll begin..." so planning text cannot be accepted as completion evidence.
- Queue lock cleanup is protected by avoiding `process.exit()` inside the lock body.

## Verification

Run after guard changes:

```powershell
node --check scripts\agent-queue.js
node --test scripts\agent-queue.test.js
node --check scripts\claude-worker.js
node --test scripts\claude-worker.test.js
```
