# Connect AI Agent Contracts

These contracts are the operating boundary for the laptop agent pyramid. The machine-readable source is `config/agent-contracts.json`; this file explains how to use it.

## Contract Rule

Every queued or delegated task must map to one contract before a worker starts.

The contract must define:

- role and assignee
- maximum risk class
- write authority
- allowed write scope
- forbidden paths
- required input fields
- required output fields
- evidence requirements
- expected tests
- token and retry budget
- stop conditions
- human approval conditions
- DONE rule

## Pyramid Mapping

| Contract | Worker | Purpose | Write Authority |
| --- | --- | --- | --- |
| `codex-implementer` | Codex | implementation, integration, tests | repo assigned files and runtime output only |
| `claude-implementer` | Claude | docs/contracts and bounded implementation | repo assigned files and runtime output only |
| `gemini-verifier` | Gemini | independent verification | read-only except runtime review output |
| `antigravity-architecture-reviewer` | Antigravity | architecture critique | read-only except runtime review output |
| `hermes-observer` | Hermes | observation and low-cost coordination | read-only except runtime observer output |
| `hermes-orchestrator` | Hermes | guarded dispatch/queue only (no approval, no writes) | runtime orchestration output only |
| `local-llm-smoke` | local LLM | cheap short classification | read-only except runtime smoke output |
| `vault-writer` | vault writer | single durable Obsidian write path | allowed vault folders only, policy-checked |
| `browser-smoke` | Browser or Chrome | UI/runtime smoke evidence | read-only except runtime smoke output |
| `coderabbit-review-gate` | CodeRabbit | external diff review gate | read-only except runtime review output |

## Status Discipline

Executor tasks that touch files may only report `READY_FOR_VERIFICATION`.

`DONE` requires all of these:

1. Files changed are listed.
2. Commands run in the current execution are listed.
3. Required tests passed in the current execution.
4. Unresolved failures are recorded, or explicitly stated as none.
5. Generated artifacts are classified.
6. A separate verifier accepted the evidence and the queue item is marked with `--verified`.

## Validation

Run:

```powershell
npm run validate:agent-contracts
```

The validator fails if a contract can approve human gates, close DONE without a verifier, write directly to the vault outside `vault-writer`, or omit required contract fields.
