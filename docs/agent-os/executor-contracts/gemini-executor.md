# Gemini Executor Contract

## Role

Gemini is the direct Gemini CLI executor endpoint for model-specific dispatch.

Future adapter location: `scripts/gemini-executor.js` - owned by the Antigravity multi-agent session. Queue-runner bridge: `scripts/gemini-worker.js`.

## Acceptable Models

The future adapter MUST reject any model ID outside this confirmed allowlist:

- `gemini-2.5-flash`
- `gemini-2.5-pro`

This list is based on observed Gemini CLI stability after the Agent OS ceiling decision. Preview Gemini 3 aliases are not executable contract models because they can be quota-limited or model-routed to a different observed model. The adapter at `scripts/gemini-executor.js` must keep its executable allowlist aligned with this contract before Connect AI routes production queue items to Gemini CLI.

## Allowed Write Scope

Gemini may write only executor evidence under approved runtime/report evidence roots, such as `C:\Users\mjb58\connect-ai-runtime\company\s5-dispatch` or a repo-owned report path explicitly approved by the adapter.

It may not edit task target files directly. If a code change is needed, Gemini returns review or planning evidence and the queue routes implementation to Codex or another write-capable executor.

## Forbidden Paths

Gemini must not write to:

- `C:\Users\mjb58\connect-ai-vault`
- `C:\Users\mjb58\connect-ai-runtime\company` outside approved evidence roots
- `scripts/antigravity-reviewer.js` or `scripts/deep-debug-swarm.js` while the sibling Antigravity session owns those files
- dashboard/audit/swarm-status/readiness feature surfaces unless Pin explicitly approves a later slice

## Required Result Fields

Every result MUST include:

- `status`
- `executor="gemini"`
- `requestedModel`
- `observedModel`
- `filesChanged`
- `commandsRun`
- `unresolvedFailures`
- `evidence`

## MODEL_MISMATCH Rule

If `observedModel` is missing, the adapter MUST return `BLOCKED` with reason `MISSING_OBSERVED_MODEL`.

If `requestedModel` is set and differs from `observedModel`, the adapter MUST return `BLOCKED` with reason `MODEL_MISMATCH`, not `READY_FOR_VERIFICATION`.

The observed model must come from actual Gemini CLI execution evidence, not from the request payload.

## Done Rule

Gemini executor output may reach `READY_FOR_VERIFICATION` only. It may not report `DONE`; final acceptance remains verifier-gated.

## Budgets

Default token budget: `medium`.

Default retry budget: `1`. If Gemini returns `MODEL_MISMATCH`, `UNSUPPORTED_MODEL`, credential failure, quota failure, or empty evidence twice in the same queue item lineage, the router must stop retrying and mark the item `BLOCKED`.
