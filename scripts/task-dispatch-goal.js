#!/usr/bin/env node
"use strict";

const path = require("node:path");
const { spawnSync } = require("node:child_process");
const envPaths = require("./env-paths.js");

const repoRoot = envPaths.repoRoot();
const queueDispatcher = path.join(__dirname, "queue-dispatcher.js");
const allowedExecutors = new Set(["auto", "antigravity", "codex", "gemini", "local-llm"]);
const allowedPriorities = new Set(["P0", "P1", "P2"]);
const allowedRisks = new Set(["Green", "Yellow", "Red", "low", "medium", "high"]);

function getArg(name, fallback = "") {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return fallback;
  return process.argv[idx + 1] || fallback;
}

function getMultiArg(name) {
  const values = [];
  for (let i = 0; i < process.argv.length; i += 1) {
    if (process.argv[i] === `--${name}` && process.argv[i + 1]) values.push(process.argv[i + 1]);
  }
  return values;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function isInside(childPath, parentPath) {
  const child = path.resolve(childPath);
  const parent = path.resolve(parentPath);
  const rel = path.relative(parent, child);
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

function assertNoVaultDirectWrite(paths) {
  const vaultRoot = envPaths.vaultRoot();
  for (const candidate of paths) {
    if (candidate && isInside(candidate, vaultRoot)) {
      throw new Error(`direct Obsidian vault writes are forbidden for task_dispatch_goal: ${candidate}`);
    }
  }
}

function normalizeArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter(Boolean).map(String);
  return [String(value)];
}

function normalizeRisk(value) {
  if (!value) return "";
  const risk = String(value);
  if (!allowedRisks.has(risk)) throw new Error(`Unsupported risk: ${risk}`);
  return risk;
}

function normalizeRequest(input = {}) {
  const goal = String(input.goal || "").replace(/\s+/g, " ").trim();
  if (!goal) throw new Error("task_dispatch_goal requires a natural-language goal");

  const executor = String(input.executor || "auto").toLowerCase();
  if (!allowedExecutors.has(executor)) {
    throw new Error(`Unsupported executor: ${executor}. Expected auto|antigravity|codex|gemini|local-llm.`);
  }

  const files = normalizeArray(input.files);
  if (!files.length) throw new Error("task_dispatch_goal requires at least one target file");

  const writeScope = normalizeArray(input.writeScope).length ? normalizeArray(input.writeScope) : files;
  assertNoVaultDirectWrite([...files, ...writeScope]);

  const priority = String(input.priority || "P2").toUpperCase();
  if (!allowedPriorities.has(priority)) throw new Error(`Unsupported priority: ${priority}`);

  return {
    goal,
    executor,
    files,
    writeScope,
    expectedTests: normalizeArray(input.expectedTests).length
      ? normalizeArray(input.expectedTests)
      : ["executor returns READY_FOR_VERIFICATION evidence"],
    rollbackPath: String(input.rollbackPath || "revert only the allowed write scope listed on the queue item"),
    risk: normalizeRisk(input.risk),
    priority,
    reviewer: String(input.reviewer || "pending-s7"),
    tokenBudget: input.tokenBudget ? String(input.tokenBudget) : "",
    retryBudget: input.retryBudget === undefined || input.retryBudget === null ? "" : String(input.retryBudget),
    runDir: input.runDir ? String(input.runDir) : "",
    ensureFile: Boolean(input.ensureFile),
    localModel: input.localModel ? String(input.localModel) : "",
    geminiModel: input.geminiModel ? String(input.geminiModel) : "",
    processTimeoutMs: input.processTimeoutMs ? String(input.processTimeoutMs) : "",
    executorTimeoutMs: input.executorTimeoutMs ? String(input.executorTimeoutMs) : "",
    executorCommand: input.executorCommand ? String(input.executorCommand) : "",
    executorArgs: normalizeArray(input.executorArgs),
  };
}

function appendIf(args, name, value) {
  if (value !== undefined && value !== null && String(value) !== "") args.push(`--${name}`, String(value));
}

function buildDispatchArgs(input = {}) {
  const request = normalizeRequest(input);
  const args = [
    "dispatch",
    "--goal", request.goal,
    "--executor", request.executor,
    "--priority", request.priority,
    "--reviewer", request.reviewer,
  ];

  appendIf(args, "risk", request.risk);
  appendIf(args, "token-budget", request.tokenBudget);
  appendIf(args, "retry-budget", request.retryBudget);
  appendIf(args, "run-dir", request.runDir);
  appendIf(args, "local-model", request.localModel);
  appendIf(args, "gemini-model", request.geminiModel);
  appendIf(args, "process-timeout-ms", request.processTimeoutMs);
  appendIf(args, "executor-timeout-ms", request.executorTimeoutMs);
  appendIf(args, "executor-command", request.executorCommand);

  for (const file of request.files) args.push("--file", file);
  for (const scope of request.writeScope) args.push("--write-scope", scope);
  for (const expected of request.expectedTests) args.push("--expected-test", expected);
  for (const executorArg of request.executorArgs) args.push("--executor-arg", executorArg);
  args.push("--rollback-path", request.rollbackPath);
  if (request.ensureFile) args.push("--ensure-file");

  return args;
}

function runTaskDispatch(input = {}, options = {}) {
  const args = buildDispatchArgs(input);
  const result = spawnSync(process.execPath, [queueDispatcher, ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...(options.env || {}) },
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    windowsHide: true,
    timeout: Number(input.processTimeoutMs || input.executorTimeoutMs || 420000),
  });

  const stdout = result.stdout || "";
  const stderr = result.stderr || result.error?.message || "";
  return {
    success: result.status === 0,
    exitCode: result.status ?? 1,
    stdout,
    stderr,
  };
}

function parseCliRequest() {
  return {
    goal: getArg("goal"),
    executor: getArg("executor", "auto"),
    files: getMultiArg("file"),
    writeScope: getMultiArg("write-scope"),
    expectedTests: getMultiArg("expected-test"),
    rollbackPath: getArg("rollback-path"),
    risk: getArg("risk"),
    priority: getArg("priority"),
    reviewer: getArg("reviewer"),
    tokenBudget: getArg("token-budget"),
    retryBudget: getArg("retry-budget"),
    runDir: getArg("run-dir"),
    ensureFile: hasFlag("ensure-file"),
    localModel: getArg("local-model"),
    geminiModel: getArg("gemini-model"),
    processTimeoutMs: getArg("process-timeout-ms"),
    executorTimeoutMs: getArg("executor-timeout-ms"),
    executorCommand: getArg("executor-command"),
    executorArgs: getMultiArg("executor-arg"),
  };
}

function main() {
  try {
    const result = runTaskDispatch(parseCliRequest());
    process.stdout.write(result.stdout || JSON.stringify(result, null, 2));
    if (result.stderr) process.stderr.write(result.stderr);
    if (!result.success) process.exit(result.exitCode || 1);
  } catch (error) {
    console.log(JSON.stringify({ success: false, error: error.message || String(error) }, null, 2));
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = {
  normalizeRequest,
  buildDispatchArgs,
  runTaskDispatch,
};
