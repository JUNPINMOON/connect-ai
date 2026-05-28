#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const test = require("node:test");

const queueCli = path.join(__dirname, "agent-queue.js");
const runQueueCli = path.join(__dirname, "run-queue.js");
const runner = require("./run-queue.js");

function runJson(script, args, env) {
  const output = execFileSync(process.execPath, [script, ...args], {
    cwd: path.resolve(__dirname, ".."),
    env: { ...process.env, ...env },
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  return JSON.parse(output);
}

function addTask(args, env) {
  return runJson(queueCli, ["add", ...args], env).item;
}

test("serial run-queue skips Red and approval-required tasks before auto execution", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-run-queue-policy-"));
  const queueFile = path.join(tempDir, "agent-queue.json");
  const env = { CONNECT_AI_AGENT_QUEUE: queueFile };

  const red = addTask([
    "--assignee", "codex",
    "--priority", "P0",
    "--title", "Risky repo write",
    "--prompt", "Modify protected files after approval.",
    "--risk", "Red",
    "--risk-class", "Red",
    "--file", "src/extension.ts",
  ], env);
  const approval = addTask([
    "--assignee", "codex",
    "--priority", "P0",
    "--title", "Human approval gated write",
    "--prompt", "Modify release state only after human approval.",
    "--risk", "Yellow",
    "--risk-class", "Yellow",
    "--approval-required", "true",
    "--file", "package.json",
  ], env);
  const forbidden = addTask([
    "--assignee", "codex",
    "--priority", "P0",
    "--title", "Forbidden vault write",
    "--prompt", "Modify the vault directly.",
    "--risk", "Yellow",
    "--risk-class", "Yellow",
    "--write-scope", "C:\\Users\\mjb58\\connect-ai-vault\\notes\\bad.md",
    "--forbidden-path", "C:\\Users\\mjb58\\connect-ai-vault",
  ], env);
  const safe = addTask([
    "--assignee", "local-llm",
    "--priority", "P2",
    "--title", "Green local smoke",
    "--prompt", "Read-only smoke classification. Do not edit files.",
    "--risk", "Green",
    "--risk-class", "Green",
    "--file", "notes/smoke.md",
    "--write-scope", "notes/smoke.md",
    "--expected-test", "local smoke evidence exists",
    "--rollback-path", "no repo writes",
    "--executor", "local-llm",
    "--reviewer", "pending-s7",
    "--can-write", "false",
  ], env);

  const dry = runJson(runQueueCli, [], env);
  assert.equal(dry.mode, "dry-run");
  assert.deepEqual(dry.results.map((item) => item.id), [safe.id]);
  assert.equal(dry.results.some((item) => item.id === red.id), false);
  assert.equal(dry.results.some((item) => item.id === approval.id), false);
  assert.equal(dry.results.some((item) => item.id === forbidden.id), false);
});

test("serial run-queue skips queued tasks missing required automation contract fields", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-run-queue-contract-"));
  const queueFile = path.join(tempDir, "agent-queue.json");
  const env = { CONNECT_AI_AGENT_QUEUE: queueFile };

  const incomplete = addTask([
    "--assignee", "codex",
    "--priority", "P1",
    "--title", "Ambiguous code task",
    "--prompt", "Modify whatever is needed.",
    "--risk", "Yellow",
  ], env);
  const complete = addTask([
    "--assignee", "codex",
    "--priority", "P2",
    "--title", "Guarded code task",
    "--prompt", "Modify one scoped file.",
    "--risk", "Yellow",
    "--risk-class", "Yellow",
    "--file", "scripts/example.js",
    "--write-scope", "scripts/example.js",
    "--expected-test", "node --test scripts/example.test.js",
    "--rollback-path", "revert scripts/example.js",
    "--executor", "codex",
    "--reviewer", "pending-s7",
  ], env);

  const dry = runJson(runQueueCli, [], env);
  assert.equal(dry.mode, "dry-run");
  assert.deepEqual(dry.results.map((item) => item.id), [complete.id]);
  assert.equal(dry.results.some((item) => item.id === incomplete.id), false);
});

test("serial runner routes verifier tasks through reviewer worker", () => {
  assert.equal(path.basename(runner.workerScriptFor({ assignee: "gemini", role: "verifier", intent: "verification" })), "google-reviewer-worker.js");
  assert.equal(path.basename(runner.workerScriptFor({ assignee: "antigravity", role: "verifier", intent: "verification" })), "google-reviewer-worker.js");
  assert.equal(path.basename(runner.workerScriptFor({ assignee: "gemini", role: "reviewer", intent: "queue-dispatch-gemini" })), "gemini-worker.js");
});

test("serial runner treats blocked worker status as failed regardless of case", () => {
  assert.equal(typeof runner.workerRunFailed, "function");
  assert.equal(runner.workerRunFailed({ status: "BLOCKED" }), true);
  assert.equal(runner.workerRunFailed({ status: "blocked", success: true }), true);
  assert.equal(runner.workerRunFailed({ status: "failed", success: true }), true);
  assert.equal(runner.workerRunFailed({ status: "READY_FOR_VERIFICATION", success: true }), false);
});
