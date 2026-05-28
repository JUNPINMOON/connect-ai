#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const test = require("node:test");

const queueCli = path.join(__dirname, "agent-queue.js");
const workerCli = path.join(__dirname, "local-llm-worker.js");

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

test("local LLM worker claims a queued smoke item and leaves READY_FOR_VERIFICATION evidence", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-local-llm-worker-"));
  const queueFile = path.join(tempDir, "agent-queue.json");
  const runtimeDir = path.join(tempDir, "runtime");
  const targetFile = path.join(tempDir, "target.md");
  const fakeExecutor = path.join(tempDir, "fake-local-llm-executor.js");
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(targetFile, "read-only target\n", "utf8");
  fs.writeFileSync(fakeExecutor, [
    "\"use strict\";",
    "const fs = require('node:fs');",
    "function arg(name) { const idx = process.argv.indexOf('--' + name); return idx === -1 ? '' : process.argv[idx + 1] || ''; }",
    "const item = JSON.parse(fs.readFileSync(arg('queue-item-file'), 'utf8'));",
    "console.log(JSON.stringify({",
    "  success: true,",
    "  status: 'READY_FOR_VERIFICATION',",
    "  executor: 'local-llm',",
    "  model: 'fake-local',",
    "  receivedId: item.id,",
    "  filesChanged: [],",
    "  commandsRun: ['fake local smoke'],",
    "  unresolvedFailures: [],",
    "  evidence: 'fake local smoke evidence'",
    "}));",
    "",
  ].join("\n"), "utf8");

  const env = {
    CONNECT_AI_AGENT_QUEUE: queueFile,
    CONNECT_AI_COMPANY_DIR: runtimeDir,
  };
  const added = runJson(queueCli, [
    "add",
    "--assignee", "local-llm",
    "--priority", "P2",
    "--title", "Local smoke classify",
    "--prompt", "Read-only classify this short non-secret note.",
    "--risk", "Green",
    "--risk-class", "Green",
    "--executor", "local-llm",
    "--reviewer", "pending-s7",
    "--intent", "queue-dispatch-local-llm",
    "--worker-class", "local-smoke",
    "--can-write", "false",
    "--file", targetFile,
    "--write-scope", targetFile,
    "--expected-test", "local smoke evidence exists",
    "--rollback-path", "no repo writes",
  ], env).item;

  const result = runJson(workerCli, [
    "--worker", "local-llm-test",
    "--id", added.id,
    "--executor-command", process.execPath,
    "--executor-arg", fakeExecutor,
  ], env);

  assert.equal(result.success, true);
  assert.equal(result.claimed, true);
  assert.equal(result.status, "ready_for_verification");
  assert.match(result.resultSummary, /READY_FOR_VERIFICATION/);
  assert.ok(fs.existsSync(result.dispatchLogPath));
  assert.match(fs.readFileSync(result.dispatchLogPath, "utf8"), /fake local smoke evidence/);

  const queue = JSON.parse(fs.readFileSync(queueFile, "utf8"));
  assert.equal(queue.find((item) => item.id === added.id).status, "ready_for_verification");
  assert.equal(queue.find((item) => item.id === added.id).agentOsStatus, "READY_FOR_VERIFICATION");
});

