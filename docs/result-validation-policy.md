# Result Validation Policy

Run:

```powershell
npm run agent:validate
```

For recent work only:

```powershell
npm run agent:validate -- --recent-hours 3
```

The validator inspects completed or blocked queue items and flags:

- `DONE_WITHOUT_RESULT_SUMMARY`
- `NON_FINAL_PLANNING_OUTPUT`
- `APPROVAL_CLAIM_WITHOUT_HUMAN_FLAG`
- `RED_DONE_WITHOUT_HUMAN_APPROVAL`
- `WRITE_CLAIM_WITHOUT_VERIFICATION`

This is a second line of defense after `agent-queue.js` guards. It is intended to catch workers that claimed completion with planning-only text, invented approval, or reported edits without verification evidence.
