# Antigravity CLI Setup

Status on this PC:

- Binary: `C:\Users\mjb58\AppData\Local\agy\bin\agy.exe`
- Version verified: `1.0.2`
- User PATH registry was updated by the installer. New terminals should resolve `agy`.
- Current terminal can use: `$env:PATH = "$env:LOCALAPPDATA\agy\bin;$env:PATH"`

## Safe Connect AI Usage

Use the wrapper instead of calling `agy` directly:

```powershell
node scripts\antigravity-reviewer.js --prompt "Reply only with OK"
```

Direct-only quota/auth probe after a quota reset:

```powershell
node scripts\antigravity-reviewer.js --prompt "Reply only with OK" --no-fallback --force-agy --timeout 45s
```

The wrapper:

- Removes `GEMINI_API_KEY` only for the child `agy` process, so the saved API key remains untouched.
- Uses the logged-in Google/Code Assist session.
- Fails if no model response is recoverable.
- Recovers responses from Antigravity transcript logs when `agy --print` returns empty stdout.
- Uses Gemini fallback by default, but `--no-fallback` / `--direct-only` disables fallback so Antigravity direct evidence is not confused with fallback evidence.
- Redacts common token/API-key patterns.

## Queue Workers

Connect AI now recognizes two Google-side assignees:

- `antigravity`: runs through `scripts/google-reviewer-worker.js`, which calls `scripts/antigravity-reviewer.js`.
- `gemini`: runs through `scripts/gemini-worker.js`, which calls `scripts/gemini-executor.js` and requires a supported Gemini model ID.

Both are read-only workers. They are allowed to inspect and summarize read-only tasks, but they must not edit files or approve anything. Gemini worker output stops at `READY_FOR_VERIFICATION`; it does not mark queue items `DONE`.

Useful commands:

```powershell
npm run agent:antigravity-worker
npm run agent:gemini
npm run agent:run -- --execute --only antigravity --max 1
npm run agent:run -- --execute --only gemini --max 1
```

The Gemini executor removes `GEMINI_API_KEY` only for the child process and uses explicit `--model` routing. Supported model IDs are documented in `docs/agent-os/executor-contracts/gemini-executor.md`.

## Hermes Boundary

Hermes may call this wrapper only as a read-only reviewer. Hermes must not use Antigravity to:

- Claim user approval.
- Close approval gates.
- Modify stock harness/baseline/protected paths.
- Use broker/live/order/token/balance paths.
- Run `--dangerously-skip-permissions`.

## Known Local Fix

`C:\Users\mjb58\.gemini\config\mcp_config.json` must be valid JSON. A zero-byte file causes Antigravity startup log errors. The safe empty value is:

```json
{}
```
