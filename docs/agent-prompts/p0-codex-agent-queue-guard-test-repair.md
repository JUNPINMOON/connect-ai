# P0 Codex Task: repair agent-queue guard tests only

Goal: make the existing Hermes hallucination guard in `scripts/agent-queue.js` compatible with the test suite.

Context:
- `node --check scripts/agent-queue.js` passes.
- `node --test scripts/agent-queue.test.js` currently fails in test `replan does not recursively escalate completed Hermes decision requests`.
- Failure reason: the new human-approval guard blocks marking a test Decision request as done unless `--human-approved` is supplied.
- This is a test/guard-contract mismatch, not permission to weaken the guard.

Allowed files:
- `scripts/agent-queue.test.js`
- `scripts/agent-queue.js` only if absolutely necessary to preserve guard behavior

Forbidden:
- Do not touch `C:\openclaw\projects\us-execution`.
- Do not touch broker/order/live-trading/token/credential files.
- Do not weaken the guard that blocks fabricated approval claims.
- Do not run Hermes.
- Do not add broad feature work.

Required behavior:
1. Decision request tasks that need human approval must still be blocked without `--human-approved`.
2. Test fixtures that intentionally close a Decision request may use `--human-approved` when the test is verifying non-recursive escalation rather than approval security.
3. Add or adjust tests so fabricated approval text without `--human-approved` is blocked.
4. Add or adjust tests so a non-approval ordinary task can still be marked done.

Verification commands:
```powershell
node --check scripts\agent-queue.js
node --test scripts\agent-queue.test.js
```

Report:
- Files changed
- Exact tests run and pass/fail counts
- Whether guard behavior was weakened (must be no)
- Residual risks
