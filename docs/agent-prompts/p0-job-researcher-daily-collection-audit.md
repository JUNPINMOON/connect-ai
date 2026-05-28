# P0 Job Search Green Task: Daily Collection Audit

Role: Claude Opus, read-only analyst.

Goal: Review the current job_search collection outputs and produce a concise Connect AI result summary for "공고 데이터 수집 및 분석".

Scope:
- Work inside `C:\Users\mjb58\job_search`.
- Read repo rules first: `AGENTS.md`, then `README.md`.
- Inspect only current collection/scoring artifacts if present: `jobs.json`, `scored_jobs.json`, `excluded_jobs.json`, `source_health.json`, `logs/`, and relevant diagnostics docs.

Hard boundaries:
- Do not edit `.harness/`, `.agents/`, credentials, CRM state, backups, or Google/Gmail/Sheets.
- Do not run `crm.py`, `generator.py`, `followup.py`, or any external-send action.
- Do not submit applications or draft personal application content.
- If artifacts are missing/stale, report that as a finding instead of fabricating data.

Expected output:
- Current artifact freshness and source health.
- New/available job count if measurable.
- Score distribution if `scored_jobs.json` exists.
- Top collection risks and next recommended command.
- Files inspected and commands run.

Verification:
- Use read-only commands only.
- Prefer Python/PowerShell JSON inspection over manual guessing.
