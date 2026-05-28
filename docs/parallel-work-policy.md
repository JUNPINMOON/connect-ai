# Parallel Work Policy

Parallel execution is allowed for independent Green/Yellow tasks.

Use dry-run first:

```powershell
npm run agent:run:parallel
```

Execute with a small pool:

```powershell
npm run agent:run:parallel -- --execute --max-workers 2
```

Default pool size is 2. Maximum is capped at 4.

Selection rules:

- One task per assignee per wave.
- Red tasks are excluded.
- Human-approval tasks are excluded.
- Reviewer workers only receive read-only review/audit tasks.
- Tasks with overlapping write scopes are not selected together.

Recommended overnight mode:

- Run `npm run agent:health`.
- Run `npm run agent:run:parallel` and inspect selected tasks.
- Execute only if selected workers are `READY` and tasks are non-Red.
- Run `npm run agent:validate -- --recent-hours 8` after the wave.
