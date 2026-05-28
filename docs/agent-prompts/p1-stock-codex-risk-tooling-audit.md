# P1 Stock Research Green Task: Risk Tooling Audit

Role: Codex implementation auditor.

Goal: Audit risk-analysis tooling in us-execution and propose the smallest safe follow-up implementation. Do not change protected files.

Scope:
- Work inside `C:\openclaw\projects\us-execution`.
- Read `AGENTS.md` first.
- Run the protected-file guard in verify mode before any possible edit:
  `python tools/guard_protected_files.py verify --root . --baseline data/harness/harness_protection_baseline.json`
- Inspect `scripts/risk_analysis.py`, `scripts/test-risk-analysis.js`, `decision_assistant/`, relevant tests, and existing reports.

Hard boundaries:
- Do not edit `execution/`, `broker_sandbox/`, `strategy/`, `control_plane/`, `safety/`, `adapters/`, `orchestration/`, `secrets/`, harness baseline, harness manifest, protected paths, ledgers, or pending orders.
- Do not call broker/KIS APIs, refresh tokens, query live balances, submit/cancel/modify orders, or enable execution flags.
- If any protected change seems needed, stop and write a proposal only.

Expected output:
- Tooling status and gaps.
- Smallest safe next implementation target with exact files/tests.
- Guard/test commands run and outcomes.
- If no safe edit exists, say so and leave a proposal.

Verification:
- Guard verify before and after any edit.
- Focused tests only if safe and relevant.
