#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const test = require("node:test");
const { spawnSync } = require("node:child_process");
const dispatcher = require("./queue-dispatcher.js");
const geminiExecutor = require("./gemini-executor.js");

const dispatcherPath = path.join(__dirname, "queue-dispatcher.js");

function runDispatcher(args, env = {}) {
  const output = execFileSync(process.execPath, [dispatcherPath, ...args], {
    cwd: path.resolve(__dirname, ".."),
    env: { ...process.env, ...env },
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  return JSON.parse(output);
}

function runDispatcherRaw(args, env = {}) {
  const result = spawnSync(process.execPath, [dispatcherPath, ...args], {
    cwd: path.resolve(__dirname, ".."),
    env: { ...process.env, ...env },
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    windowsHide: true,
  });
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout || "",
    stderr: result.stderr || result.error?.message || "",
    parsed: result.stdout ? JSON.parse(result.stdout) : null,
  };
}

function writeFakeExecutor(filePath, label) {
  fs.writeFileSync(filePath, [
    "\"use strict\";",
    "const fs = require('node:fs');",
    "function arg(name) { const idx = process.argv.indexOf('--' + name); return idx === -1 ? '' : process.argv[idx + 1] || ''; }",
    "const item = JSON.parse(fs.readFileSync(arg('queue-item-file'), 'utf8'));",
    "const target = item.writeScope[0];",
    "const canWrite = item.canWrite === true;",
    `if (canWrite) fs.appendFileSync(target, '// hello world from fake ${label} executor\\n', 'utf8');`,
    "console.log(JSON.stringify({",
    "  status: 'READY_FOR_VERIFICATION',",
    "  executor: item.executor,",
    "  receivedId: item.id,",
    "  filesChanged: canWrite ? [target] : [],",
    `  commandsRun: [canWrite ? 'fake ${label} executor wrote scoped runtime comment' : 'fake ${label} executor returned read-only evidence'],`,
    "  unresolvedFailures: [],",
    "  evidence: canWrite ? 'scoped runtime comment written' : 'read-only executor evidence; no files changed'",
    "}));",
    "",
  ].join("\n"), "utf8");
}

function writeFakeExecutorJson(filePath, payload) {
  fs.writeFileSync(filePath, [
    "\"use strict\";",
    `console.log(JSON.stringify(${JSON.stringify(payload, null, 2)}));`,
    "",
  ].join("\n"), "utf8");
}

function writeSneakyNoWriteExecutor(filePath) {
  fs.writeFileSync(filePath, [
    "\"use strict\";",
    "const fs = require('node:fs');",
    "function arg(name) { const idx = process.argv.indexOf('--' + name); return idx === -1 ? '' : process.argv[idx + 1] || ''; }",
    "const item = JSON.parse(fs.readFileSync(arg('queue-item-file'), 'utf8'));",
    "fs.appendFileSync(item.writeScope[0], '// sneaky no-write mutation\\n', 'utf8');",
    "console.log(JSON.stringify({",
    "  status: 'READY_FOR_VERIFICATION',",
    "  executor: item.executor,",
    "  filesChanged: [],",
    "  commandsRun: ['fake no-write executor claimed no file changes'],",
    "  unresolvedFailures: [],",
    "  evidence: 'claimed no files changed despite touching the scoped file'",
    "}));",
    "",
  ].join("\n"), "utf8");
}

function writeSneakyWriteExecutor(filePath) {
  fs.writeFileSync(filePath, [
    "\"use strict\";",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "function arg(name) { const idx = process.argv.indexOf('--' + name); return idx === -1 ? '' : process.argv[idx + 1] || ''; }",
    "const item = JSON.parse(fs.readFileSync(arg('queue-item-file'), 'utf8'));",
    "const target = item.writeScope[0];",
    "const sibling = path.join(path.dirname(target), 'sibling-outside-write-scope.js');",
    "fs.appendFileSync(sibling, '// sneaky write outside scope\\n', 'utf8');",
    "console.log(JSON.stringify({",
    "  status: 'READY_FOR_VERIFICATION',",
    "  executor: 'codex',",
    "  filesChanged: [target],",
    "  commandsRun: ['fake codex executor claimed only scoped file changed'],",
    "  unresolvedFailures: [],",
    "  evidence: 'claimed only write scope changed despite touching sibling file'",
    "}));",
    "",
  ].join("\n"), "utf8");
}

function writeClassifiedArtifactExecutor(filePath) {
  fs.writeFileSync(filePath, [
    "\"use strict\";",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "function arg(name) { const idx = process.argv.indexOf('--' + name); return idx === -1 ? '' : process.argv[idx + 1] || ''; }",
    "const evidencePath = path.join(path.dirname(arg('result-file')), 'classified-evidence.json');",
    "fs.writeFileSync(evidencePath, JSON.stringify({ evidence: 'classified runtime artifact' }), 'utf8');",
    "console.log(JSON.stringify({",
    "  status: 'READY_FOR_VERIFICATION',",
    "  executor: 'gemini',",
    "  filesChanged: [evidencePath],",
    "  commandsRun: ['fake no-write executor wrote classified runtime evidence'],",
    "  unresolvedFailures: [],",
    "  evidence: evidencePath",
    "}));",
    "",
  ].join("\n"), "utf8");
}

function writeUnclassifiedArtifactExecutor(filePath) {
  fs.writeFileSync(filePath, [
    "\"use strict\";",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "function arg(name) { const idx = process.argv.indexOf('--' + name); return idx === -1 ? '' : process.argv[idx + 1] || ''; }",
    "const strayPath = path.join(path.dirname(arg('result-file')), 'unclassified-artifact.tmp');",
    "fs.writeFileSync(strayPath, 'unclassified generated output', 'utf8');",
    "console.log(JSON.stringify({",
    "  status: 'READY_FOR_VERIFICATION',",
    "  executor: 'local-llm',",
    "  filesChanged: [],",
    "  commandsRun: ['fake no-write executor hid an artifact'],",
    "  unresolvedFailures: [],",
    "  evidence: 'claimed no artifacts were created'",
    "}));",
    "",
  ].join("\n"), "utf8");
}

function createSmokeTarget(prefix) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-s4-dispatch-"));
  const queueFile = path.join(tempDir, "agent-queue.json");
  const runDir = path.join(tempDir, "company-runtime");
  const targetFile = path.join(runDir, `${prefix}-target.js`);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(targetFile, "function smoke() { return true; }\n", "utf8");
  return { tempDir, queueFile, runDir, targetFile };
}

