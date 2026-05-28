# P1 Job Search Green Task: Pipeline Maintenance Audit

Role: Codex implementation auditor.

Goal: Audit the job_search pipeline maintenance surface and identify the smallest safe follow-up fix or test target. Prefer read-only audit unless a tiny non-protected fix is obviously safe.

Scope:
- Work inside `C:\Users\mjb58\job_search`.
- Read `AGENTS.md`, `README.md`, `RUNBOOK.md`, and current `git status --short`.
- Inspect key scripts: `scraper.py`, `scorer.py`, `crm.py`, `generator.py`, `followup.py`, `tools/diagnose_pipeline.py`, and relevant tests.

Hard boundaries:
- Do not edit `.harness/`, `.agents/`, credentials, CRM state, backups, or generated application outputs.
- Do not run Google/Gmail/Sheets sync or any external-send path.
- If editing, keep it to non-protected code/tests and run narrow verification.

Expected output:
- Maintenance risks ranked P0/P1/P2.
- The exact smallest next implementation task, with files and tests.
- Any checks run and outcomes.
- If code changed, list changed files and verification.

Verification:
- At minimum, read-only audit plus syntax/test command recommendation.
- If code changed, run the relevant narrow test or explain why it could not run.
