# CLI Health Runbook

Run:

```powershell
npm run agent:health
```

The command checks:

- `codex --version`
- `claude --version`, with WSL fallback
- `gemini --version`, with `GEMINI_API_KEY` removed for the child process so Google login/session behavior is tested
- Antigravity CLI at `%LOCALAPPDATA%\agy\bin\agy.exe`
- `hermes --version`, with WSL fallback

Results are written to:

```text
%APPDATA%\Code\User\globalStorage\connectailab.connect-ai-lab\phase3\worker-health.json
```

Statuses:

- `READY`: CLI is installed and responds.
- `AUTH_EXPIRED`: sign-in or consent is needed.
- `CLI_MISSING`: executable is unavailable.
- `RATE_LIMITED`: quota or rate limit detected.
- `TIMEOUT`: command did not return in time.
- `BROKEN_OUTPUT`: command returned but output did not match the expected shape.
- `UNKNOWN`: non-zero result without a more specific classification.

If a worker is not `READY`, do not dispatch new long-running work to that CLI until the user renews the session or fixes installation.
