# Agent Contract Template

Use this template for every queued or delegated agent task.

```yaml
role: implementer | reviewer | researcher | verifier | local-smoke
assignee: codex | claude | gemini | antigravity | hermes | local-llm
riskClass: Green | Yellow | Red
writeScope:
  - path/or/module
forbiddenPaths:
  - ${VAULT_ROOT}\_company
  - ${VAULT_ROOT}\.obsidian
expectedTests:
  - command
rollbackPath: exact files or backup to restore
tokenBudget: short numeric or "bounded"
retryBudget: 0 | 1 | 2
requiresHumanApproval: true | false
stopCondition: when to stop instead of improvising
```

## DONE Rule

An agent may report `DONE` only if all are true:

1. It lists files changed.
2. It lists commands run in the current execution.
3. Required tests passed in the current execution.
4. It records unresolved failures or says there are none.
5. It leaves no unclassified generated artifacts.
6. A separate verifier confirmed the evidence and marked the queue item with `--verified`.

Executor output before verifier confirmation must use `READY_FOR_VERIFICATION`.
