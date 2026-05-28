#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const test = require("node:test");

const cliPath = path.join(__dirname, "agent-queue.js");

function runQueue(args, env) {
  const output = execFileSync(process.execPath, [cliPath, ...args], {
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  return JSON.parse(output);
}

function runQueueBlocked(args, env) {
  try {
    runQueue(args, env);
  } catch (error) {
    assert.equal(error.status, 3);
    return JSON.parse(error.stdout);
  }
  assert.fail("Expected agent-queue command to be blocked");
}

function contractArgs(options = {}) {
  const executor = options.executor || "codex";
  const risk = options.risk || (executor === "gemini" || executor === "antigravity" || executor === "local-llm" ? "Green" : "Yellow");
  const file = options.file || `scratch/${executor}-contract-target.md`;
  return [
    "--risk", risk,
    "--risk-class", risk,
    "--file", file,
    "--write-scope", file,
    "--expected-test", options.expectedTest || "current-run contract evidence exists",
    "--rollback-path", options.rollbackPath || "test rollback only",
    "--executor", executor,
    "--reviewer", options.reviewer || "pending-s7",
  ];
}

test("replan summarizes queue state and writes an append-only event ledger", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-queue-"));
  const queueFile = path.join(tempDir, "agent-queue.json");
  const env = { CONNECT_AI_AGENT_QUEUE: queueFile };

  const codex = runQueue([
    "add",
    "--assignee", "codex",
    "--priority", "P1",
    "--title", "Build bridge",
    "--prompt", "Implement the next bridge slice.",
    "--file", "scripts/example.js",
  ], env).item;

  const hermes = runQueue([
    "add",
    "--assignee", "hermes",
    "--priority", "P1",
    "--title", "Aggregate queue",
    "--prompt", "Summarize all queue state.",
    ...contractArgs({ executor: "hermes", risk: "Yellow", file: "reports/queue-summary.md" }),
  ], env).item;

  runQueue(["update", "--id", codex.id, "--status", "done", "--result-summary", "Bridge smoke passed.", "--verified"], env);
  runQueue(["claim", "--assignee", "hermes", "--worker", "hermes-smoke", "--force"], env);

  const report = runQueue(["replan", "--worker", "hermes-smoke"], env);

  assert.equal(report.success, true);
  assert.equal(report.summary.statusCounts.done, 1);
  assert.equal(report.summary.statusCounts.running, 1);
  assert.equal(report.summary.done[0].id, codex.id);
  assert.equal(report.summary.running[0].id, hermes.id);
  assert.ok(report.summary.nextActions.some((action) => action.includes("Hermes")));
  assert.ok(fs.existsSync(report.reportPath));

  const ledgerPath = path.join(tempDir, "agent-queue-events.jsonl");
  const events = fs.readFileSync(ledgerPath, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.ok(events.some((event) => event.type === "task.added" && event.id === codex.id));
  assert.ok(events.some((event) => event.type === "task.updated" && event.id === codex.id && event.status === "done"));
  assert.ok(events.some((event) => event.type === "task.claimed" && event.id === hermes.id));
  assert.ok(events.some((event) => event.type === "queue.replanned"));
});

test("MCP server exposes task_replan for Hermes aggregation", () => {
  const serverSource = fs.readFileSync(path.join(__dirname, "..", "mcp", "server.js"), "utf8");
  assert.match(serverSource, /server\.registerTool\(\s*["']task_replan["']/);
  assert.match(serverSource, /"replan"/);
});

test("replan escalates completed tasks with residual risks into a Hermes decision request", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-queue-"));
  const queueFile = path.join(tempDir, "agent-queue.json");
  const env = { CONNECT_AI_AGENT_QUEUE: queueFile };

  const audited = runQueue([
    "add",
    "--assignee", "claude",
    "--priority", "P1",
    "--title", "LLM Wiki read-only audit",
    "--prompt", "Audit the wiki.",
  ], env).item;

  runQueue([
    "update",
    "--id", audited.id,
    "--status", "done",
    "--result-summary", "READY WITH RISKS. 남은 리스크 2건 발견. 후속 판단 필요.",
    "--verified",
  ], env);

  const report = runQueue(["replan", "--worker", "hermes", "--auto-escalate-risks"], env);

  assert.equal(report.success, true);
  assert.equal(report.summary.decisionRequests.length, 1);
  assert.equal(report.summary.decisionRequests[0].sourceTaskId, audited.id);
  assert.equal(report.escalated.length, 1);
  assert.equal(report.escalated[0].assignee, "hermes");
  assert.match(report.escalated[0].title, /decision/i);

  const secondReport = runQueue(["replan", "--worker", "hermes", "--auto-escalate-risks"], env);
  assert.equal(secondReport.escalated.length, 0);

  const queue = runQueue(["list"], env).items;
  const decisionTasks = queue.filter((item) => item.prompt.includes(`[decision-source:${audited.id}]`));
  assert.equal(decisionTasks.length, 1);
});

test("replan exposes copied tasks so prompt handoff deadlocks are visible", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-queue-"));
  const queueFile = path.join(tempDir, "agent-queue.json");
  const env = { CONNECT_AI_AGENT_QUEUE: queueFile };

  const copied = runQueue([
    "add",
    "--assignee", "hermes",
    "--priority", "P1",
    "--title", "Decision prompt copied",
    "--prompt", "Ask the user for a decision.",
  ], env).item;

  runQueue(["update", "--id", copied.id, "--status", "copied"], env);
  const report = runQueue(["replan", "--worker", "hermes"], env);

  assert.equal(report.success, true);
  assert.equal(report.summary.statusCounts.copied, 1);
  assert.equal(report.summary.copied.length, 1);
  assert.equal(report.summary.copied[0].id, copied.id);
  assert.ok(report.summary.nextActions.some((action) => action.includes("recover copied tasks")));
});

test("claim recovers copied tasks before queued tasks for the same assignee", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-queue-"));
  const queueFile = path.join(tempDir, "agent-queue.json");
  const env = { CONNECT_AI_AGENT_QUEUE: queueFile };

  const copied = runQueue([
    "add",
    "--assignee", "codex",
    "--priority", "P1",
    "--title", "Copied handoff",
    "--prompt", "Recover this copied prompt handoff.",
    ...contractArgs({ executor: "codex", file: "scripts/copied-handoff.js" }),
  ], env).item;

  const queued = runQueue([
    "add",
    "--assignee", "codex",
    "--priority", "P1",
    "--title", "Queued follow-up",
    "--prompt", "Do this after copied handoffs are recovered.",
  ], env).item;

  runQueue(["update", "--id", copied.id, "--status", "copied"], env);
  const claim = runQueue(["claim", "--assignee", "codex", "--worker", "codex-recovery"], env);

  assert.equal(claim.success, true);
  assert.equal(claim.claimed, true);
  assert.equal(claim.item.id, copied.id);
  assert.equal(claim.item.status, "running");
  assert.equal(claim.item.recoveredFromStatus, "copied");

  const queue = runQueue(["list"], env).items;
  assert.equal(queue.find((item) => item.id === copied.id).status, "running");
  assert.equal(queue.find((item) => item.id === queued.id).status, "queued");
});

test("claiming a normal queued task does not mark it as recovered from copied", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-queue-"));
  const queueFile = path.join(tempDir, "agent-queue.json");
  const env = { CONNECT_AI_AGENT_QUEUE: queueFile };

  const queued = runQueue([
    "add",
    "--assignee", "codex",
    "--priority", "P1",
    "--title", "Normal queued task",
    "--prompt", "Claim normally.",
    ...contractArgs({ executor: "codex", file: "scripts/normal-queued.js" }),
  ], env).item;

  const claim = runQueue(["claim", "--assignee", "codex", "--worker", "codex-worker"], env);

  assert.equal(claim.claimed, true);
  assert.equal(claim.item.id, queued.id);
  assert.equal(claim.item.status, "running");
  assert.equal(claim.item.recoveredFromStatus, undefined);
});

test("claim can pin an exact queued task id", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-queue-"));
  const queueFile = path.join(tempDir, "agent-queue.json");
  const env = { CONNECT_AI_AGENT_QUEUE: queueFile };

  const older = runQueue([
    "add",
    "--assignee", "codex",
    "--priority", "P0",
    "--title", "Older task",
    "--prompt", "Read-only audit older task.",
  ], env).item;
  const pinned = runQueue([
    "add",
    "--assignee", "codex",
    "--priority", "P1",
    "--title", "Pinned task",
    "--prompt", "Read-only audit pinned task.",
    ...contractArgs({ executor: "codex", file: "scripts/pinned.js" }),
  ], env).item;

  const claimed = runQueue(["claim", "--assignee", "codex", "--worker", "pin-test", "--id", pinned.id], env);
  assert.equal(claimed.claimed, true);
  assert.equal(claimed.item.id, pinned.id);
  const olderAfter = runQueue(["get", "--id", older.id], env).item;
  assert.equal(olderAfter.status, "queued");
});

