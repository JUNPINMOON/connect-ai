# P1 Connect AI Task: Model Router Contract Audit

Role: Codex implementation auditor.

Goal: Replace the broad "모델 라우팅 자동화 구현" task with a small design-and-contract slice. Do not implement a full router yet.

Scope:
- Work inside `C:\Users\mjb58\antigravity-projects\connect-ai`.
- Inspect `mcp/server.js`, `model-policy.md` in the vault if present, `package.json`, and existing tests/scripts related to routing.

Hard boundaries:
- Do not enable Hermes autonomous execution.
- Do not create scheduler/system service changes.
- Do not route high-risk stock or credential tasks to cloud models.
- Do not touch external accounts, secrets, broker/live paths, or protected project harnesses.

Expected output:
- Current router/policy state with file evidence.
- Minimal router contract: input fields, risk labels, model targets, timeout/caching behavior.
- Exact next implementation slice and test file name.
- Residual risks, especially high-risk local-only routing.

Verification:
- Read-only audit is acceptable.
- If a tiny test scaffold is added, run `node --test` for that file and `node --check` for changed JS.
