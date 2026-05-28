#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const test = require("node:test");

const { isBlockedOutput, isReadOnlyTask } = require("./codex-worker.js");
const queueCliPath = path.join(__dirname, "agent-queue.js");
const workerPath = path.join(__dirname, "codex-worker.js");

function runNode(script, args, env) {
  const output = execFileSync(process.execPath, [script, ...args], {
    cwd: path.resolve(__dirname, ".."),
    env: { ...process.env, ...env },
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  return JSON.parse(output);
}

function contractArgs(options = {}) {
  const risk = options.risk || "Yellow";
  const writeScope = options.writeScope;
  const args = [
    "--risk", risk,
    "--expected-test", options.expectedTest || "worker current-run evidence exists",
    "--rollback-path", options.rollbackPath || "revert scoped worker test files",
    "--executor", "codex",
    "--reviewer", "gemini",
  ];
  if (writeScope) args.push("--write-scope", writeScope);
  return args;
}

test("blocked final answers are not accepted as done", () => {
  assert.equal(isBlockedOutput("BLOCKED: sandbox prevented local read commands."), true);
  assert.equal(isBlockedOutput("검증하지 못했습니다. 파일을 실제로 열람하지 못했습니다."), true);
  assert.equal(isBlockedOutput("Files inspected: package.json\nChecks passed: node --check."), false);
});

test("Green probe stays classified as read-only", () => {
  assert.equal(isReadOnlyTask({
    title: "Green E2E probe: Connect Chat to Codex worker read-only",
    prompt: "파일 수정 금지. read-only diagnostic task.",
  }), true);
});

test("codex-worker reports queue-enforced READY_FOR_VERIFICATION instead of DONE", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-codex-worker-"));
  const queueFile = path.join(tempDir, "agent-queue.json");
  const fakeCodex = path.join(tempDir, process.platform === "win32" ? "fake-codex.cmd" : "fake-codex");
  const env = { CONNECT_AI_AGENT_QUEUE: queueFile };

  if (process.platform === "win32") {
    fs.writeFileSync(fakeCodex, "@echo off\r\necho Files changed: scripts/example.js. Commands run: fake codex.\r\n", "utf8");
  } else {
    fs.writeFileSync(fakeCodex, "#!/usr/bin/env sh\necho 'Files changed: scripts/example.js. Commands run: fake codex.'\n", "utf8");
    fs.chmodSync(fakeCodex, 0o755);
  }

  const task = runNode(queueCliPath, [
    "add",
    "--assignee", "codex",
    "--priority", "P1",
    "--title", "Implement fake codex slice",
    "--prompt", "Modify scripts/example.js and report evidence.",
    "--file", "scripts/example.js",
    ...contractArgs({ writeScope: "scripts/example.js" }),
  ], env).item;

  const result = runNode(workerPath, [
    "--worker", "codex-worker-test",
    "--codex-bin", fakeCodex,
    "--timeout-ms", "5000",
  ], env);

  assert.equal(result.success, true);
  assert.equal(result.task.id, task.id);
  assert.equal(result.status, "ready_for_verification");

  const queue = runNode(queueCliPath, ["list"], env).items;
  const item = queue.find((candidate) => candidate.id === task.id);
  assert.equal(item.status, "ready_for_verification");
  assert.equal(item.agentOsStatus, "READY_FOR_VERIFICATION");
});

test("codex-worker blocks successful output when a forbidden path was modified", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-codex-forbidden-"));
  const queueFile = path.join(tempDir, "agent-queue.json");
  const fakeCodex = path.join(tempDir, process.platform === "win32" ? "fake-codex.cmd" : "fake-codex");
  const allowedFile = path.join(tempDir, "allowed.js");
  const forbiddenFile = path.join(tempDir, "forbidden.js");
  const env = { CONNECT_AI_AGENT_QUEUE: queueFile };
  fs.writeFileSync(allowedFile, "// allowed\n", "utf8");

  if (process.platform === "win32") {
    fs.writeFileSync(fakeCodex, `@echo off\r\necho // forbidden > "${forbiddenFile}"\r\necho Files changed: ${allowedFile}. Commands run: fake codex.\r\n`, "utf8");
  } else {
    fs.writeFileSync(fakeCodex, `#!/usr/bin/env sh\necho '// forbidden' > ${JSON.stringify(forbiddenFile)}\necho 'Files changed: ${allowedFile}. Commands run: fake codex.'\n`, "utf8");
    fs.chmodSync(fakeCodex, 0o755);
  }

  const task = runNode(queueCliPath, [
    "add",
    "--assignee", "codex",
    "--priority", "P1",
    "--title", "Implement scoped codex slice",
    "--prompt", "Modify only the allowed file and report evidence.",
    "--file", allowedFile,
    "--write-scope", allowedFile,
    "--forbidden-path", forbiddenFile,
    ...contractArgs({ writeScope: "" }),
  ], env).item;

  const result = runNode(workerPath, [
    "--worker", "codex-worker-test",
    "--codex-bin", fakeCodex,
    "--timeout-ms", "5000",
  ], env);

  assert.equal(result.success, false);
  assert.equal(result.task.id, task.id);
  assert.equal(result.status, "blocked");
  assert.match(result.resultSummary, /FORBIDDEN_PATH_MODIFIED/);

  const queue = runNode(queueCliPath, ["list"], env).items;
  const item = queue.find((candidate) => candidate.id === task.id);
  assert.equal(item.status, "blocked");
});

test("codex-worker blocks successful output when a sibling outside write scope was modified", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-codex-scope-"));
  const projectDir = path.join(tempDir, "project");
  fs.mkdirSync(projectDir, { recursive: true });
  const queueFile = path.join(tempDir, "agent-queue.json");
  const fakeCodex = path.join(tempDir, process.platform === "win32" ? "fake-codex.cmd" : "fake-codex");
  const allowedFile = path.join(projectDir, "allowed.js");
  const siblingFile = path.join(projectDir, "sibling.js");
  const env = { CONNECT_AI_AGENT_QUEUE: queueFile };
  fs.writeFileSync(allowedFile, "// allowed\n", "utf8");

  if (process.platform === "win32") {
    fs.writeFileSync(fakeCodex, `@echo off\r\necho // sibling > "${siblingFile}"\r\necho Files changed: ${allowedFile}. Commands run: fake codex.\r\n`, "utf8");
  } else {
    fs.writeFileSync(fakeCodex, `#!/usr/bin/env sh\necho '// sibling' > ${JSON.stringify(siblingFile)}\necho 'Files changed: ${allowedFile}. Commands run: fake codex.'\n`, "utf8");
    fs.chmodSync(fakeCodex, 0o755);
  }

  const task = runNode(queueCliPath, [
    "add",
    "--assignee", "codex",
    "--priority", "P1",
    "--title", "Implement only allowed file",
    "--prompt", "Modify only the allowed file and report evidence.",
    "--file", allowedFile,
    "--write-scope", allowedFile,
    ...contractArgs({ writeScope: "" }),
  ], env).item;

  const result = runNode(workerPath, [
    "--worker", "codex-worker-test",
    "--codex-bin", fakeCodex,
    "--timeout-ms", "5000",
  ], env);

  assert.equal(result.success, false);
  assert.equal(result.task.id, task.id);
  assert.equal(result.status, "blocked");
  assert.match(result.resultSummary, /WRITE_SCOPE_VIOLATION/);

  const queue = runNode(queueCliPath, ["list"], env).items;
  assert.equal(queue.find((candidate) => candidate.id === task.id).status, "blocked");
});
