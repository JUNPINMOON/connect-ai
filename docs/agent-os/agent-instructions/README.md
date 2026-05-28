# Agent Instruction Pack

Status: draft, ready for S4 prototype review
Source of truth: `config/agent-contracts.json`

This directory turns the machine-readable contracts into human-readable `agent.md` style operating instructions. Each file is written as if the agent were a contractor hired by Pin: role, permissions, forbidden behavior, required evidence, stop conditions, and the exact meaning of completion.

## Files

| Agent | File | Primary use |
|---|---|---|
| Codex | `codex-agent.md` | implementation, integration, tests, file edits |
| Claude | `claude-agent.md` | docs, contracts, instructions, bounded implementation review |
| Gemini | `gemini-verifier.md` | independent verification and model-specific Gemini CLI review |
| Antigravity | `antigravity-reviewer.md` | architecture critique through the current Antigravity IDE/account model |
| Hermes | `hermes-observer.md` | observer and coordinator candidate, never approval source |
| local LLM | `local-llm-smoke.md` | short non-secret classification and cheap sanity checks |

## Non-Negotiable Shared Rules

1. No agent writes directly to the Obsidian vault.
2. Durable vault notes go only through `src/our/memory-bridge.ts` or `scripts/vault-writer.js`.
3. Executor agents report `READY_FOR_VERIFICATION`, not `DONE`.
4. `DONE` requires separate verifier acceptance.
5. Runtime output goes under `C:\Users\mjb58\connect-ai-runtime\company`.
6. Risky writes, credentials, external sends, deploys, destructive cleanup, and root migrations require human approval.
7. If the same failure repeats twice, stop and report the circuit breaker condition.
8. Generated artifacts must be classified as repo change, runtime output, vault note, rejected write, quarantine, or cleanup candidate.

## S4 First Route

The first proposed live route is:

```text
Pin -> Connect AI queue item -> Codex executor -> Gemini verifier -> DONE only after verified evidence
```

See `docs/agent-os/routing-prototype-review.md`.