test("dispatch creates a guarded queue item and records Antigravity read-only executor evidence", () => {
  const { tempDir, queueFile, runDir, targetFile } = createSmokeTarget("antigravity");
  const fakeExecutor = path.join(tempDir, "fake-antigravity-executor.js");
  writeFakeExecutor(fakeExecutor, "Antigravity");

  const result = runDispatcher([
    "dispatch",
    "--goal", "이 파일에 hello world 주석 추가",
    "--file", targetFile,
    "--risk", "Yellow",
    "--write-scope", targetFile,
    "--expected-test", "antigravity returns read-only evidence",
    "--expected-test", "queue item remains READY_FOR_VERIFICATION until verifier runs",
    "--rollback-path", `remove generated runtime smoke file ${targetFile}`,
    "--executor", "antigravity",
    "--reviewer", "pending-s7",
    "--run-dir", runDir,
    "--executor-command", process.execPath,
    "--executor-arg", fakeExecutor,
  ], { CONNECT_AI_AGENT_QUEUE: queueFile });

  assert.equal(result.success, true);
  assert.equal(result.queueItem.executor, "antigravity");
  assert.equal(result.queueItem.role, "reviewer");
  assert.match(result.queueItem.stopCondition, /retry budget|required evidence/i);
  assert.match(result.queueItem.approvalCondition, /credential|direct vault write|scope expansion/i);
  assert.ok(result.queueItem.evidenceRequired.includes("commands run"));
  assert.equal(result.queueItem.reviewer, "pending-s7");
  assert.equal(result.queueItem.risk, "Yellow");
  assert.equal(result.queueItem.riskClass, "Yellow");
  assert.deepEqual(result.queueItem.writeScope, [targetFile]);
  assert.ok(result.queueItem.forbiddenPaths.includes("C:\\Users\\mjb58\\connect-ai-vault"));
  assert.ok(result.queueItem.forbiddenPaths.includes("transport-audit"));
  assert.ok(result.queueItem.forbiddenPaths.includes("swarm-status"));
  assert.ok(result.queueItem.forbiddenPaths.includes("readiness"));
  assert.deepEqual(result.queueItem.expectedTests, [
    "antigravity returns read-only evidence",
    "queue item remains READY_FOR_VERIFICATION until verifier runs",
  ]);
  assert.match(result.queueItem.rollbackPath, /remove generated runtime smoke file/);
  assert.equal(result.queueItem.status, "ready_for_verification");
  assert.equal(result.queueItem.agentOsStatus, "READY_FOR_VERIFICATION");
  assert.equal(result.executor.exitCode, 0);
  assert.match(result.executor.stdout, /READY_FOR_VERIFICATION/);
  assert.ok(fs.existsSync(result.dispatchLogPath));
  assert.match(fs.readFileSync(result.dispatchLogPath, "utf8"), /fake-antigravity-executor/);
  assert.doesNotMatch(fs.readFileSync(targetFile, "utf8"), /hello world from fake Antigravity executor/);

  const queue = JSON.parse(fs.readFileSync(queueFile, "utf8"));
  assert.equal(queue.length, 1);
  assert.equal(queue[0].id, result.queueItem.id);
  assert.equal(queue[0].executor, "antigravity");
  assert.equal(queue[0].agentOsStatus, "READY_FOR_VERIFICATION");
});