test("claim increments run attempts and blocks exhausted retry budget on requeue", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-queue-"));
  const queueFile = path.join(tempDir, "agent-queue.json");
  const env = { CONNECT_AI_AGENT_QUEUE: queueFile };

  const task = runQueue([
    "add",
    "--assignee", "codex",
    "--priority", "P1",
    "--title", "Implement once only",
    "--prompt", "Modify a scoped file.",
    "--retry-budget", "0",
    ...contractArgs({ executor: "codex", file: "scripts/once-only.js" }),
  ], env).item;

  const first = runQueue(["claim", "--assignee", "codex", "--worker", "test-worker", "--id", task.id], env);
  assert.equal(first.claimed, true);
  assert.equal(first.item.runAttempts, 1);

  runQueue(["update", "--id", task.id, "--status", "queued", "--result-summary", "retry requested"], env);
  const second = runQueue(["claim", "--assignee", "codex", "--worker", "test-worker", "--id", task.id], env);
  assert.equal(second.claimed, false);
  assert.equal(second.blocked, true);
  assert.equal(second.reason, "RETRY_BUDGET_EXHAUSTED");
});

test("same failure repeated twice opens a circuit breaker before another claim", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-queue-"));
  const queueFile = path.join(tempDir, "agent-queue.json");
  const env = { CONNECT_AI_AGENT_QUEUE: queueFile };

  const task = runQueue([
    "add",
    "--assignee", "gemini",
    "--priority", "P1",
    "--title", "Model-specific verifier",
    "--prompt", "Read-only verifier. Do not edit files.",
    "--retry-budget", "3",
    ...contractArgs({ executor: "gemini", file: "reports/model-review.md", risk: "Green" }),
  ], env).item;

  runQueue([
    "update",
    "--id", task.id,
    "--status", "blocked",
    "--result-summary", "BLOCKED: gemini executor dispatch failed contract check (MODEL_MISMATCH).",
  ], env);
  runQueue(["update", "--id", task.id, "--status", "queued", "--result-summary", "retry once"], env);
  const repeated = runQueue([
    "update",
    "--id", task.id,
    "--status", "blocked",
    "--result-summary", "BLOCKED: gemini executor dispatch failed contract check (MODEL_MISMATCH).",
  ], env).item;

  assert.equal(repeated.failureRepeatCount, 2);
  assert.equal(repeated.circuitBreaker.reason, "SAME_FAILURE_REPEATED");
  assert.equal(repeated.circuitBreaker.failure, "MODEL_MISMATCH");
  assert.match(repeated.resultSummary, /CIRCUIT_BREAKER/);

  runQueue(["update", "--id", task.id, "--status", "queued", "--result-summary", "force retry should not run"], env);
  const claim = runQueue(["claim", "--assignee", "gemini", "--worker", "test-worker", "--id", task.id], env);
  assert.equal(claim.claimed, false);
  assert.equal(claim.blocked, true);
  assert.equal(claim.reason, "CIRCUIT_BREAKER_OPEN");
});

