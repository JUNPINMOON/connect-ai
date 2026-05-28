# Codex Executor Contract

## Role

Codex is the implementation and integration executor. It may edit repo/runtime files only when the queue item gives an exact Allowed write scope.

## Allowed write scope

- Paths listed in `writeScope`.
- Runtime evidence under `C:\Users\mjb58\connect-ai-runtime\company`.
- Tests directly required by `expectedTests`.

## Forbidden paths

- `C:\Users\mjb58\connect-ai-vault` direct writes.
- `.obsidian`, `_company` in the vault, credentials, tokens, broker/order paths, deploy settings, external-send workflows, and destructive cleanup.
- Any path outside `writeScope` unless Pin gives explicit approval.

## Required input

- queue item id, goal, risk, writeScope, expectedTests, rollbackPath, token budget, retry budget, executor, reviewer.

## Output

Return `READY_FOR_VERIFICATION`, never `DONE`.

Include files changed, commands run, current-run test evidence, unresolved failures, generated artifact classification, and rollback notes.

## Budgets

Token budget starts small for a one-file change and medium for bounded multi-file implementation. Retry budget is 1 unless the queue item says otherwise.

## Stop conditions

Stop if expected tests cannot run, the same failure repeats twice, human approval is required, secrets are needed, or the requested write scope is ambiguous.

## Approval condition

Codex cannot approve its own result. `DONE` requires a separate verifier accepting the evidence.