test("dispatch supports Codex, Gemini, and local LLM executors through the same queue item contract", () => {
  for (const executor of ["codex", "gemini", "local-llm"]) {
    const { tempDir, queueFile, runDir, targetFile } = createSmokeTarget(executor);
    const fakeExecutor = path.join(tempDir, `fake-${executor}-executor.js`);
    writeFakeExecutor(fakeExecutor, executor);
    const result = runDispatcher([
      "dispatch",
      "--goal", executor === "codex" ? "code change: add scoped runtime comment" : `${executor} classification smoke`,
      "--file", targetFile,
      "--write-scope", targetFile,
      "--expected-test", "adapter returns READY_FOR_VERIFICATION evidence",
      "--rollback-path", `remove generated runtime smoke file ${targetFile}`,
      "--executor", executor,
      "--reviewer", "pending-s7",
      "--run-dir", runDir,
      "--executor-command", process.execPath,
      "--executor-arg", fakeExecutor,
    ], { CONNECT_AI_AGENT_QUEUE: queueFile });

    assert.equal(result.success, true);
    assert.equal(result.queueItem.executor, executor);
    assert.equal(result.queueItem.role, executor === "codex" ? "implementer" : executor === "local-llm" ? "local-smoke" : "reviewer");
    assert.match(result.queueItem.stopCondition, /retry budget|required evidence/i);
    assert.match(result.queueItem.approvalCondition, /credential|direct vault write|scope expansion/i);
    assert.ok(result.queueItem.evidenceRequired.includes("unresolved failures"));
    assert.equal(result.queueItem.status, "ready_for_verification");
    assert.equal(result.queueItem.agentOsStatus, "READY_FOR_VERIFICATION");
    assert.equal(result.queueItem.canWrite, executor === "codex");
    assert.deepEqual(result.queueItem.writeScope, [targetFile]);
    assert.ok(result.queueItem.forbiddenPaths.includes("C:\\Users\\mjb58\\connect-ai-vault"));
    if (executor === "codex") assert.match(fs.readFileSync(targetFile, "utf8"), new RegExp(`fake ${executor} executor`));
    else assert.doesNotMatch(fs.readFileSync(targetFile, "utf8"), new RegExp(`fake ${executor} executor`));
  }
});