test("add stores forbidden path contract fields", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-queue-"));
  const queueFile = path.join(tempDir, "agent-queue.json");
  const env = { CONNECT_AI_AGENT_QUEUE: queueFile };

  const task = runQueue([
    "add",
    "--assignee", "codex",
    "--priority", "P1",
    "--title", "Implement scoped contract",
    "--prompt", "Modify only the allowed script.",
    "--file", "scripts/example.js",
    "--write-scope", "scripts/example.js",
    "--forbidden-path", "C:\\Users\\mjb58\\connect-ai-vault",
    "--forbidden-path", "scripts/transport-audit.js",
  ], env).item;

  assert.deepEqual(task.forbiddenPaths, [
    "C:\\Users\\mjb58\\connect-ai-vault",
    "scripts/transport-audit.js",
  ]);
});

test("add stores explicit role contract and exposes it in compact get output", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-queue-"));
  const queueFile = path.join(tempDir, "agent-queue.json");
  const env = { CONNECT_AI_AGENT_QUEUE: queueFile };

  const task = runQueue([
    "add",
    "--assignee", "gemini",
    "--role", "verifier",
    "--priority", "P1",
    "--title", "Verification request: role contract",
    "--prompt", "Read-only verifier. Do not edit files.",
    "--risk", "Green",
  ], env).item;

  assert.equal(task.role, "verifier");
  assert.equal(task.workerClass, "reviewer");

  const compact = runQueue(["get", "--id", task.id], env).item;
  assert.equal(compact.role, "verifier");
  assert.equal(compact.workerClass, "reviewer");
});

