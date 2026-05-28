#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const test = require("node:test");

const queueCli = path.join(__dirname, "agent-queue.js");
const workerCli = path.join(__dirname, "gemini-worker.js");
const runQueueCli = path.join(__dirname, "run-queue.js");

function runJson(script, args, env) {
  const output = execFileSync(process.execPath, [script, ...args], {
    cwd: path.resolve(__dirname, ".."),
    env: { ...process.env, ...env },
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  return JSON.parse(output);
}

function runRaw(script, args, env) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: path.resolve(__dirname, ".."),
    env: { ...process.env, ...env },
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    windowsHide: true,
  });
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout || "",
    parsed: result.stdout ? JSON.parse(result.stdout) : null,
  };
}

test("Gemini worker uses gemini-executor contract and leaves READY_FOR_VERIFICATION evidence", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-gemini-worker-"));
  const queueFile = path.join(tempDir, "agent-queue.json");
  const runtimeDir = path.join(tempDir, "runtime");
  const targetFile = path.join(tempDir, "target.md");
  const fakeExecutor = path.join(tempDir, "fake-gemini-executor.js");
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(targetFile, "read-only target\n", "utf8");
  fs.writeFileSync(fakeExecutor, [
    "\"use strict\";",
    "function arg(name) { const idx = process.argv.indexOf('--' + name); return idx === -1 ? '' : process.argv[idx + 1] || ''; }",
    "const model = arg('model');",
    "console.log(JSON.stringify({",
    "  status: 'READY_FOR_VERIFICATION',",
    "  executor: 'gemini',",
    "  requestedModel: model,",
    "  observedModel: model,",
    "  filesChanged: [],",
    "  commandsRun: ['fake gemini executor --model ' + model],",
    "  unresolvedFailures: [],",
    "  evidence: 'fake gemini evidence for ' + model",
    "}));",
    "",
  ].join("\n"), "utf8");

  const env = {
    CONNECT_AI_AGENT_QUEUE: queueFile,
    CONNECT_AI_COMPANY_DIR: runtimeDir,
  };
  const added = runJson(queueCli, [
    "add",
    "--assignee", "gemini",
    "--priority", "P2",
    "--title", "Read-only Gemini model-specific review",
    "--prompt", "Read-only review only.\nGemini model: gemini-2.5-pro\nDo not edit files.",
    "--risk", "Green",
    "--risk-class", "Green",
    "--executor", "gemini",
    "--reviewer", "pending-s7",
    "--intent", "queue-dispatch-gemini",
    "--worker-class", "reviewer",
    "--can-write", "false",
    "--file", targetFile,
    "--write-scope", targetFile,
    "--expected-test", "Gemini executor returns requestedModel and observedModel evidence",
    "--rollback-path", "no repo writes",
  ], env).item;

  const result = runJson(workerCli, [
    "--worker", "gemini-test",
    "--id", added.id,
    "--executor-command", process.execPath,
    "--executor-arg", fakeExecutor,
  ], env);

  assert.equal(result.success, true);
  assert.equal(result.claimed, true);
  assert.equal(result.status, "ready_for_verification");
  assert.match(result.resultSummary, /READY_FOR_VERIFICATION/);
  assert.match(result.resultSummary, /gemini-2\.5-pro/);
  assert.ok(fs.existsSync(result.dispatchLogPath));
  assert.match(fs.readFileSync(result.dispatchLogPath, "utf8"), /fake gemini evidence/);

  const queue = JSON.parse(fs.readFileSync(queueFile, "utf8"));
  const item = queue.find((candidate) => candidate.id === added.id);
  assert.equal(item.status, "ready_for_verification");
  assert.equal(item.agentOsStatus, "READY_FOR_VERIFICATION");
  assert.notEqual(item.status, "done");
});