test("dispatch blocks executor-reported BLOCKED results even when the process exits zero", () => {
  const { tempDir, queueFile, runDir, targetFile } = createSmokeTarget("blocked-contract");
  const fakeExecutor = path.join(tempDir, "fake-blocked-executor.js");
  writeFakeExecutorJson(fakeExecutor, {
    status: "BLOCKED",
    executor: "codex",
    reason: "MODEL_MISMATCH",
    filesChanged: [],
    commandsRun: ["fake executor returned blocked"],
    unresolvedFailures: ["MODEL_MISMATCH"],
    evidence: "Executor reported a contract failure.",
  });

  const result = runDispatcherRaw([
    "dispatch",
    "--goal", "code change: fake executor reports blocked",
    "--file", targetFile,
    "--write-scope", targetFile,
    "--expected-test", "blocked executor result must not become RFV",
    "--rollback-path", `remove generated runtime smoke file ${targetFile}`,
    "--executor", "codex",
    "--reviewer", "pending-s7",
    "--run-dir", runDir,
    "--executor-command", process.execPath,
    "--executor-arg", fakeExecutor,
  ], { CONNECT_AI_AGENT_QUEUE: queueFile });

  assert.equal(result.exitCode, 1);
  assert.equal(result.parsed.success, false);
  assert.equal(result.parsed.queueItem.status, "blocked");
  assert.match(result.parsed.queueItem.resultSummary, /MODEL_MISMATCH/);
});

test("dispatch blocks no-write executors that claim filesChanged evidence", () => {
  const { tempDir, queueFile, runDir, targetFile } = createSmokeTarget("no-write-claim");
  const fakeExecutor = path.join(tempDir, "fake-local-write-claim-executor.js");
  writeFakeExecutorJson(fakeExecutor, {
    status: "READY_FOR_VERIFICATION",
    executor: "local-llm",
    filesChanged: [targetFile],
    commandsRun: ["fake local executor claimed a write"],
    unresolvedFailures: [],
    evidence: "This should be blocked because local-llm has no write authority.",
  });

  const result = runDispatcherRaw([
    "dispatch",
    "--goal", "local smoke classification only",
    "--file", targetFile,
    "--write-scope", targetFile,
    "--expected-test", "local executor must remain read-only",
    "--rollback-path", `remove generated runtime smoke file ${targetFile}`,
    "--executor", "local-llm",
    "--reviewer", "pending-s7",
    "--run-dir", runDir,
    "--executor-command", process.execPath,
    "--executor-arg", fakeExecutor,
  ], { CONNECT_AI_AGENT_QUEUE: queueFile });

  assert.equal(result.exitCode, 1);
  assert.equal(result.parsed.success, false);
  assert.equal(result.parsed.queueItem.status, "blocked");
  assert.match(result.parsed.queueItem.resultSummary, /NO_WRITE_EXECUTOR_CLAIMED_FILES_CHANGED/);
});

test("dispatch blocks no-write executors that silently mutate scoped files", () => {
  const { tempDir, queueFile, runDir, targetFile } = createSmokeTarget("silent-mutation");
  const fakeExecutor = path.join(tempDir, "fake-silent-mutation-executor.js");
  writeSneakyNoWriteExecutor(fakeExecutor);

  const result = runDispatcherRaw([
    "dispatch",
    "--goal", "local smoke classification only",
    "--file", targetFile,
    "--write-scope", targetFile,
    "--expected-test", "local executor must not mutate scoped files",
    "--rollback-path", `remove generated runtime smoke file ${targetFile}`,
    "--executor", "local-llm",
    "--reviewer", "pending-s7",
    "--run-dir", runDir,
    "--executor-command", process.execPath,
    "--executor-arg", fakeExecutor,
  ], { CONNECT_AI_AGENT_QUEUE: queueFile });

  assert.equal(result.exitCode, 1);
  assert.equal(result.parsed.success, false);
  assert.equal(result.parsed.queueItem.status, "blocked");
  assert.match(result.parsed.queueItem.resultSummary, /NO_WRITE_EXECUTOR_MODIFIED_FILES/);
  assert.match(fs.readFileSync(targetFile, "utf8"), /sneaky no-write mutation/);
});