test("local LLM worker blocks silent file mutations despite successful executor output", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-local-llm-worker-guard-"));
  const queueFile = path.join(tempDir, "agent-queue.json");
  const runtimeDir = path.join(tempDir, "runtime");
  const targetFile = path.join(tempDir, "target.js");
  const fakeExecutor = path.join(tempDir, "fake-local-llm-sneaky-executor.js");
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(targetFile, "function target() { return true; }\n", "utf8");
  fs.writeFileSync(fakeExecutor, [
    "\"use strict\";",
    "const fs = require('node:fs');",
    "function arg(name) { const idx = process.argv.indexOf('--' + name); return idx === -1 ? '' : process.argv[idx + 1] || ''; }",
    "const item = JSON.parse(fs.readFileSync(arg('queue-item-file'), 'utf8'));",
    "fs.appendFileSync(item.writeScope[0], '// sneaky local worker mutation\\n', 'utf8');",
    "console.log(JSON.stringify({",
    "  success: true,",
    "  status: 'READY_FOR_VERIFICATION',",
    "  executor: 'local-llm',",
    "  model: 'fake-local',",
    "  filesChanged: [],",
    "  commandsRun: ['fake local smoke claimed no write'],",
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
    "--assignee", "local-llm",
    "--priority", "P2",
    "--title", "Local smoke must not write",
    "--prompt", "Read-only classify this short non-secret note.",
    "--risk", "Green",
    "--risk-class", "Green",
    "--executor", "local-llm",
    "--reviewer", "pending-s7",
    "--worker-class", "local-smoke",
    "--can-write", "false",
    "--file", targetFile,
    "--write-scope", targetFile,
    "--expected-test", "local worker blocks silent file mutation",
    "--rollback-path", "restore target file",
  ], env).item;

  const result = runRaw(workerCli, [
    "--worker", "local-llm-test",
    "--id", added.id,
    "--executor-command", process.execPath,
    "--executor-arg", fakeExecutor,
  ], env);

  assert.equal(result.exitCode, 1);
  assert.equal(result.parsed.success, false);
  assert.equal(result.parsed.status, "blocked");
  assert.match(result.parsed.resultSummary, /NO_WRITE_WORKER_MODIFIED_FILES/);
  const queue = JSON.parse(fs.readFileSync(queueFile, "utf8"));
  const item = queue.find((candidate) => candidate.id === added.id);
  assert.equal(item.status, "blocked");
  assert.match(fs.readFileSync(targetFile, "utf8"), /sneaky local worker mutation/);
});

test("local LLM worker blocks executor template echo evidence", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-local-llm-worker-template-"));
  const queueFile = path.join(tempDir, "agent-queue.json");
  const runtimeDir = path.join(tempDir, "runtime");
  const targetFile = path.join(tempDir, "target.md");
  const fakeExecutor = path.join(tempDir, "fake-local-llm-template-executor.js");
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(targetFile, "read-only target\n", "utf8");
  fs.writeFileSync(fakeExecutor, [
    "\"use strict\";",
    "console.log(JSON.stringify({",
    "  success: true,",
    "  status: 'READY_FOR_VERIFICATION',",
    "  executor: 'local-llm',",
    "  model: 'fake-local',",
    "  filesChanged: ['C:\\\\Users\\\\mjb58\\\\connect-ai-runtime\\\\company\\\\s5-dispatch\\\\fake.txt'],",
    "  commandsRun: [],",
    "  unresolvedFailures: [],",
    "  evidence: 'short current-run evidence'",
    "}));",
    "",
  ].join("\n"), "utf8");

  const env = {
    CONNECT_AI_AGENT_QUEUE: queueFile,
    CONNECT_AI_COMPANY_DIR: runtimeDir,
  };
  const added = runJson(queueCli, [
    "add",
    "--assignee", "local-llm",
    "--priority", "P2",
    "--title", "Local smoke template echo must block",
    "--prompt", "Read-only classify this short non-secret note.",
    "--risk", "Green",
    "--risk-class", "Green",
    "--executor", "local-llm",
    "--reviewer", "pending-s7",
    "--worker-class", "local-smoke",
    "--can-write", "false",
    "--file", targetFile,
    "--write-scope", targetFile,
    "--expected-test", "template echo evidence is blocked",
    "--rollback-path", "no repo writes",
  ], env).item;

  const result = runRaw(workerCli, [
    "--worker", "local-llm-test",
    "--id", added.id,
    "--executor-command", process.execPath,
    "--executor-arg", fakeExecutor,
  ], env);

  assert.equal(result.exitCode, 1);
  assert.equal(result.parsed.success, false);
  assert.equal(result.parsed.status, "blocked");
  assert.match(result.parsed.resultSummary, /LOCAL_LLM_TEMPLATE_ECHO_EVIDENCE/);
  const queue = JSON.parse(fs.readFileSync(queueFile, "utf8"));
  const item = queue.find((candidate) => candidate.id === added.id);
  assert.equal(item.status, "blocked");
});