test("run-queue executes a queued Gemini item through the Gemini worker", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-gemini-run-queue-"));
  const queueFile = path.join(tempDir, "agent-queue.json");
  const runtimeDir = path.join(tempDir, "runtime");
  const targetFile = path.join(tempDir, "target.md");
  const fakeExecutor = path.join(tempDir, "fake-gemini-executor.js");
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(targetFile, "read-only target\n", "utf8");
  fs.writeFileSync(fakeExecutor, [
    "\"use strict\";",
    "function arg(name) { const idx = process.argv.indexOf('--' + name); return idx === -1 ? '' : process.argv[idx + 1] || ''; }",
    "const model = arg('model');",
    "console.log(JSON.stringify({",
    "  status: 'READY_FOR_VERIFICATION',",
    "  executor: 'gemini',",
    "  requestedModel: model,",
    "  observedModel: model,",
    "  filesChanged: [],",
    "  commandsRun: ['fake run-queue gemini --model ' + model],",
    "  unresolvedFailures: [],",
    "  evidence: 'fake run-queue gemini evidence'",
    "}));",
    "",
  ].join("\n"), "utf8");

  const env = {
    CONNECT_AI_AGENT_QUEUE: queueFile,
    CONNECT_AI_COMPANY_DIR: runtimeDir,
  };
  const added = runJson(queueCli, [
    "add",
    "--assignee", "gemini",
    "--priority", "P2",
    "--title", "Read-only Gemini run-queue review",
    "--prompt", "Read-only review only.\nGemini model: gemini-2.5-pro\nDo not edit files.",
    "--risk", "Green",
    "--risk-class", "Green",
    "--executor", "gemini",
    "--reviewer", "pending-s7",
    "--worker-class", "reviewer",
    "--can-write", "false",
    "--file", targetFile,
    "--write-scope", targetFile,
    "--expected-test", "run-queue reaches Gemini worker",
    "--rollback-path", "no repo writes",
  ], env).item;

  const result = runJson(runQueueCli, [
    "--execute",
    "--only", "gemini",
    "--id", added.id,
    "--max", "1",
    "--executor-command", process.execPath,
    "--executor-arg", fakeExecutor,
  ], env);

  assert.equal(result.mode, "execute");
  assert.equal(result.processed, 1);
  assert.deepEqual(result.results.map((item) => item.assignee), ["gemini"]);
  assert.equal(result.results[0].status, "ready_for_verification");

  const queue = JSON.parse(fs.readFileSync(queueFile, "utf8"));
  const item = queue.find((candidate) => candidate.id === added.id);
  assert.equal(item.status, "ready_for_verification");
  assert.equal(item.agentOsStatus, "READY_FOR_VERIFICATION");
});

test("run-queue blocks Gemini worker when no-write executor silently mutates scoped files", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-gemini-run-queue-guard-"));
  const queueFile = path.join(tempDir, "agent-queue.json");
  const runtimeDir = path.join(tempDir, "runtime");
  const targetFile = path.join(tempDir, "target.js");
  const fakeExecutor = path.join(tempDir, "fake-gemini-sneaky-executor.js");
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(targetFile, "function target() { return true; }\n", "utf8");
  fs.writeFileSync(fakeExecutor, [
    "\"use strict\";",
    "const fs = require('node:fs');",
    "function arg(name) { const idx = process.argv.indexOf('--' + name); return idx === -1 ? '' : process.argv[idx + 1] || ''; }",
    "const model = arg('model');",
    "const item = JSON.parse(fs.readFileSync(arg('queue-item-file'), 'utf8'));",
    "fs.appendFileSync(item.writeScope[0], '// sneaky gemini worker mutation\\n', 'utf8');",
    "console.log(JSON.stringify({",
    "  status: 'READY_FOR_VERIFICATION',",
    "  executor: 'gemini',",
    "  requestedModel: model,",
    "  observedModel: model,",
    "  filesChanged: [],",
    "  commandsRun: ['fake gemini claimed no write --model ' + model],",
    "  unresolvedFailures: [],",
    "  evidence: 'claimed no files changed'",
    "}));",
    "",
  ].join("\n"), "utf8");

  const env = {
    CONNECT_AI_AGENT_QUEUE: queueFile,
    CONNECT_AI_COMPANY_DIR: runtimeDir,
  };
  const added = runJson(queueCli, [
    "add",
    "--assignee", "gemini",
    "--priority", "P2",
    "--title", "Read-only Gemini run-queue must not write",
    "--prompt", "Read-only review only.\nGemini model: gemini-2.5-flash\nDo not edit files.",
    "--risk", "Green",
    "--risk-class", "Green",
    "--executor", "gemini",
    "--reviewer", "pending-s7",
    "--worker-class", "reviewer",
    "--can-write", "false",
    "--file", targetFile,
    "--write-scope", targetFile,
    "--expected-test", "run-queue blocks silent Gemini mutation",
    "--rollback-path", "restore target file",
  ], env).item;

  const result = runRaw(runQueueCli, [
    "--execute",
    "--only", "gemini",
    "--id", added.id,
    "--max", "1",
    "--executor-command", process.execPath,
    "--executor-arg", fakeExecutor,
  ], env);

  assert.equal(result.exitCode, 1);
  assert.equal(result.parsed.mode, "execute");
  assert.equal(result.parsed.results[0].status, "blocked");
  const queue = JSON.parse(fs.readFileSync(queueFile, "utf8"));
  const item = queue.find((candidate) => candidate.id === added.id);
  assert.equal(item.status, "blocked");
  assert.match(item.resultSummary, /NO_WRITE_WORKER_MODIFIED_FILES/);
  assert.match(fs.readFileSync(targetFile, "utf8"), /sneaky gemini worker mutation/);
});

test("package agent:gemini script points at the Gemini worker path", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
  assert.equal(pkg.scripts["agent:gemini"], "node scripts/gemini-worker.js");
});
