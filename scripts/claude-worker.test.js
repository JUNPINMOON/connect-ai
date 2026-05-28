#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "..");
const workerPath = path.join(__dirname, "claude-worker.js");
const queueCliPath = path.join(__dirname, "agent-queue.js");

function runNode(script, args, env) {
  const output = execFileSync(process.execPath, [script, ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  return JSON.parse(output);
}

function contractArgs(options = {}) {
  const risk = options.risk || "Green";
  const writeScope = options.writeScope === undefined ? "read-only" : options.writeScope;
  const args = [
    "--risk", risk,
    "--expected-test", options.expectedTest || "worker current-run evidence exists",
    "--rollback-path", options.rollbackPath || (risk === "Green" ? "no file writes expected" : "revert scoped worker test files"),
    "--executor", "claude",
    "--reviewer", "gemini",
  ];
  if (writeScope) args.push("--write-scope", writeScope);
  return args;
}

test("claude-worker claims a Claude task, runs a Claude-compatible binary, leaves RFV, and replans", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-claude-worker-"));
  const queueFile = path.join(tempDir, "agent-queue.json");
  const fakeClaude = path.join(tempDir, process.platform === "win32" ? "fake-claude.cmd" : "fake-claude");
  const env = { CONNECT_AI_AGENT_QUEUE: queueFile };

  if (process.platform === "win32") {
    fs.writeFileSync(fakeClaude, `@echo off
echo %* > "${path.join(tempDir, "fake-claude-args.txt")}"
echo READY WITH RISKS: fake Claude completed review.
`, "utf8");
  } else {
    fs.writeFileSync(fakeClaude, `#!/usr/bin/env sh
printf '%s\\n' "$*" > ${JSON.stringify(path.join(tempDir, "fake-claude-args.txt"))}
echo 'READY WITH RISKS: fake Claude completed review.'
`, "utf8");
    fs.chmodSync(fakeClaude, 0o755);
  }

  const task = runNode(queueCliPath, [
    "add",
    "--assignee", "claude",
    "--priority", "P2",
    "--title", "Read-only review",
    "--prompt", "Review this task without editing files.",
    ...contractArgs(),
  ], env).item;

  const result = runNode(workerPath, [
    "--worker", "claude-worker-test",
    "--claude-bin", fakeClaude,
    "--max-turns", "1",
    "--output-format", "text",
  ], env);

  assert.equal(result.success, true);
  assert.equal(result.task.id, task.id);
  assert.equal(result.status, "ready_for_verification");
  assert.match(result.resultSummary, /fake Claude completed review/);

  const queue = runNode(queueCliPath, ["list"], env).items;
  assert.equal(queue.find((item) => item.id === task.id).status, "ready_for_verification");

  const reportsDir = path.join(tempDir, "reports");
  assert.ok(fs.existsSync(reportsDir));
  assert.ok(fs.readdirSync(reportsDir).some((name) => name.startsWith("agent-queue-replan-")));
});

test("claude-worker reports blocked when the Claude binary is missing", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-claude-worker-"));
  const queueFile = path.join(tempDir, "agent-queue.json");
  const env = { CONNECT_AI_AGENT_QUEUE: queueFile };

  const task = runNode(queueCliPath, [
    "add",
    "--assignee", "claude",
    "--priority", "P2",
    "--title", "Needs Claude",
    "--prompt", "Run with Claude.",
    ...contractArgs(),
  ], env).item;

  const result = runNode(workerPath, [
    "--worker", "claude-worker-test",
    "--claude-bin", path.join(tempDir, "missing-claude"),
    "--wsl-claude-bin", "definitely-missing-claude-for-test",
  ], env);

  assert.equal(result.success, false);
  assert.equal(result.task.id, task.id);
  assert.equal(result.status, "blocked");
  assert.match(result.resultSummary, /Claude binary not found/);
});

test("claude-worker blocks and updates the queue when Claude execution times out", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-claude-worker-"));
  const queueFile = path.join(tempDir, "agent-queue.json");
  const slowClaude = path.join(tempDir, process.platform === "win32" ? "slow-claude.cmd" : "slow-claude");
  const env = { CONNECT_AI_AGENT_QUEUE: queueFile };

  if (process.platform === "win32") {
    fs.writeFileSync(slowClaude, "@echo off\r\nping -n 3 127.0.0.1 > nul\r\necho late\r\n", "utf8");
  } else {
    fs.writeFileSync(slowClaude, "#!/usr/bin/env sh\nsleep 3\necho late\n", "utf8");
    fs.chmodSync(slowClaude, 0o755);
  }

  const task = runNode(queueCliPath, [
    "add",
    "--assignee", "claude",
    "--priority", "P2",
    "--title", "Slow Claude",
    "--prompt", "Run slowly.",
    ...contractArgs(),
  ], env).item;

  const result = runNode(workerPath, [
    "--worker", "claude-worker-test",
    "--claude-bin", slowClaude,
    "--timeout-ms", "500",
  ], env);

  assert.equal(result.success, false);
  assert.equal(result.task.id, task.id);
  assert.equal(result.status, "blocked");
  assert.equal(result.timedOut, true);
  assert.match(result.resultSummary, /timed out/);
});