test("add stores stop, approval, and evidence contract fields", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-queue-"));
  const queueFile = path.join(tempDir, "agent-queue.json");
  const env = { CONNECT_AI_AGENT_QUEUE: queueFile };

  const task = runQueue([
    "add",
    "--assignee", "codex",
    "--priority", "P1",
    "--title", "Implement contract detail",
    "--prompt", "Modify only the scoped file.",
    "--stop-condition", "Stop after one failed current-run test.",
    "--approval-condition", "Ask Pin before widening write scope.",
    "--evidence-required", "files changed",
    "--evidence-required", "commands run",
  ], env).item;

  assert.equal(task.stopCondition, "Stop after one failed current-run test.");
  assert.equal(task.approvalCondition, "Ask Pin before widening write scope.");
  assert.deepEqual(task.evidenceRequired, ["files changed", "commands run"]);

  const compact = runQueue(["get", "--id", task.id], env).item;
  assert.equal(compact.stopCondition, task.stopCondition);
  assert.equal(compact.approvalCondition, task.approvalCondition);
  assert.deepEqual(compact.evidenceRequired, task.evidenceRequired);
});


test("replan does not recursively escalate completed Hermes decision requests", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-queue-"));
  const queueFile = path.join(tempDir, "agent-queue.json");
  const env = { CONNECT_AI_AGENT_QUEUE: queueFile };

  const decision = runQueue([
    "add",
    "--assignee", "hermes",
    "--priority", "P1",
    "--title", "Decision request: Existing risk",
    "--prompt", "[decision-source:source-task]\nAsk the user.",
  ], env).item;

  runQueue([
    "update",
    "--id", decision.id,
    "--status", "done",
    "--result-summary", "Decision request 완료: 남은 리스크는 후속 Codex 작업으로 등록됨.",
    "--human-approved",
  ], env);

  const report = runQueue(["replan", "--worker", "hermes", "--auto-escalate-risks"], env);

  assert.equal(report.success, true);
  assert.equal(report.escalated.length, 0);
  assert.equal(report.summary.decisionRequests.length, 0);
});

test("guard blocks Decision requests from being marked done without human approval", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-queue-"));
  const queueFile = path.join(tempDir, "agent-queue.json");
  const env = { CONNECT_AI_AGENT_QUEUE: queueFile };

  const decision = runQueue([
    "add",
    "--assignee", "hermes",
    "--priority", "P0",
    "--title", "Decision request: Human approval needed",
    "--prompt", "Ask the user before closing this.",
  ], env).item;

  const blocked = runQueueBlocked([
    "update",
    "--id", decision.id,
    "--status", "done",
    "--result-summary", "Decision request is complete.",
  ], env);

  assert.equal(blocked.success, false);
  assert.equal(blocked.blocked_by_guard, true);
  assert.equal(blocked.reason, "HUMAN_APPROVAL_REQUIRED");
  assert.equal(fs.existsSync(`${queueFile}.lock`), false);

  const queue = runQueue(["list"], env).items;
  assert.equal(queue.find((item) => item.id === decision.id).status, "queued");
});

test("guard blocks fabricated approval claims without human approval flag", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-queue-"));
  const queueFile = path.join(tempDir, "agent-queue.json");
  const env = { CONNECT_AI_AGENT_QUEUE: queueFile };

  const task = runQueue([
    "add",
    "--assignee", "hermes",
    "--priority", "P1",
    "--title", "Summarize planning status",
    "--prompt", "Summarize queue state.",
  ], env).item;

  const blocked = runQueueBlocked([
    "update",
    "--id", task.id,
    "--status", "done",
    "--result-summary", "사용자 승인 반영 완료. Follow-up work queued.",
  ], env);

  assert.equal(blocked.success, false);
  assert.equal(blocked.blocked_by_guard, true);
  assert.equal(blocked.reason, "FABRICATED_APPROVAL_DETECTED");
  assert.equal(fs.existsSync(`${queueFile}.lock`), false);

  const queue = runQueue(["list"], env).items;
  assert.equal(queue.find((item) => item.id === task.id).status, "queued");
});

test("ordinary non-approval tasks can still be marked done after verification", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-queue-"));
  const queueFile = path.join(tempDir, "agent-queue.json");
  const env = { CONNECT_AI_AGENT_QUEUE: queueFile };

  const task = runQueue([
    "add",
    "--assignee", "codex",
    "--priority", "P1",
    "--title", "Update queue report formatting",
    "--prompt", "Make a small formatting-only update.",
  ], env).item;

  const updated = runQueue([
    "update",
    "--id", task.id,
    "--status", "done",
    "--result-summary", "Formatting update complete. Tests passed.",
    "--verified",
  ], env);

  assert.equal(updated.success, true);
  assert.equal(updated.item.status, "done");
  assert.equal(updated.item.resultSummary, "Formatting update complete. Tests passed.");
  assert.ok(updated.item.completedAt);
});

