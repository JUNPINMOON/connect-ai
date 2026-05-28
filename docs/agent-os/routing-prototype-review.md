# S4 Routing Prototype Review Packet

Status: pending human review
Purpose: choose exactly one safe prototype path before implementing multi-model routing

## Recommendation

Prototype this route first:

```text
Pin -> Connect AI queue item -> Codex executor -> Gemini verifier -> DONE only after verified evidence
```

Why this route first:

- It directly advances the pyramid structure Pin asked for.
- It avoids treating Antigravity as a model-selectable executor; `agy` inherits the IDE/account current model.
- It exercises the most important safety invariant: executor output becomes `READY_FOR_VERIFICATION`, not `DONE`.
- It uses the existing queue/verifier architecture instead of adding another orchestration layer.
- It can be tested with a non-secret, low-risk Green task and isolated write scope.

## Candidate Routes

| Candidate | Route | Value | Risk | Decision |
|---|---|---|---|---|
| A | Pin -> Connect AI -> Codex executor -> Gemini verifier | proves executor/verifier pyramid | low to medium | choose first |
| B | Pin -> Connect AI -> Claude contract drafter -> Codex vault-writer | proves docs-to-memory flow | medium because durable note writes are involved | hold for second |
| C | Pin -> Connect AI -> local LLM classifier -> Codex executor | saves tokens | medium because local classifier quality is not benchmarked | hold until local benchmark |
| D | Pin -> Connect AI -> Antigravity current-model architecture reviewer -> Gemini CLI model-specific route | proves critique routing truth | blocked unless observed model evidence is present; `agy` cannot select models | hold |
| E | Pin -> Connect AI -> Hermes observer -> reviewer | long-running automation surface | high if Hermes becomes loop driver | hold |

## Prototype Scope For Candidate A

The first prototype should route one Green, non-secret, non-destructive task:

```json
{
  "intent": "implementation-or-docs-smoke",
  "riskClass": "Green",
  "writeScope": "repo:docs/agent-os/s4-prototype-smoke.md or read-only",
  "expectedTests": [
    "queue item reaches ready_for_verification after executor",
    "Gemini verifier task is created",
    "source item reaches done only after verifier accept verdict"
  ],
  "rollbackPath": "delete generated smoke doc or leave no repo write for read-only mode",
  "tokenBudget": "small",
  "retryBudget": 1,
  "approvalRequired": false
}
```

The implementation should not create a new autonomous loop. It should add the thinnest routing path that proves the handoff shape.

## Acceptance Criteria

Candidate A is accepted only if all are true:

1. A Connect AI queue item can express `intent`, `riskClass`, `writeScope`, `expectedTests`, `rollbackPath`, `tokenBudget`, and `retryBudget`.
2. Codex can claim or receive the item as executor.
3. Codex executor result cannot become `DONE` directly.
4. The item becomes `READY_FOR_VERIFICATION`.
5. A Gemini verifier task is generated with read-only scope and evidence requirements.
6. The source item becomes `DONE` only after explicit verifier accept evidence.
7. A rejection verdict blocks or requeues within retry budget.
8. No direct durable vault write happens.
9. Generated artifacts are either classified as runtime evidence or listed as repo changes.
10. Final report uses only `VERIFIED`, `PARTIAL`, or `BLOCKED`.

## Token Budget

Default for the first route:

- classifier/planner: small
- Codex executor: small to medium
- Gemini verifier: small
- no Claude unless the task is contract/documentation-heavy
- no Antigravity model-specific dispatch through `agy`; direct Antigravity must record observed model evidence
- no local LLM authority until a tiny benchmark proves it can classify Green/Yellow/Red reliably

Escalate budget only when:

- the queue item touches multiple files;
- a reviewer rejects the result;
- safety classification is ambiguous;
- user-facing behavior is involved.

## Failure Handling

| Failure | Response |
|---|---|
| Codex reports `DONE` directly | reject result and keep item at `READY_FOR_VERIFICATION` or blocked |
| Gemini unavailable | route to Claude reviewer only for docs/contracts; otherwise report `PARTIAL` |
| verifier rejects evidence | block or requeue once, depending on retry budget |
| generated artifact is unclassified | reject finalization |
| write scope is broader than expected | require human approval or split task |
| Antigravity observed model is missing or mismatched | block the result with `MISSING_OBSERVED_MODEL` or `MODEL_MISMATCH`; use Gemini CLI for model-specific routes |

## Non-Goals

- no dozens-of-agents launch;
- no overnight self-healing;
- no direct vault writing by any agent;
- no root migration execution;
- no broad queue replay;
- no autonomous Hermes approval or closure;
- no CodeRabbit dependency for this prototype.

## Review Questions For Pin

1. Confirm Candidate A as the first S4 prototype path?
2. Should the first task be read-only, or may it write one repo doc under `docs/agent-os/`?
3. Should Gemini CLI be the model-specific reviewer/executor while Antigravity remains current-model critique only?

## Recommended S4 Command Shape

After review, the implementation slice should be bounded to one command path:

```powershell
node scripts/agent-queue.js add --assignee codex --priority P2 --title "S4 routing prototype smoke" --prompt "<bounded Green task>"
node scripts/run-queue.js --id <task-id>
node scripts/verification-dispatch.js --execute --reviewer gemini
node scripts/verification-dispatch.js --apply --execute
node scripts/result-validator.js
```

If the current CLI names differ, S4 should adapt to the existing scripts rather than inventing a parallel runner.
