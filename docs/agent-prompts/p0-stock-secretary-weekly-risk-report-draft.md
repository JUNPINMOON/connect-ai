# P0 Stock Research Green Task: Weekly Risk Report Draft

Role: Claude Opus, read-only secretary/report drafter.

Goal: Draft a weekly risk-report summary from existing us-execution artifacts. Return the draft in the task result only; do not write files.

Scope:
- Work inside `C:\openclaw\projects\us-execution`.
- Read `AGENTS.md`.
- Inspect existing `decisions/`, `reports/`, `decision_assistant/`, and relevant tests to identify available evidence.

Hard boundaries:
- Do not edit files.
- Do not touch protected paths, harness baseline/manifest/protected paths, broker/live execution paths, credentials, tokens, balances, or orders.
- Do not make trade recommendations that imply execution. Keep it decision-support/risk framing only.
- Do not claim user approval.

Expected output:
- Korean weekly risk-report draft with: status, evidence, risks, unknowns, next safe checks.
- Separate "requires user approval" section for anything touching protected paths or trading boundaries.
- Files inspected and commands run.

Verification:
- Read-only inspection only.
