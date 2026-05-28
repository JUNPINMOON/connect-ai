#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "..");
const loopPath = path.join(__dirname, "agent-loop.js");
const queueCliPath = path.join(__dirname, "agent-queue.js");

function runNode(script, args, env) {
  const output = execFileSync(process.execPath, [script, ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  return JSON.parse(output);
}

test("agent-loop status classifies both Claude and Codex as autoable", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-agent-loop-"));
  const queueFile = path.join(tempDir, "agent-queue.json");
  const env = { CONNECT_AI_AGENT_QUEUE: queueFile };

  runNode(queueCliPath, [
    "add", "--assignee", "claude", "--priority", "P1", "--title", "Claude review", "--prompt", "Review read-only.",
  ], env);
  runNode(queueCliPath, [
    "add", "--assignee", "codex", "--priority", "P1", "--title", "Codex build", "--prompt", "Build the next slice.",
  ], env);

  const result = runNode(loopPath, ["status"], env);

  assert.equal(result.success, true);
  assert.equal(result.loop.state, "READY_TO_DISPATCH");
  assert.ok(result.loop.dispatch.some((item) => item.assignee === "claude" && item.mode === "autoable"));
  assert.ok(result.loop.dispatch.some((item) => item.assignee === "codex" && item.mode === "autoable"));
});

test("agent-loop holds execution when policy blocks an incomplete residual-risk result", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-agent-loop-"));
  const queueFile = path.join(tempDir, "agent-queue.json");
  const env = { CONNECT_AI_AGENT_QUEUE: queueFile };

  const audited = runNode(queueCliPath, [
    "add", "--assignee", "claude", "--priority", "P1", "--title", "Risky review", "--prompt", "Review.",
  ], env).item;
  runNode(queueCliPath, [
    "update", "--id", audited.id, "--status", "done", "--result-summary", "READY WITH RISKS. 후속 판단 필요.",
  ], env);
  runNode(queueCliPath, [
    "add", "--assignee", "claude", "--priority", "P2", "--title", "Next Claude", "--prompt", "Run later.",
  ], env);

  const result = runNode(loopPath, ["once", "--auto-escalate-risks", "--run-claude"], env);

  assert.equal(result.success, true);
  assert.ok(result.actions.some((action) => action.type === "held" && action.reason === "attention_required"));

  const queue = runNode(queueCliPath, ["list"], env).items;
  const blocked = queue.find((item) => item.id === audited.id);
  assert.equal(blocked.status, "blocked");
  assert.match(blocked.resultSummary, /Missing required evidence/);
  const decisionTasks = queue.filter((item) => item.assignee === "hermes" && item.prompt.includes(`[decision-source:${audited.id}]`));
  assert.equal(decisionTasks.length, 0);
});

test("agent-loop can run one Claude worker task when no decision request is pending", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-agent-loop-"));
  const queueFile = path.join(tempDir, "agent-queue.json");
  const fakeClaude = path.join(tempDir, process.platform === "win32" ? "fake-claude.cmd" : "fake-claude");
  const env = { CONNECT_AI_AGENT_QUEUE: queueFile };

  if (process.platform === "win32") {
    fs.writeFileSync(fakeClaude, "@echo off\r\necho Claude loop worker completed.\r\n", "utf8");
  } else {
    fs.writeFileSync(fakeClaude, "#!/usr/bin/env sh\necho 'Claude loop worker completed.'\n", "utf8");
    fs.chmodSync(fakeClaude, 0o755);
  }

  const task = runNode(queueCliPath, [
    "add",
    "--assignee", "claude",
    "--priority", "P2",
    "--risk", "Green",
    "--title", "Claude loop task",
    "--prompt", "Return a concise result.",
    "--write-scope", "scripts/agent-loop.js",
    "--expected-test", "node --test scripts/agent-loop.test.js",
    "--rollback-path", "Remove this isolated test task from the temp queue.",
    "--executor", "claude",
    "--reviewer", "gemini",
  ], env).item;

  const result = runNode(loopPath, [
    "once", "--run-claude", "--claude-bin", fakeClaude, "--max-turns", "1", "--output-format", "text",
  ], env);

  assert.equal(result.success, true);
  assert.ok(result.actions.some((action) => action.type === "claude_worker" && action.result.success));

  const queue = runNode(queueCliPath, ["list"], env).items;
  const updated = queue.find((item) => item.id === task.id);
  assert.equal(updated.status, "ready_for_verification");
  assert.match(updated.resultSummary, /Claude loop worker completed/);
});
