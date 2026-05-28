# P0 Job Search Green Task: Weekly Status Report

Role: Claude Opus, read-only secretary/coordinator.

Goal: Produce a weekly operational status summary for the job_search pipeline.

Scope:
- Work inside `C:\Users\mjb58\job_search`.
- Read `AGENTS.md`, `README.md`, `RUNBOOK.md`, and relevant docs under `docs/`.
- Inspect current artifacts and logs if present.

Hard boundaries:
- Do not edit `.harness/`, `.agents/`, credentials, CRM state, backups, Google Sheets, Gmail, or generated application documents.
- Do not run send/sync/application actions.
- Do not claim scheduled automation is healthy unless verified from files/commands in this run.

Expected output:
- Pipeline status: collect, score, CRM, generate, follow-up.
- Freshness/staleness of main artifacts.
- Manual queue or blocked-source notes if visible.
- Next 3 safe actions, separated into Codex/Claude/user if applicable.
- Files inspected and commands run.

Verification:
- Read-only checks only.
- Report uncertainty clearly.