test("dispatch blocks write executors that silently mutate files outside write scope", () => {
  const { tempDir, queueFile, runDir, targetFile } = createSmokeTarget("write-scope-mutation");
  const fakeExecutor = path.join(tempDir, "fake-sneaky-write-executor.js");
  writeSneakyWriteExecutor(fakeExecutor);

  const result = runDispatcherRaw([
    "dispatch",
    "--goal", "code change: modify only the scoped runtime file",
    "--file", targetFile,
    "--write-scope", targetFile,
    "--expected-test", "codex executor must stay inside writeScope",
    "--rollback-path", `remove generated runtime smoke file ${targetFile}`,
    "--executor", "codex",
    "--reviewer", "pending-s7",
    "--run-dir", runDir,
    "--executor-command", process.execPath,
    "--executor-arg", fakeExecutor,
  ], { CONNECT_AI_AGENT_QUEUE: queueFile });

  assert.equal(result.exitCode, 1);
  assert.equal(result.parsed.success, false);
  assert.equal(result.parsed.queueItem.status, "blocked");
  assert.match(result.parsed.queueItem.resultSummary, /WRITE_SCOPE_VIOLATION/);
  assert.equal(fs.existsSync(path.join(runDir, "sibling-outside-write-scope.js")), true);
});

test("dispatch allows no-write executors to report classified runtime evidence artifacts", () => {
  const { tempDir, queueFile, runDir, targetFile } = createSmokeTarget("classified-artifact");
  const fakeExecutor = path.join(tempDir, "fake-classified-artifact-executor.js");
  writeClassifiedArtifactExecutor(fakeExecutor);

  const result = runDispatcher([
    "dispatch",
    "--goal", "Gemini model-specific architecture review",
    "--file", targetFile,
    "--write-scope", targetFile,
    "--expected-test", "gemini executor may write classified runtime evidence",
    "--rollback-path", `remove generated runtime smoke file ${targetFile}`,
    "--executor", "gemini",
    "--reviewer", "pending-s7",
    "--run-dir", runDir,
    "--executor-command", process.execPath,
    "--executor-arg", fakeExecutor,
  ], { CONNECT_AI_AGENT_QUEUE: queueFile });

  assert.equal(result.success, true);
  assert.equal(result.queueItem.status, "ready_for_verification");
  assert.match(result.queueItem.resultSummary, /classified-evidence\.json/);
  assert.equal(fs.existsSync(path.join(runDir, "classified-evidence.json")), true);
});

test("dispatch blocks unclassified no-write executor artifacts in the run directory", () => {
  const { tempDir, queueFile, runDir, targetFile } = createSmokeTarget("unclassified-artifact");
  const fakeExecutor = path.join(tempDir, "fake-unclassified-artifact-executor.js");
  writeUnclassifiedArtifactExecutor(fakeExecutor);

  const result = runDispatcherRaw([
    "dispatch",
    "--goal", "local smoke classification only",
    "--file", targetFile,
    "--write-scope", targetFile,
    "--expected-test", "no unclassified generated artifacts",
    "--rollback-path", `remove generated runtime smoke file ${targetFile}`,
    "--executor", "local-llm",
    "--reviewer", "pending-s7",
    "--run-dir", runDir,
    "--executor-command", process.execPath,
    "--executor-arg", fakeExecutor,
  ], { CONNECT_AI_AGENT_QUEUE: queueFile });

  assert.equal(result.exitCode, 1);
  assert.equal(result.parsed.success, false);
  assert.equal(result.parsed.queueItem.status, "blocked");
  assert.match(result.parsed.queueItem.resultSummary, /UNCLASSIFIED_EXECUTOR_ARTIFACTS/);
  assert.equal(fs.existsSync(path.join(runDir, "unclassified-artifact.tmp")), true);
});

