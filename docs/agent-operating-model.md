# Connect AI Agent Operating Model

## Roles

- `codex`: executor. Can implement, edit, test, and report within allowed Green/Yellow scopes.
- `claude`: executor. Same authority as Codex for Green/Yellow scopes.
- `gemini`: reviewer. Read-only review/audit work only.
- `antigravity`: reviewer. Read-only review/audit work only.
- `hermes`: observer. No autonomous approval or execution authority.

## Risk Classes

- `Green`: read-only, audit, review, summarization, status reporting.
- `Yellow`: bounded implementation, edits, tests, local docs, local tooling.
- `Red`: approval, harness/baseline/protected-path changes, broker/order/live-trade, credential, external send, deploy, purchase, destructive or irreversible state.

Unlabelled tasks fail closed to `Yellow` unless they clearly read as read-only review/audit work. Use an explicit `Green`, `Yellow`, or `Red` label in queue titles when dispatching known work.

Red tasks require explicit human approval and cannot be marked `done` by an LLM worker without the human approval flag.

## Dispatch

- Use `npm run agent:run` for a dry-run of the next queue item.
- Use `npm run agent:run -- --execute` for sequential execution.
- Use `npm run agent:run:parallel` for dry-run parallel selection.
- Use `npm run agent:run:parallel -- --execute --max-workers 2` for bounded parallel execution.

The parallel runner only selects queued tasks that:

- match the assignee role,
- are not Red,
- do not require human approval,
- do not collide on write scope,
- do not assign more than one task to the same worker in one wave.

If a task can write but has no explicit write scope, it is treated as broad and conflicts with other write work.

## Status

- `worker-status.json` records current task/phase per worker.
- `worker-health.json` records CLI availability/auth state per worker.
- The dashboard Team Room renders both files plus the queue so the user can see who is active, blocked, ready, or idle.

## Guardrail

Hermes can still be used for observation or smoke checks, but not as the autonomous driver. Hermes integration now reads the same central Green/Yellow/Red policy and refuses Red-risk execution before model routing. The queue code is the driver; Codex and Claude execute; Gemini and Antigravity review; the user approves Red work.
