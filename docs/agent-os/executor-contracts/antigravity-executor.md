# Antigravity Executor Contract

## Role

Antigravity is a high-context executor endpoint for S4/S5 dispatch experiments. In this repo, Codex only dispatches bounded queue items to Antigravity; it does not implement Antigravity IDE routing internals.

## Allowed write scope

- Paths listed in `writeScope`.
- Runtime evidence under `C:\Users\mjb58\connect-ai-runtime\company`.
- For design/review routing, prefer no repo writes and return critique/evidence.

## Forbidden paths

- `C:\Users\mjb58\connect-ai-vault` direct writes.
- `transport-audit`, `swarm-status`, `readiness`, dashboard/audit feature work unless the queue item explicitly says it is a narrow content-accuracy fix.
- Credentials, tokens, broker/order paths, deploy settings, external sends, destructive cleanup, and human approval gates.

## Required input

- queue item id, goal, risk, writeScope, expectedTests, rollbackPath, token budget, retry budget, requested model label, fallback policy, executor, reviewer.

## Output

Return `READY_FOR_VERIFICATION`, never `DONE`.

Include files changed or no-write confirmation, model/source evidence, commands run, unresolved failures, generated artifacts, and rollback notes.

## Budgets

Retry budget is 1 unless Pin approves more. Do not promise Sonnet, Opus, or Gemini Pro through the `agy` CLI; model selection is inherited from the current Antigravity IDE/account state.

## Known Model Selection Limitation

The `agy` CLI has no `--model` flag. `--model-label` can be passed as a string but is ignored by the CLI; model selection is inherited from the Antigravity IDE/account current selection, not from the executor request payload. Last observed direct CLI model: `Gemini 3.5 Flash (Medium)`.

### Field requirements

Every Antigravity executor result MUST include both:

- `requestedModelLabel`
- `observedModelLabel`

If `observedModelLabel` is missing, the result MUST be `BLOCKED` with reason `MISSING_OBSERVED_MODEL`.

If `requestedModelLabel` is set and differs from `observedModelLabel`, the result MUST be `BLOCKED` with reason `MODEL_MISMATCH`, not `READY_FOR_VERIFICATION`.

### Evidence source

`observedModelLabel` must come from the actual Antigravity CLI transcript log, not from the request payload. Expected evidence path pattern:

```text
C:\Users\mjb58\.gemini\antigravity-cli\log\cli-YYYYMMDD_HHMMSS.log
```

### Routing implication

Do NOT treat `antigravity` as a multi-model executor in the router. Treat it as a single-model executor whose model is whatever the IDE currently exposes. The router must not silently promise Claude Opus/Sonnet or Gemini Pro through `agy` unless transcript evidence proves the observed model matches the requested label.

## Stop conditions

Stop if the model label mismatches, direct evidence is unavailable and fallback is disabled, write scope is ambiguous, or the task needs credentials or human approval.

## Approval condition

Antigravity cannot close its own work as `DONE`. A separate verifier must accept current-run evidence.
