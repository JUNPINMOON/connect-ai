# Connect AI Agent OS Operating Model

## First Milestone

Build the guardrails before increasing agent count:

- single durable-note writer
- runtime/vault separation
- explicit agent contracts
- verification gates
- rollback manifests
- readable Obsidian graph hubs

## Pyramid Phases

| Phase | Shape | Allowed Automation |
| --- | --- | --- |
| A | Codex + verifier | one implementation slice and independent verification |
| B | Codex + reviewer + local-smoke | review and cheap smoke checks |
| C | 2-3 worker queue | guarded queue execution with disjoint write scopes |
| D | overnight read-only audit | health reports, backlog summaries, suggestions |
| E | approved self-healing | only low-risk fixes with rollback paths |

## Status Vocabulary

- `VERIFIED`: fresh verification evidence passed in the current run.
- `PARTIAL`: useful work exists, but at least one required gate was not run or did not pass.
- `BLOCKED`: a concrete blocker prevents further safe progress.

Do not use "complete" as a substitute for `VERIFIED`.

## Queue Verification Loop

Executor tasks that can write must stop at `READY_FOR_VERIFICATION`.

1. Create reviewer tasks with `npm run agent:verify-dispatch -- --execute`.
2. The reviewer must stay read-only and record `검증 판정: accept`, `reject`, or `needs_human`.
3. Apply verifier evidence with `npm run agent:verify-dispatch -- --apply --execute`.
4. The source task reaches `DONE --verified` only for `accept`; `reject` and `needs_human` close it as `BLOCKED` for a human or safer follow-up.

The nightly read-only audit exercises this loop against an isolated temp queue.

## Circuit Breakers

- Worker cap defaults to 2 and must not exceed 3 without explicit approval.
- The same failure repeated twice blocks the queue item.
- Risky writes, credential access, deploys, sends, migrations, and destructive cleanup require human approval.
- Durable vault writes that violate policy go to `rejected-writes`, not the vault.

## Graph Repair Planning

Run `npm run agent:graph-audit` before touching legacy vault notes. It is read-only and reports:

- notes missing frontmatter
- notes without any links
- notes missing a `00_MOC` hub link
- suggested frontmatter and MOC link for each proposed repair

The audit intentionally ignores graph-noise folders such as `40_템플릿/`, `_templates/`, `decisions/archive/`, and timestamped decision backup folders. Those notes are not treated as durable graph hubs.

Use the apply path only in small batches:

```powershell
npm run agent:graph-audit -- --apply --max 10
npm run agent:graph-audit -- --apply --execute --max 10 --batch-id graph-repair-YYYYMMDD-HHMM
```

The first command is dry-run. The second command may write, but only through `vault-writer`; it creates per-note backups under the Connect AI phase2 storage and records a repair manifest. After every batch, rerun vault health and graph audit before continuing.

Root-level notes are not auto-moved by graph repair. The audit emits `manualPlan` entries with:

- proposed destination: `wiki/tools/`, `wiki/projects/`, `agent-guides/`, or `runbooks/`
- required MOC link
- `approvalRequired: true`
- rollback instruction

Before asking for human approval, generate a review packet:

```powershell
npm run agent:graph-audit -- --approval-packet --write-packet --max 100
```

The packet is written outside the vault under the phase2 storage root. It records the batch id, every source and target path, `Red` risk classification, required MOC link, exact live command, exact rollback command, and mandatory post-run gates. Apply root moves only after reviewing that packet, because moving root notes may affect human habits. The current move path preserves the note basename so existing wiki links keep resolving, creates vault-writer backups, and requires `--execute --approved` for both migration and rollback.