test("claude-worker passes an explicit system prompt to avoid slow default project context", () => {
  const source = fs.readFileSync(workerPath, "utf8");
  assert.match(source, /--system-prompt/);
  assert.match(source, /--add-dir/);
  assert.match(source, /claude-cwd/);
  assert.match(source, /Connect AI Agent Manager/);
});

test("claude-worker does not pass an empty --tools argument by default", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-claude-worker-"));
  const queueFile = path.join(tempDir, "agent-queue.json");
  const fakeClaude = path.join(tempDir, process.platform === "win32" ? "fake-claude.cmd" : "fake-claude");
  const argsFile = path.join(tempDir, "fake-claude-args.txt");
  const env = { CONNECT_AI_AGENT_QUEUE: queueFile };

  if (process.platform === "win32") {
    fs.writeFileSync(fakeClaude, `@echo off
echo %* > "${argsFile}"
echo OK
`, "utf8");
  } else {
    fs.writeFileSync(fakeClaude, `#!/usr/bin/env sh
printf '%s\\n' "$*" > ${JSON.stringify(argsFile)}
echo OK
`, "utf8");
    fs.chmodSync(fakeClaude, 0o755);
  }

  runNode(queueCliPath, [
    "add",
    "--assignee", "claude",
    "--priority", "P2",
    "--title", "No tools default",
    "--prompt", "Return OK.",
    ...contractArgs(),
  ], env);

  const result = runNode(workerPath, [
    "--worker", "claude-worker-test",
    "--claude-bin", fakeClaude,
    "--max-turns", "1",
    "--output-format", "text",
  ], env);

  assert.equal(result.success, true);
  const args = fs.readFileSync(argsFile, "utf8");
  assert.doesNotMatch(args, /--tools(?:\s|$)/);
});

test("claude-worker can convert Windows paths for WSL Claude access", () => {
  const worker = require(workerPath);
  assert.equal(
    worker.winToWslPath("C:\\Users\\mjb58\\connect-ai-vault\\wiki\\raw"),
    "/mnt/c/Users/mjb58/connect-ai-vault/wiki/raw"
  );
});

test("claude-worker detects read-only tasks and adds a context pack", () => {
  const worker = require(workerPath);
  const task = {
    title: "Read-only policy review",
    prompt: "파일 수정 금지. decisions 폴더에 기록.",
    files: [repoRoot],
  };

  assert.equal(worker.isReadOnlyTask(task), true);
  const context = worker.buildReadOnlyContext(task);
  assert.match(context, /Read-only context pack/);
  assert.match(context, /no-edit rule as higher priority/);
});

test("claude-worker infers safe vault context from read-only persona prompts", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-claude-vault-"));
  const decisionsDir = path.join(tempDir, "decisions");
  fs.mkdirSync(decisionsDir, { recursive: true });
  fs.writeFileSync(path.join(tempDir, "env-policy.md"), "# Env Policy\n", "utf8");
  fs.writeFileSync(path.join(decisionsDir, "2026-05-25-persona-notes-created.md"), "# Decision\n", "utf8");
  const previousVault = process.env.CONNECT_AI_VAULT;
  process.env.CONNECT_AI_VAULT = tempDir;
  delete require.cache[require.resolve(workerPath)];
  const worker = require(workerPath);
  const task = {
    title: "CEO/env-policy 별도 노트 필요성 read-only 검토",
    prompt: "env-policy.md는 이미 존재. vault decisions/2026-05-25-persona-notes-created.md 참고.",
    files: [],
  };

  const inferred = worker.inferContextPaths(task);
  assert.ok(inferred.some((file) => file.includes("env-policy.md")));
  assert.ok(inferred.some((file) => file.includes("2026-05-25-persona-notes-created.md")));
  if (previousVault === undefined) delete process.env.CONNECT_AI_VAULT;
  else process.env.CONNECT_AI_VAULT = previousVault;
  delete require.cache[require.resolve(workerPath)];
});

test("claude-worker rejects non-final planning output", () => {
  const worker = require(workerPath);
  assert.equal(worker.isNonFinalOutput("I'll review the current setup. Evidence Needed: files."), true);
  assert.equal(worker.isNonFinalOutput("I'll start by reading the repo rules, then inspect the collection artifacts."), true);
  assert.equal(worker.isNonFinalOutput("I'll begin by reading AGENTS.md."), true);
  assert.equal(worker.isNonFinalOutput("Final policy: raw is immutable; sources are curated. No residual risks."), false);
});

