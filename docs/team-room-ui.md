# Team Room UI

The Team Room is a lightweight visual layer in the Connect AI dashboard.

It renders:

- queue `running` items,
- `worker-status.json`,
- `worker-health.json`.

Worker display:

- Codex: executor
- Claude: executor
- Gemini: reviewer
- Antigravity: reviewer
- Hermes: observer

States:

- `running`: current task active.
- `ready`: CLI health is ready and no active task is recorded.
- `blocked`: worker status is blocked or CLI health reports auth/install/timeout issues.
- `done`: last task completed.
- `idle`: no fresh status.

This is intentionally a status surface only. It does not grant approvals and does not bypass queue guards.
