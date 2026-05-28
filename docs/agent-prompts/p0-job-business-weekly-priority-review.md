# P0 Job Search Green Task: Weekly Priority Review

Role: Claude Opus, read-only business reviewer.

Goal: Review the job_search scored outputs and produce a weekly application-priority summary. This is analysis only, not application submission.

Scope:
- Work inside `C:\Users\mjb58\job_search`.
- Read `AGENTS.md`, `README.md`, and `career_profile.yaml` or `profile.md` if needed.
- Inspect `scored_jobs.json`, `excluded_jobs.json`, `jobs.json`, and existing recommendation/report artifacts if present.

Hard boundaries:
- Do not edit protected paths: `.harness/`, `.agents/`.
- Do not touch credentials, CRM state, backups, Google Sheets, Gmail, or external accounts.
- Do not generate final resume/cover-letter/application documents.
- Do not apply to jobs.

Expected output:
- Top priority roles or "no reliable priority list" with evidence.
- Why each priority fits or does not fit the user's target lane.
- Any source/scoring concerns that reduce confidence.
- Suggested next safe command or Codex task.
- Files inspected and commands run.

Verification:
- Read-only artifact inspection only.
- If score fields differ from expectation, describe observed schema instead of forcing assumptions.