test("claude-worker source downgrades read-only plan mode before calling Claude", () => {
  const source = fs.readFileSync(workerPath, "utf8");
  assert.match(source, /effectivePermissionMode/);
  assert.match(source, /readOnly \? "default" : permissionMode/);
});

test("claude-worker blocks successful output when a forbidden path was modified", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-claude-forbidden-"));
  const queueFile = path.join(tempDir, "agent-queue.json");
  const fakeClaude = path.join(tempDir, process.platform === "win32" ? "fake-claude.cmd" : "fake-claude");
  const allowedFile = path.join(tempDir, "allowed.md");
  const forbiddenFile = path.join(tempDir, "forbidden.md");
  const env = { CONNECT_AI_AGENT_QUEUE: queueFile };
  fs.writeFileSync(allowedFile, "# allowed\n", "utf8");

  if (process.platform === "win32") {
    fs.writeFileSync(fakeClaude, `@echo off\r\necho forbidden > "${forbiddenFile}"\r\necho READY WITH EVIDENCE: fake Claude changed only allowed file.\r\n`, "utf8");
  } else {
    fs.writeFileSync(fakeClaude, `#!/usr/bin/env sh\necho forbidden > ${JSON.stringify(forbiddenFile)}\necho 'READY WITH EVIDENCE: fake Claude changed only allowed file.'\n`, "utf8");
    fs.chmodSync(fakeClaude, 0o755);
  }

  const task = runNode(queueCliPath, [
    "add",
    "--assignee", "claude",
    "--priority", "P1",
    "--title", "Implement scoped Claude slice",
    "--prompt", "Modify only the allowed file and report evidence.",
    "--file", allowedFile,
    "--write-scope", allowedFile,
    "--forbidden-path", forbiddenFile,
    ...contractArgs({ risk: "Yellow", writeScope: "" }),
  ], env).item;

  const result = runNode(workerPath, [
    "--worker", "claude-worker-test",
    "--claude-bin", fakeClaude,
    "--max-turns", "1",
    "--output-format", "text",
  ], env);

  assert.equal(result.success, false);
  assert.equal(result.task.id, task.id);
  assert.equal(result.status, "blocked");
  assert.match(result.resultSummary, /FORBIDDEN_PATH_MODIFIED/);

  const queue = runNode(queueCliPath, ["list"], env).items;
  assert.equal(queue.find((item) => item.id === task.id).status, "blocked");
});

test("claude-worker blocks successful output when a sibling outside write scope was modified", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-claude-scope-"));
  const projectDir = path.join(tempDir, "project");
  fs.mkdirSync(projectDir, { recursive: true });
  const queueFile = path.join(tempDir, "agent-queue.json");
  const fakeClaude = path.join(tempDir, process.platform === "win32" ? "fake-claude.cmd" : "fake-claude");
  const allowedFile = path.join(projectDir, "allowed.md");
  const siblingFile = path.join(projectDir, "sibling.md");
  const env = { CONNECT_AI_AGENT_QUEUE: queueFile };
  fs.writeFileSync(allowedFile, "# allowed\n", "utf8");

  if (process.platform === "win32") {
    fs.writeFileSync(fakeClaude, `@echo off\r\necho sibling > "${siblingFile}"\r\necho READY WITH EVIDENCE: fake Claude changed only allowed file.\r\n`, "utf8");
  } else {
    fs.writeFileSync(fakeClaude, `#!/usr/bin/env sh\necho sibling > ${JSON.stringify(siblingFile)}\necho 'READY WITH EVIDENCE: fake Claude changed only allowed file.'\n`, "utf8");
    fs.chmodSync(fakeClaude, 0o755);
  }

  const task = runNode(queueCliPath, [
    "add",
    "--assignee", "claude",
    "--priority", "P1",
    "--title", "Implement only allowed file",
    "--prompt", "Modify only the allowed file and report evidence.",
    "--file", allowedFile,
    "--write-scope", allowedFile,
    ...contractArgs({ risk: "Yellow", writeScope: "" }),
  ], env).item;

  const result = runNode(workerPath, [
    "--worker", "claude-worker-test",
    "--claude-bin", fakeClaude,
    "--max-turns", "1",
    "--output-format", "text",
  ], env);

  assert.equal(result.success, false);
  assert.equal(result.task.id, task.id);
  assert.equal(result.status, "blocked");
  assert.match(result.resultSummary, /WRITE_SCOPE_VIOLATION/);

  const queue = runNode(queueCliPath, ["list"], env).items;
  assert.equal(queue.find((item) => item.id === task.id).status, "blocked");
});