test("executor write tasks become ready_for_verification before DONE", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-queue-"));
  const queueFile = path.join(tempDir, "agent-queue.json");
  const env = { CONNECT_AI_AGENT_QUEUE: queueFile };

  const task = runQueue([
    "add",
    "--assignee", "codex",
    "--priority", "P1",
    "--title", "Implement vault writer",
    "--prompt", "Modify scripts/vault-writer.js and run tests.",
    "--file", "scripts/vault-writer.js",
  ], env).item;

  const updated = runQueue([
    "update",
    "--id", task.id,
    "--status", "done",
    "--result-summary", "Files changed: scripts/vault-writer.js. Commands run: node --test scripts/vault-writer.test.js. Tests passed. Unresolved failures: none.",
  ], env);

  assert.equal(updated.success, true);
  assert.equal(updated.item.status, "ready_for_verification");
  assert.match(updated.item.resultSummary, /READY_FOR_VERIFICATION/);
  assert.equal(updated.item.completedAt, undefined);
});

test("updates with missing required evidence are blocked before ready_for_verification", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-queue-"));
  const queueFile = path.join(tempDir, "agent-queue.json");
  const env = { CONNECT_AI_AGENT_QUEUE: queueFile };

  const task = runQueue([
    "add",
    "--assignee", "codex",
    "--priority", "P1",
    "--title", "Implement evidence gate",
    "--prompt", "Modify only the scoped file.",
    "--evidence-required", "files changed",
    "--evidence-required", "commands run",
  ], env).item;

  const updated = runQueue([
    "update",
    "--id", task.id,
    "--status", "done",
    "--result-summary", "Work complete.",
  ], env);

  assert.equal(updated.success, false);
  assert.equal(updated.reason, "MISSING_REQUIRED_EVIDENCE");
  assert.equal(updated.item.status, "blocked");
  assert.match(updated.item.resultSummary, /Missing required evidence/);
  assert.equal(updated.item.agentOsStatus, "BLOCKED");
});

test("unverified read-only reviewer tasks become ready_for_verification before DONE", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-queue-"));
  const queueFile = path.join(tempDir, "agent-queue.json");
  const env = { CONNECT_AI_AGENT_QUEUE: queueFile };

  const task = runQueue([
    "add",
    "--assignee", "antigravity",
    "--priority", "P2",
    "--title", "Antigravity read-only review",
    "--prompt", "Read-only review. Do not edit files.",
    "--risk", "Green",
    "--risk-class", "Green",
  ], env).item;

  const updated = runQueue([
    "update",
    "--id", task.id,
    "--status", "done",
    "--result-summary", "Review evidence recorded. No files changed. Commands run: agy run read-only review. Expected tests/evidence: transcript inspected. Unresolved failures: none.",
  ], env);

  assert.equal(updated.success, true);
  assert.equal(updated.item.status, "ready_for_verification");
  assert.equal(updated.item.agentOsStatus, "READY_FOR_VERIFICATION");
  assert.match(updated.item.resultSummary, /READY_FOR_VERIFICATION/);
  assert.equal(updated.item.completedAt, undefined);
});

test("verified executor tasks can be marked done explicitly", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-queue-"));
  const queueFile = path.join(tempDir, "agent-queue.json");
  const env = { CONNECT_AI_AGENT_QUEUE: queueFile };

  const task = runQueue([
    "add",
    "--assignee", "codex",
    "--priority", "P1",
    "--title", "Implement verified slice",
    "--prompt", "Modify files after verifier approves.",
    "--file", "scripts/example.js",
  ], env).item;

  const updated = runQueue([
    "update",
    "--id", task.id,
    "--status", "done",
    "--result-summary", "Verifier confirmed current-run tests passed and artifacts are classified.",
    "--verified",
  ], env);

  assert.equal(updated.success, true);
  assert.equal(updated.item.status, "done");
  assert.ok(updated.item.verifiedAt);
  assert.ok(updated.item.completedAt);
});

test("queue accepts Google reviewer assignees", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-queue-"));
  const queueFile = path.join(tempDir, "agent-queue.json");
  const env = { CONNECT_AI_AGENT_QUEUE: queueFile };

  const gemini = runQueue([
    "add",
    "--assignee", "gemini",
    "--priority", "P2",
    "--title", "Gemini read-only review",
    "--prompt", "Read-only review.",
    ...contractArgs({ executor: "gemini", risk: "Green", file: "reviews/gemini.md" }),
  ], env).item;
  const antigravity = runQueue([
    "add",
    "--assignee", "antigravity",
    "--priority", "P2",
    "--title", "Antigravity read-only review",
    "--prompt", "Read-only review.",
  ], env).item;

  assert.equal(gemini.assignee, "gemini");
  assert.equal(antigravity.assignee, "antigravity");

  const claim = runQueue(["claim", "--assignee", "gemini", "--worker", "gemini-test"], env);
  assert.equal(claim.claimed, true);
  assert.equal(claim.item.id, gemini.id);
});