test("local LLM executor prompt advertises read-only filesChanged evidence", () => {
  const { tempDir, queueFile, runDir, targetFile } = createSmokeTarget("local-readonly");
  const fakeExecutor = path.join(tempDir, "fake-local-readonly-executor.js");
  writeFakeExecutor(fakeExecutor, "local-readonly");

  const result = runDispatcher([
    "dispatch",
    "--goal", "local smoke classification only",
    "--file", targetFile,
    "--write-scope", targetFile,
    "--expected-test", "local executor reports read-only smoke evidence",
    "--rollback-path", `remove generated runtime smoke file ${targetFile}`,
    "--executor", "local-llm",
    "--reviewer", "pending-s7",
    "--run-dir", runDir,
    "--executor-command", process.execPath,
    "--executor-arg", fakeExecutor,
  ], { CONNECT_AI_AGENT_QUEUE: queueFile });

  const prompt = fs.readFileSync(result.promptFile, "utf8");
  assert.match(prompt, /"executor": "local-llm"/);
  assert.match(prompt, /"filesChanged": \[\]/);
});

test("auto routing sends comment/lint work to local LLM, code work to Codex, and design review to Antigravity", () => {
  const cases = [
    { goal: "comment classification for a short non-secret note", expected: "local-llm" },
    { goal: "code change: modify one runtime file", expected: "codex" },
    { goal: "architecture design review for model routing: explain whether local LLM should only handle comment/lint smoke", expected: "antigravity" },
  ];
  for (const route of cases) {
    const { tempDir, queueFile, runDir, targetFile } = createSmokeTarget(route.expected);
    const fakeExecutor = path.join(tempDir, `fake-${route.expected}-executor.js`);
    writeFakeExecutor(fakeExecutor, route.expected);
    const result = runDispatcher([
      "dispatch",
      "--goal", route.goal,
      "--file", targetFile,
      "--write-scope", targetFile,
      "--expected-test", "auto route returns READY_FOR_VERIFICATION evidence",
      "--rollback-path", `remove generated runtime smoke file ${targetFile}`,
      "--executor", "auto",
      "--run-dir", runDir,
      "--executor-command", process.execPath,
      "--executor-arg", fakeExecutor,
    ], { CONNECT_AI_AGENT_QUEUE: queueFile });
    assert.equal(result.queueItem.executor, route.expected);
  }
});

test("auto routing sends explicit cheap local review smoke to local LLM before Antigravity", () => {
  const { tempDir, queueFile, runDir, targetFile } = createSmokeTarget("cheap-local-review");
  const fakeExecutor = path.join(tempDir, "fake-cheap-local-review-executor.js");
  writeFakeExecutor(fakeExecutor, "cheap-local-review");

  const result = runDispatcher([
    "dispatch",
    "--goal", "cheap local architecture review smoke: classify whether this task needs a cloud reviewer",
    "--file", targetFile,
    "--write-scope", targetFile,
    "--expected-test", "cheap local smoke avoids Antigravity quota",
    "--rollback-path", `remove generated runtime smoke file ${targetFile}`,
    "--executor", "auto",
    "--run-dir", runDir,
    "--executor-command", process.execPath,
    "--executor-arg", fakeExecutor,
  ], { CONNECT_AI_AGENT_QUEUE: queueFile });

  assert.equal(result.queueItem.executor, "local-llm");
  assert.equal(result.queueItem.tokenBudget, "local-zero");
  assert.equal(result.queueItem.canWrite, false);
  assert.match(result.queueItem.prompt, /"executor": "local-llm"/);
});

test("model-specific Gemini tasks route to the Gemini executor with an explicit model", () => {
  const { tempDir, queueFile, runDir, targetFile } = createSmokeTarget("gemini");
  const fakeExecutor = path.join(tempDir, "fake-gemini-executor.js");
  writeFakeExecutor(fakeExecutor, "gemini");

  const result = runDispatcher([
    "dispatch",
    "--goal", "Gemini model-specific architecture review using gemini-2.5-pro",
    "--file", targetFile,
    "--write-scope", targetFile,
    "--expected-test", "Gemini executor receives explicit model route",
    "--rollback-path", `remove generated runtime smoke file ${targetFile}`,
    "--executor", "auto",
    "--gemini-model", "gemini-2.5-pro",
    "--run-dir", runDir,
    "--executor-command", process.execPath,
    "--executor-arg", fakeExecutor,
  ], { CONNECT_AI_AGENT_QUEUE: queueFile });

  assert.equal(result.queueItem.executor, "gemini");
  assert.equal(result.queueItem.tokenBudget, "medium");
  assert.match(result.queueItem.prompt, /Gemini model: gemini-2\.5-pro/);
});

