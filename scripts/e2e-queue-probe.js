#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { spawnSync } = require("node:child_process");

const repoRoot = path.resolve(__dirname, "..");
const queueCli = path.join(__dirname, "agent-queue.js");
const runQueueCli = path.join(__dirname, "run-queue.js");
const validatorCli = path.join(__dirname, "result-validator.js");

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function getArg(name, fallback = "") {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return fallback;
  return process.argv[idx + 1] || fallback;
}

function parseLastJson(text) {
  const value = String(text || "").trim();
  try {
    return JSON.parse(value);
  } catch {
    const lastObject = value.lastIndexOf("\n{");
    if (lastObject >= 0) return JSON.parse(value.slice(lastObject + 1));
    const firstObject = value.indexOf("{");
    if (firstObject >= 0) return JSON.parse(value.slice(firstObject));
    throw new Error(`No JSON object in command output: ${value.slice(0, 200)}`);
  }
}

function runNodeJson(script, args, options = {}) {
  const stdout = execFileSync(process.execPath, [script, ...args], {
    cwd: repoRoot,
    env: process.env,
    encoding: "utf8",
    maxBuffer: 30 * 1024 * 1024,
    timeout: options.timeoutMs || 900000,
  });
  return parseLastJson(stdout);
}

function runNodeJsonWithStatus(script, args, options = {}) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: repoRoot,
    env: process.env,
    encoding: "utf8",
    maxBuffer: 30 * 1024 * 1024,
    timeout: options.timeoutMs || 900000,
  });
  const output = result.stdout || result.stderr || "";
  let json;
  try {
    json = parseLastJson(output);
  } catch (error) {
    json = {
      success: false,
      parseError: error.message,
      stdout: result.stdout || "",
      stderr: result.stderr || "",
    };
  }
  return {
    ok: result.status === 0 && !result.error,
    exitCode: result.status ?? 1,
    error: result.error ? result.error.message : "",
    json,
  };
}

function summarizeQueue(listResult) {
  const counts = { queued: 0, copied: 0, running: 0, ready_for_verification: 0, blocked: 0, done: 0 };
  for (const item of listResult.items || []) {
    if (Object.prototype.hasOwnProperty.call(counts, item.status)) counts[item.status] += 1;
  }
  return {
    path: listResult.path,
    total: listResult.count || (listResult.items || []).length,
    ...counts,
  };
}

function buildProbePrompt() {
  return [
    "Connect AI synthetic Green E2E queue probe.",
    "",
    "This is a read-only diagnostic task. Do not edit, create, delete, move, or overwrite any file.",
    "Do not touch protected paths, vault paths, stock/job/youtube/auth/token/deploy/send workflows, or external services.",
    "Do not run worker queues, do not register additional tasks, and do not mark other tasks done.",
    "",
    "Inspect only existing repo files needed to answer:",
    "1. Project directory path.",
    "2. Whether package defaults keep local LLM disabled.",
    "3. Whether plannerProvider default is antigravity.",
    "4. Whether Codex worker can be reached through scripts/run-queue.js -> scripts/codex-worker.js.",
    "",
    "Required final answer:",
    "- Say: 실제 파일 수정 없음",
    "- List files inspected.",
    "- List commands run, if any.",
    "- State residual risk, if any.",
    "",
    "If any instruction conflicts with read-only mode, keep read-only mode and report blocked.",
  ].join("\n");
}

function createPromptFile(prompt) {
  const file = path.join(os.tmpdir(), `connect-ai-e2e-probe-${process.pid}-${Date.now()}.txt`);
  fs.writeFileSync(file, prompt, "utf8");
  return file;
}

function buildAddArgs(promptFile, taskId) {
  const args = [
    "add",
    "--id", taskId,
    "--assignee", "codex",
    "--priority", "P2",
    "--title", "Green E2E probe: Connect Chat to Codex worker read-only",
    "--prompt-file", promptFile,
    "--file", path.join(repoRoot, "package.json"),
    "--file", path.join(repoRoot, "scripts", "run-queue.js"),
    "--file", path.join(repoRoot, "scripts", "codex-worker.js"),
    "--file", path.join(repoRoot, "scripts", "result-validator.js"),
  ];
  return args;
}

function buildRunArgs(taskId, timeoutMs) {
  return [
    "--execute",
    "--only", "codex",
    "--id", taskId,
    "--max", "1",
    "--codex-timeout-ms", String(timeoutMs),
  ];
}

function main() {
  const execute = hasFlag("execute");
  const timeoutMs = Number(getArg("codex-timeout-ms", "600000")) || 600000;
  const taskId = getArg("id", `aq-probe-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${process.pid}`);
  const before = summarizeQueue(runNodeJson(queueCli, ["list"]));
  const prompt = buildProbePrompt();

  if (!execute) {
    console.log(JSON.stringify({
      success: true,
      mode: "dry-run",
      mutatesQueue: false,
      selectedExecutor: "codex",
      wouldAddTaskId: taskId,
      queueBefore: before,
      expectedRunCommand: `node scripts/run-queue.js ${buildRunArgs(taskId, timeoutMs).join(" ")}`,
      blocked: false,
      promptPreview: prompt.slice(0, 600),
    }, null, 2));
    return;
  }

  const promptFile = createPromptFile(prompt);
  let addResult;
  let runResult;
  let getResult;
  let validation;
  try {
    addResult = runNodeJson(queueCli, buildAddArgs(promptFile, taskId));
    runResult = runNodeJson(runQueueCli, buildRunArgs(taskId, timeoutMs), { timeoutMs: timeoutMs + 30000 });
    getResult = runNodeJson(queueCli, ["get", "--id", taskId]);
    validation = runNodeJsonWithStatus(validatorCli, ["--id", taskId]);
  } finally {
    try { fs.unlinkSync(promptFile); } catch {}
  }

  const item = getResult.item || {};
  const validatorJson = validation.json || {};
  const validatorInvalidCount = validatorJson.invalidCount || 0;
  const success = item.status === "ready_for_verification" && validatorInvalidCount === 0;
  const after = summarizeQueue(runNodeJson(queueCli, ["list"]));
  console.log(JSON.stringify({
    success,
    mode: "execute",
    registeredTaskId: taskId,
    selectedExecutor: "codex",
    queuePath: addResult.path || before.path,
    queueBefore: before,
    queueAfter: after,
    executionPath: "Connect AI chat -> agent-queue add -> run-queue --only codex --id <probe> -> codex-worker -> result-validator",
    runResult,
    finalStatus: item.status || "",
    resultSummary: item.resultSummary || "",
    validator: {
      success: validatorJson.success,
      exitCode: validation.exitCode,
      invalidCount: validatorInvalidCount,
      results: validatorJson.results || [],
    },
    completionPolicy: "executor evidence stops at ready_for_verification; verifier acceptance is separate Agent OS scope",
    fileModificationClaim: "실제 파일 수정 없음 (probe task is read-only; queue state changed only by adding/updating this synthetic evidence task)",
    blocked: item.status === "blocked",
  }, null, 2));
  if (!success) process.exit(1);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.log(JSON.stringify({
      success: false,
      error: String(error && error.message ? error.message : error),
    }, null, 2));
    process.exit(1);
  }
}

module.exports = {
  buildAddArgs,
  buildProbePrompt,
  buildRunArgs,
  parseLastJson,
  summarizeQueue,
  runNodeJsonWithStatus,
};
