# Agent Queue Copied-State Recovery Implementation

## Summary

Implemented a recovery mechanism for tasks stuck in "copied" state to prevent deadlocks in the Agent Manager queue.

## Changes Made

### 1. Modified `scripts/agent-queue.js`

#### Enhanced `claimItem()` function
- Now claims both "copied" and "queued" tasks for the same assignee
- Prioritizes "copied" tasks over "queued" tasks to prevent deadlocks
- Sets `recoveredFromStatus: "copied"` when recovering from copied state
- Emits different event types: `task.copied_claimed` vs `task.claimed`

#### Added `claimCopiedItem()` function
- Dedicated command to claim only copied tasks
- Useful for explicit recovery operations
- Same priority ordering (P0 > P1 > P2, then by creation time)
- Respects assignee filtering

#### Enhanced `replanQueue()` function
- Moved copied task warning to top of `nextActions` with "URGENT:" prefix
- Added "(deadlock risk)" to the warning message
- Ensures copied tasks are clearly visible as lag/attention items

#### Updated `usage()` function
- Added documentation for `claim-copied` command

#### Updated command routing
- Added `claim-copied` command handler

### 2. Modified `mcp/server.js`

#### Added `task_claim_copied` MCP tool
- New tool for claiming copied tasks via MCP
- Description: "Atomically claim the next copied task for a Codex, Claude, or Hermes worker. Use this to recover tasks stuck in copied state after prompt handoffs."
- Same parameters as `task_claim`: `assignee` (required) and `worker` (optional)

### 3. Added tests in `scripts/agent-queue.test.js`

#### New tests:
1. `claim-copied recovers tasks stuck in copied state` - Basic recovery functionality
2. `claim-copied respects priority and creation time ordering` - Correct ordering
3. `claim-copied only claims tasks for the specified assignee` - Assignee isolation
4. `claim-copied returns no task when no copied tasks exist` - Empty queue handling
5. `MCP server exposes task_claim_copied for recovery` - MCP tool registration

#### Existing test (already passing):
- `claim recovers copied tasks before queued tasks for the same assignee` - Validates priority behavior

## How It Works

### Normal Claim Flow
When a worker calls `claim --assignee codex`:
1. The system looks for both "copied" and "queued" tasks for that assignee
2. Copied tasks are prioritized over queued tasks
3. If a copied task is found, it's moved to "running" with `recoveredFromStatus: "copied"`
4. Event type is `task.copied_claimed`

### Explicit Recovery Flow
When a worker calls `claim-copied --assignee codex`:
1. The system looks only for "copied" tasks for that assignee
2. Uses same priority ordering (P0 > P1 > P2, then by creation time)
3. Moves the task to "running" with `recoveredFromStatus: "copied"`
4. Event type is `task.copied_claimed`

### Replan Visibility
When `replan` is called:
1. If there are copied tasks, the first nextAction is: "URGENT: Hermes/Codex: recover copied tasks so copied prompt handoffs do not become invisible (deadlock risk)."
2. This ensures copied tasks are prominently displayed as lag/attention items

## Benefits

1. **Deadlock Prevention**: Workers automatically recover copied tasks before claiming new queued tasks
2. **Explicit Recovery**: Dedicated `claim-copied` command for manual recovery operations
3. **Visibility**: Copied tasks are clearly highlighted in replan output with URGENT prefix
4. **Minimal Changes**: Implementation uses existing patterns and adds minimal code
5. **Test Coverage**: Comprehensive tests ensure reliability

## Testing

All tests pass:
- 11 tests total
- 0 failures
- Tests cover both normal claim and explicit recovery flows
- Tests verify priority ordering and assignee isolation

## Usage Examples

### Via CLI
```bash
# Normal claim (automatically recovers copied tasks first)
node scripts/agent-queue.js claim --assignee codex --worker my-worker

# Explicit recovery (only copied tasks)
node scripts/agent-queue.js claim-copied --assignee codex --worker recovery-worker

# Check for copied tasks
node scripts/agent-queue.js list --status copied

# Replan to see copied task warnings
node scripts/agent-queue.js replan --worker hermes
```

### Via MCP
```javascript
// Normal claim (automatically recovers copied tasks first)
await mcp.callTool({ name: "task_claim", arguments: { assignee: "codex", worker: "my-worker" } });

// Explicit recovery (only copied tasks)
await mcp.callTool({ name: "task_claim_copied", arguments: { assignee: "codex", worker: "recovery-worker" } });
```

## Files Modified

1. `/mnt/c/Users/mjb58/antigravity-projects/connect-ai/scripts/agent-queue.js`
2. `/mnt/c/Users/mjb58/antigravity-projects/connect-ai/mcp/server.js`
3. `/mnt/c/Users/mjb58/antigravity-projects/connect-ai/scripts/agent-queue.test.js`

## No Secret Information

All changes avoid outputting secret information:
- Prompts are redacted using existing `redact()` function
- Worker names are limited to 120 characters and redacted
- Result summaries are limited and redacted
- No API keys, tokens, or other secrets are exposed