test("guard maintenance tasks mentioning approval hallucination are not treated as approval decisions", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-queue-"));
  const queueFile = path.join(tempDir, "agent-queue.json");
  const env = { CONNECT_AI_AGENT_QUEUE: queueFile };

  const task = runQueue([
    "add",
    "--assignee", "codex",
    "--priority", "P0",
    "--title", "P0 guard test repair after Hermes approval hallucination",
    "--prompt", "Repair tests for the Hermes hallucination guard.",
  ], env).item;

  const updated = runQueue([
    "update",
    "--id", task.id,
    "--status", "done",
    "--result-summary", "Guard test repair completed; no human approval claimed.",
    "--verified",
  ], env);

  assert.equal(updated.success, true);
  assert.equal(updated.item.status, "done");
});

test("claim-copied recovers tasks stuck in copied state", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-queue-"));
  const queueFile = path.join(tempDir, "agent-queue.json");
  const env = { CONNECT_AI_AGENT_QUEUE: queueFile };

  const copied = runQueue([
    "add",
    "--assignee", "codex",
    "--priority", "P1",
    "--title", "Stuck copied task",
    "--prompt", "This task got copied but never claimed.",
    ...contractArgs({ executor: "codex", file: "scripts/stuck-copied.js" }),
  ], env).item;

  runQueue(["update", "--id", copied.id, "--status", "copied"], env);

  const beforeClaim = runQueue(["list", "--status", "copied"], env);
  assert.equal(beforeClaim.items.length, 1);
  assert.equal(beforeClaim.items[0].id, copied.id);

  const claimResult = runQueue(["claim-copied", "--assignee", "codex", "--worker", "codex-recovery"], env);

  assert.equal(claimResult.success, true);
  assert.equal(claimResult.claimed, true);
  assert.equal(claimResult.item.id, copied.id);
  assert.equal(claimResult.item.status, "running");
  assert.equal(claimResult.item.claimedBy, "codex-recovery");
  assert.ok(claimResult.item.claimedAt);

  const afterClaim = runQueue(["list", "--status", "copied"], env);
  assert.equal(afterClaim.items.length, 0);

  const running = runQueue(["list", "--status", "running"], env);
  assert.equal(running.items.length, 1);
  assert.equal(running.items[0].id, copied.id);
});

test("claim-copied blocks copied tasks that violate forbidden write scope", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-queue-"));
  const queueFile = path.join(tempDir, "agent-queue.json");
  const env = { CONNECT_AI_AGENT_QUEUE: queueFile };

  const copied = runQueue([
    "add",
    "--assignee", "codex",
    "--priority", "P0",
    "--title", "Copied forbidden vault write",
    "--prompt", "Modify the vault directly.",
    "--risk", "Yellow",
    "--risk-class", "Yellow",
    "--write-scope", "C:\\Users\\mjb58\\connect-ai-vault\\notes\\bad.md",
    "--forbidden-path", "C:\\Users\\mjb58\\connect-ai-vault",
  ], env).item;

  runQueue(["update", "--id", copied.id, "--status", "copied"], env);

  const claimResult = runQueue(["claim-copied", "--assignee", "codex", "--worker", "codex-recovery"], env);

  assert.equal(claimResult.success, false);
  assert.equal(claimResult.claimed, false);
  assert.equal(claimResult.blocked, true);
  assert.equal(claimResult.reason, "FORBIDDEN_WRITE_SCOPE");
  assert.equal(claimResult.item.id, copied.id);
  assert.equal(claimResult.item.status, "blocked");

  const blocked = runQueue(["list", "--status", "blocked"], env);
  assert.equal(blocked.items.length, 1);
  assert.equal(blocked.items[0].id, copied.id);
});

test("claim blocks explicit forbidden write scope even when assignee cannot write", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-queue-"));
  const queueFile = path.join(tempDir, "agent-queue.json");
  const env = { CONNECT_AI_AGENT_QUEUE: queueFile };

  const task = runQueue([
    "add",
    "--assignee", "local-llm",
    "--priority", "P1",
    "--title", "Read-only local smoke with forbidden write scope",
    "--prompt", "Read-only summarize the target. Do not edit files.",
    "--risk", "Green",
    "--risk-class", "Green",
    "--can-write", "false",
    "--write-scope", "C:\\Users\\mjb58\\connect-ai-vault\\notes\\bad.md",
    "--forbidden-path", "C:\\Users\\mjb58\\connect-ai-vault",
  ], env).item;

  const claimResult = runQueue(["claim", "--assignee", "local-llm", "--worker", "local-llm-test", "--id", task.id], env);
  assert.equal(claimResult.success, false);
  assert.equal(claimResult.claimed, false);
  assert.equal(claimResult.blocked, true);
  assert.equal(claimResult.reason, "FORBIDDEN_WRITE_SCOPE");
  assert.equal(claimResult.item.status, "blocked");
});

