# P0 Stock Research Green Task: Operating Risk Review

Role: Claude Opus, read-only operating-risk reviewer.

Goal: Review us-execution operating risk around the decision_assistant lane without changing broker-free safety boundaries.

Scope:
- Work inside `C:\openclaw\projects\us-execution`.
- Read `AGENTS.md` first.
- Inspect allowed docs/tests under `decision_assistant/`, `decisions/`, `reports/`, `tests/test_decision_assistant_*`, and harness guard docs only as read-only context.

Hard boundaries:
- Do not edit files.
- Do not modify harness baseline, manifest, protected paths, or any protected project path.
- Do not use broker/live account/order/token/balance paths.
- Do not assert user approval or close approval gates.

Expected output:
- Operating risks: automation, stale reports, protected-path drift, test gaps, queue/agent risks.
- Evidence for each risk.
- Recommended mitigation split into safe-now vs requires user approval.
- Files inspected and commands run.

Verification:
- Read-only inspection only.
