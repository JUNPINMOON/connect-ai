# Connect AI Department Registry

Connect AI should stay thin. It should route, display status, request approval,
and call adapters. Existing projects remain the source of truth for their own
code, data, tests, and safety rules.

## Current Rule

- This registry is read-only by default.
- Department commands are listed for future use but are not executed by the
  status command.
- Existing project source trees must not be modified by Connect AI adapters
  unless the user explicitly approves that department action.
- High-risk projects, especially stock decision support, stay broker-free and
  decision-support-only.

## Files

- `config/project-registry.json`: local project-to-department mapping.
- `config/tool-registry.json`: shared tools that adapters may call later.
- `config/port-registry.json`: local service ports to avoid accidental overlap.
- `src/our/department-types.ts`: typed adapter/registry contracts.
- `src/our/department-registry.ts`: read-only inspection helpers.
- `src/our/hooks.ts`: VS Code command registration.

## First Command

Run this from the command palette:

```text
Connect AI: 부서 연결 상태 보기
```

The command opens a Markdown report and the `Connect AI Departments` output
channel. It checks only path existence, git status, latest modification time,
and declared output artifacts.