test("model-specific Gemini tasks reject unstable Gemini 3 preview id", () => {
  const { tempDir, queueFile, runDir, targetFile } = createSmokeTarget("gemini3");
  const fakeExecutor = path.join(tempDir, "fake-gemini3-executor.js");
  writeFakeExecutor(fakeExecutor, "gemini3");

  const result = runDispatcherRaw([
    "dispatch",
    "--goal", "Gemini 3 Pro architecture review",
    "--file", targetFile,
    "--write-scope", targetFile,
    "--expected-test", "Gemini executor receives confirmed 3 model id",
    "--rollback-path", `remove generated runtime smoke file ${targetFile}`,
    "--executor", "auto",
    "--gemini-model", "gemini-3-pro-preview",
    "--run-dir", runDir,
    "--executor-command", process.execPath,
    "--executor-arg", fakeExecutor,
  ], { CONNECT_AI_AGENT_QUEUE: queueFile });

  assert.equal(result.exitCode, 1);
  assert.equal(result.parsed.success, false);
  assert.match(result.parsed.error, /Unsupported Gemini model: gemini-3-pro-preview/);
});

test("natural-language Gemini 3 Pro requests do not route to the Gemini executor", () => {
  const { tempDir, queueFile, runDir, targetFile } = createSmokeTarget("gemini3-natural");
  const fakeExecutor = path.join(tempDir, "fake-gemini3-natural-executor.js");
  writeFakeExecutor(fakeExecutor, "gemini3-natural");

  const result = runDispatcher([
    "dispatch",
    "--goal", "Gemini 3 Pro로 architecture routing review 해줘",
    "--file", targetFile,
    "--write-scope", targetFile,
    "--expected-test", "natural language model name routes to Gemini executor",
    "--rollback-path", `remove generated runtime smoke file ${targetFile}`,
    "--executor", "auto",
    "--run-dir", runDir,
    "--executor-command", process.execPath,
    "--executor-arg", fakeExecutor,
  ], { CONNECT_AI_AGENT_QUEUE: queueFile });

  assert.notEqual(result.queueItem.executor, "gemini");
  assert.doesNotMatch(result.queueItem.prompt, /Gemini model: gemini-3-pro-preview/);
});

test("Gemini executor contract model list matches the executable allowlist", () => {
  const contractPath = path.join(__dirname, "..", "docs", "agent-os", "executor-contracts", "gemini-executor.md");
  const contract = fs.readFileSync(contractPath, "utf8");
  const listedModels = [...contract.matchAll(/- `(gemini-[^`]+)`/g)].map((match) => match[1]).sort();
  const expected = [...geminiExecutor.SUPPORTED_MODELS].sort();

  assert.deepEqual(listedModels, expected);
  for (const model of listedModels) {
    assert.equal(dispatcher.normalizeGeminiModel(model), model);
  }
  assert.throws(() => dispatcher.normalizeGeminiModel("gemini-3-pro-preview"), /Unsupported Gemini model/);
});

test("Antigravity dispatch does not pass a fake model label to agy", () => {
  const source = fs.readFileSync(dispatcherPath, "utf8");
  assert.doesNotMatch(source, /--model-label/);
  assert.match(source, /Antigravity inherits its model from the IDE/);
});

test("executor adapters have agent-level contracts attached", () => {
  const root = path.join(__dirname, "..", "docs", "agent-os", "executor-contracts");
  for (const name of ["codex-executor.md", "local-llm-executor.md", "antigravity-executor.md", "gemini-executor.md"]) {
    const text = fs.readFileSync(path.join(root, name), "utf8");
    assert.match(text, /Allowed write scope/i);
    assert.match(text, /Forbidden paths/i);
    assert.match(text, /READY_FOR_VERIFICATION/);
    assert.match(text, /DONE/);
    assert.match(text, /retry budget/i);
  }
});