test("claim blocks queued tasks missing required automation contract fields", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-queue-"));
  const queueFile = path.join(tempDir, "agent-queue.json");
  const env = { CONNECT_AI_AGENT_QUEUE: queueFile };

  const task = runQueue([
    "add",
    "--assignee", "codex",
    "--priority", "P1",
    "--title", "Ambiguous implementation without contract",
    "--prompt", "Modify whatever is needed.",
    "--risk", "Yellow",
  ], env).item;

  const claimResult = runQueue(["claim", "--assignee", "codex", "--worker", "codex-test", "--id", task.id], env);

  assert.equal(claimResult.success, false);
  assert.equal(claimResult.claimed, false);
  assert.equal(claimResult.blocked, true);
  assert.equal(claimResult.reason, "INCOMPLETE_AUTOMATION_CONTRACT");
  assert.deepEqual(claimResult.missingContractFields, ["writeScope", "expectedTests", "rollbackPath", "executor", "reviewer"]);
  assert.equal(claimResult.item.status, "blocked");
  assert.match(claimResult.item.resultSummary, /INCOMPLETE_AUTOMATION_CONTRACT/);
});

test("claim-copied blocks copied tasks missing required automation contract fields", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-queue-"));
  const queueFile = path.join(tempDir, "agent-queue.json");
  const env = { CONNECT_AI_AGENT_QUEUE: queueFile };

  const copied = runQueue([
    "add",
    "--assignee", "codex",
    "--priority", "P1",
    "--title", "Copied ambiguous implementation without contract",
    "--prompt", "Modify whatever is needed.",
    "--risk", "Yellow",
  ], env).item;

  runQueue(["update", "--id", copied.id, "--status", "copied"], env);
  const claimResult = runQueue(["claim-copied", "--assignee", "codex", "--worker", "codex-test"], env);

  assert.equal(claimResult.success, false);
  assert.equal(claimResult.claimed, false);
  assert.equal(claimResult.blocked, true);
  assert.equal(claimResult.reason, "INCOMPLETE_AUTOMATION_CONTRACT");
  assert.deepEqual(claimResult.missingContractFields, ["writeScope", "expectedTests", "rollbackPath", "executor", "reviewer"]);
  assert.equal(claimResult.item.status, "blocked");
  assert.match(claimResult.item.resultSummary, /INCOMPLETE_AUTOMATION_CONTRACT/);
});

test("force cannot claim queued or copied tasks that violate forbidden write scope", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-queue-"));
  const queueFile = path.join(tempDir, "agent-queue.json");
  const env = { CONNECT_AI_AGENT_QUEUE: queueFile };

  const queued = runQueue([
    "add",
    "--assignee", "codex",
    "--priority", "P0",
    "--title", "Forced forbidden vault write",
    "--prompt", "Modify the vault directly.",
    "--risk", "Yellow",
    "--risk-class", "Yellow",
    "--write-scope", "C:\\Users\\mjb58\\connect-ai-vault\\notes\\bad.md",
    "--forbidden-path", "C:\\Users\\mjb58\\connect-ai-vault",
  ], env).item;

  const copied = runQueue([
    "add",
    "--assignee", "codex",
    "--priority", "P0",
    "--title", "Forced copied forbidden vault write",
    "--prompt", "Modify the vault directly.",
    "--risk", "Yellow",
    "--risk-class", "Yellow",
    "--write-scope", "C:\\Users\\mjb58\\connect-ai-vault\\notes\\bad2.md",
    "--forbidden-path", "C:\\Users\\mjb58\\connect-ai-vault",
  ], env).item;
  runQueue(["update", "--id", copied.id, "--status", "copied"], env);

  const claim = runQueue(["claim", "--assignee", "codex", "--worker", "codex-force", "--id", queued.id, "--force"], env);
  assert.equal(claim.success, false);
  assert.equal(claim.blocked, true);
  assert.equal(claim.reason, "FORBIDDEN_WRITE_SCOPE");
  assert.equal(claim.item.status, "blocked");

  const copiedClaim = runQueue(["claim-copied", "--assignee", "codex", "--worker", "codex-force", "--force"], env);
  assert.equal(copiedClaim.success, false);
  assert.equal(copiedClaim.blocked, true);
  assert.equal(copiedClaim.reason, "FORBIDDEN_WRITE_SCOPE");
  assert.equal(copiedClaim.item.status, "blocked");
});

