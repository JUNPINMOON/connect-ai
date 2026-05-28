# P0 Stock Research Green Task: Market Risk Data Audit

Role: Claude Opus, read-only risk analyst.

Goal: Review the broker-free us-execution decision-support project for current market/risk data analysis status and produce a concise Connect AI summary.

Scope:
- Work inside `C:\openclaw\projects\us-execution`.
- Read `AGENTS.md` first.
- Inspect allowed decision-support files only, such as `decision_assistant/`, `decisions/`, `reports/`, `scripts/risk_analysis.py`, `scripts/test-risk-analysis.js`, and relevant tests.

Hard boundaries:
- Do not modify any file.
- Do not touch `execution/`, `broker_sandbox/`, `strategy/`, `control_plane/`, `safety/`, `adapters/`, `orchestration/`, `secrets/`, ledgers, pending orders, harness baseline, harness manifest, or protected paths.
- Do not call broker/KIS APIs, refresh tokens, check live balances, submit/cancel/modify orders, or enable execution flags.
- Do not claim user approval.

Expected output:
- Current market/risk analysis artifacts found.
- Whether VaR/risk report tooling appears present and how to verify safely.
- Gaps or stale areas.
- Next safe Codex/Claude task.
- Files inspected and commands run.

Verification:
- Read-only commands only.
- If a guard command is run, it must be read-only verification.