test("claim-copied respects priority and creation time ordering", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-queue-"));
  const queueFile = path.join(tempDir, "agent-queue.json");
  const env = { CONNECT_AI_AGENT_QUEUE: queueFile };

  const lowPriority = runQueue([
    "add",
    "--assignee", "codex",
    "--priority", "P2",
    "--title", "Low priority copied",
    "--prompt", "Low priority task.",
    ...contractArgs({ executor: "codex", file: "scripts/low-priority-copied.js" }),
  ], env).item;

  const highPriority = runQueue([
    "add",
    "--assignee", "codex",
    "--priority", "P0",
    "--title", "High priority copied",
    "--prompt", "High priority task.",
    ...contractArgs({ executor: "codex", file: "scripts/high-priority-copied.js" }),
  ], env).item;

  runQueue(["update", "--id", lowPriority.id, "--status", "copied"], env);
  runQueue(["update", "--id", highPriority.id, "--status", "copied"], env);

  const firstClaim = runQueue(["claim-copied", "--assignee", "codex"], env);
  assert.equal(firstClaim.claimed, true);
  assert.equal(firstClaim.item.id, highPriority.id);
  assert.equal(firstClaim.item.priority, "P0");

  const secondClaim = runQueue(["claim-copied", "--assignee", "codex"], env);
  assert.equal(secondClaim.claimed, true);
  assert.equal(secondClaim.item.id, lowPriority.id);
  assert.equal(secondClaim.item.priority, "P2");
});

test("claim-copied only claims tasks for the specified assignee", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-queue-"));
  const queueFile = path.join(tempDir, "agent-queue.json");
  const env = { CONNECT_AI_AGENT_QUEUE: queueFile };

  const codexTask = runQueue([
    "add",
    "--assignee", "codex",
    "--priority", "P1",
    "--title", "Codex copied task",
    "--prompt", "Codex task.",
    ...contractArgs({ executor: "codex", file: "scripts/codex-copied.js" }),
  ], env).item;

  const hermesTask = runQueue([
    "add",
    "--assignee", "hermes",
    "--priority", "P1",
    "--title", "Hermes copied task",
    "--prompt", "Hermes task.",
  ], env).item;

  runQueue(["update", "--id", codexTask.id, "--status", "copied"], env);
  runQueue(["update", "--id", hermesTask.id, "--status", "copied"], env);

  const claimResult = runQueue(["claim-copied", "--assignee", "codex"], env);
  assert.equal(claimResult.claimed, true);
  assert.equal(claimResult.item.id, codexTask.id);
  assert.equal(claimResult.item.assignee, "codex");

  const hermesStillCopied = runQueue(["list", "--status", "copied"], env);
  assert.equal(hermesStillCopied.items.length, 1);
  assert.equal(hermesStillCopied.items[0].id, hermesTask.id);
});

test("claim-copied returns no task when no copied tasks exist", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-queue-"));
  const queueFile = path.join(tempDir, "agent-queue.json");
  const env = { CONNECT_AI_AGENT_QUEUE: queueFile };

  const claimResult = runQueue(["claim-copied", "--assignee", "codex"], env);

  assert.equal(claimResult.success, true);
  assert.equal(claimResult.claimed, false);
  assert.equal(claimResult.item, null);
  assert.ok(claimResult.message.includes("No copied task"));
});

test("MCP server exposes task_claim_copied for recovery", () => {
  const serverSource = fs.readFileSync(path.join(__dirname, "..", "mcp", "server.js"), "utf8");
  assert.match(serverSource, /server\.registerTool\(\s*["']task_claim_copied["']/);
  assert.match(serverSource, /["']claim-copied["']/);
});

test("queue lock recovers stale corrupt lock files instead of timing out", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-queue-"));
  const queueFile = path.join(tempDir, "agent-queue.json");
  const lockFile = `${queueFile}.lock`;
  const env = { CONNECT_AI_AGENT_QUEUE: queueFile };
  fs.mkdirSync(tempDir, { recursive: true });
  fs.writeFileSync(lockFile, "{not-json", "utf8");
  const old = new Date(Date.now() - 120000);
  fs.utimesSync(lockFile, old, old);

  const result = runQueue([
    "add",
    "--assignee", "codex",
    "--priority", "P1",
    "--title", "Recover after corrupt lock",
    "--prompt", "Read-only lock recovery smoke.",
  ], env);

  assert.equal(result.success, true);
  assert.equal(result.item.title, "Recover after corrupt lock");
  assert.equal(fs.existsSync(lockFile), false);
});
