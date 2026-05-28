#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync, spawnSync } = require("node:child_process");
const envPaths = require("./env-paths.js");
const { startWriteScopeMonitor, writeScopeViolations } = require("./no-write-monitor.js");
const geminiExecutor = require("./gemini-executor.js");

const repoRoot = path.resolve(__dirname, "..");
const queueCli = path.join(__dirname, "agent-queue.js");
const antigravityAdapter = path.join(__dirname, "antigravity-reviewer.js");
const codexAdapter = path.join(__dirname, "codex-executor-adapter.js");
const geminiAdapter = path.join(__dirname, "gemini-executor.js");
const localLlmAdapter = path.join(__dirname, "local-llm-executor.js");

const SUPPORTED_EXECUTORS = new Set(["antigravity", "codex", "gemini", "local-llm"]);
const SUPPORTED_GEMINI_MODELS = geminiExecutor.SUPPORTED_MODELS;
const DEFAULT_FORBIDDEN_PATHS = [
  "C:\\Users\\mjb58\\connect-ai-vault",
  "transport-audit",
  "swarm-status",
  "readiness",
  "dashboard/audit features",
];

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

function redact(text, maxLen = 12000) {
  let value = String(text ?? "");
  value = value.replace(/\b((?:token|secret|password|passwd|api[_-]?key|client[_-]?secret|authorization|cookie|localStorage)\b\s*[:=]\s*)["']?[^"'\s,}]+/gi, "$1<redacted>");
  value = value.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi, "Bearer <redacted>");
  value = value.trim();
  return value.length > maxLen ? `${value.slice(0, maxLen)}\n...[truncated]` : value;
}

function stamp() {
  return new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function listDirectoryFiles(root, dir = root, results = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) listDirectoryFiles(root, fullPath, results);
    else if (entry.isFile()) results.push(fullPath);
  }
  return results;
}

function fingerprintEntry(targetPath) {
  const fullPath = path.resolve(targetPath);
  if (!fs.existsSync(fullPath)) return { path: fullPath, kind: "missing" };
  const stat = fs.statSync(fullPath);
  if (stat.isDirectory()) {
    return {
      path: fullPath,
      kind: "directory",
      files: listDirectoryFiles(fullPath)
        .map((absolute) => ({
          relPath: path.relative(fullPath, absolute).replace(/\\/g, "/"),
          size: fs.statSync(absolute).size,
          sha256: sha256File(absolute),
        }))
        .sort((a, b) => a.relPath.localeCompare(b.relPath)),
    };
  }
  if (stat.isFile()) {
    return { path: fullPath, kind: "file", size: stat.size, sha256: sha256File(fullPath) };
  }
  return { path: fullPath, kind: "other", size: stat.size };
}

function fingerprintPaths(paths) {
  return [...new Set((paths || []).map(String).filter(Boolean).map((item) => path.resolve(item)))]
    .sort((a, b) => a.localeCompare(b))
    .map((item) => fingerprintEntry(item));
}

function fingerprintDiff(before = [], after = []) {
  const afterMap = new Map(after.map((entry) => [entry.path, entry]));
  return before
    .map((entry) => {
      const current = afterMap.get(entry.path) || { path: entry.path, kind: "missing" };
      return JSON.stringify(entry) === JSON.stringify(current) ? null : {
        path: entry.path,
        before: entry.kind,
        after: current.kind,
      };
    })
    .filter(Boolean);
}

function pathKey(value) {
  return path.resolve(String(value || "")).toLowerCase();
}

function isSameOrInside(parentPath, childPath) {
  const parent = pathKey(parentPath);
  const child = pathKey(childPath);
  const rel = path.relative(parent, child);
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

function isTaskPath(candidate, taskPaths = []) {
  return taskPaths.some((taskPath) => isSameOrInside(taskPath, candidate));
}

function snapshotDirectoryFiles(root) {
  const fullRoot = path.resolve(root);
  if (!fs.existsSync(fullRoot) || !fs.statSync(fullRoot).isDirectory()) return [];
  return listDirectoryFiles(fullRoot)
    .map((filePath) => ({
      path: path.resolve(filePath),
      size: fs.statSync(filePath).size,
      sha256: sha256File(filePath),
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

function diffDirectoryFiles(before = [], after = []) {
  const beforeMap = new Map(before.map((entry) => [pathKey(entry.path), entry]));
  const afterMap = new Map(after.map((entry) => [pathKey(entry.path), entry]));
  const keys = [...new Set([...beforeMap.keys(), ...afterMap.keys()])].sort();
  return keys
    .map((key) => {
      const previous = beforeMap.get(key);
      const current = afterMap.get(key);
      if (!previous && current) return { path: current.path, change: "added" };
      if (previous && !current) return { path: previous.path, change: "removed" };
      if (previous && current && (previous.size !== current.size || previous.sha256 !== current.sha256)) {
        return { path: current.path, change: "modified" };
      }
      return null;
    })
    .filter(Boolean);
}

function filesChangedFrom(executorResult) {
  const parsed = executorResult.parsedStdout || {};
  return Array.isArray(parsed.filesChanged) ? parsed.filesChanged.map(String).filter(Boolean) : [];
}

function noWriteContext(options, runDir, executorResultFile) {
  const taskPaths = [...new Set([...options.files, ...options.writeScope].map(String).filter(Boolean).map((item) => path.resolve(item)))];
  return {
    taskPaths,
    runDir: path.resolve(runDir),
    executorResultFile: path.resolve(executorResultFile),
    companyDir: path.resolve(envPaths.companyDir()),
    scopeBefore: fingerprintPaths(taskPaths),
    runDirBefore: snapshotDirectoryFiles(runDir),
  };
}

function isClassifiedRuntimeArtifact(candidate, context) {
  if (!candidate || !context) return false;
  const fullPath = path.resolve(candidate);
  if (isTaskPath(fullPath, context.taskPaths)) return false;
  return isSameOrInside(context.runDir, fullPath) || isSameOrInside(context.companyDir, fullPath);
}

function noWriteReportedFileViolations(executorResult, context) {
  return filesChangedFrom(executorResult)
    .filter((filePath) => !isClassifiedRuntimeArtifact(filePath, context));
}

function finishNoWriteMonitor(context, executorResult) {
  if (!context) return { noWriteFilesystemChanges: [], noWriteUnclassifiedArtifacts: [] };
  const reportedArtifacts = filesChangedFrom(executorResult)
    .filter((filePath) => isClassifiedRuntimeArtifact(filePath, context))
    .map((filePath) => pathKey(filePath));
  const classifiedArtifacts = new Set([pathKey(context.executorResultFile), ...reportedArtifacts]);
  const scopeChanges = fingerprintDiff(context.scopeBefore, fingerprintPaths(context.taskPaths));
  const artifactChanges = diffDirectoryFiles(context.runDirBefore, snapshotDirectoryFiles(context.runDir))
    .filter((change) => !classifiedArtifacts.has(pathKey(change.path)));
  return {
    noWriteFilesystemChanges: scopeChanges,
    noWriteUnclassifiedArtifacts: artifactChanges,
  };
}

function parseLastJson(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { /* fall through */ }
  const lastBrace = raw.lastIndexOf("\n{");
  if (lastBrace >= 0) {
    try { return JSON.parse(raw.slice(lastBrace + 1)); } catch { /* fall through */ }
  }
  const firstBrace = raw.indexOf("{");
  if (firstBrace >= 0) {
    try { return JSON.parse(raw.slice(firstBrace)); } catch { /* fall through */ }
  }
  return null;
}

function runQueue(args) {
  const output = execFileSync(process.execPath, [queueCli, ...args], {
    cwd: repoRoot,
    env: process.env,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  return JSON.parse(output);
}

function titleFromGoal(goal) {
  const text = String(goal || "S4 queue dispatcher smoke").replace(/\s+/g, " ").trim();
  return text.length > 96 ? `${text.slice(0, 93)}...` : text;
}

function normalizeGeminiModel(model) {
  const value = String(model || "").trim();
  if (!value) return "";
  if (!SUPPORTED_GEMINI_MODELS.has(value)) {
    throw new Error(`Unsupported Gemini model: ${value}. Expected ${[...SUPPORTED_GEMINI_MODELS].join("|")}.`);
  }
  return value;
}

function inferGeminiModelFromGoal(goal) {
  const text = String(goal || "");
  const normalized = text.toLowerCase().replace(/[_\s]+/g, "-");
  for (const model of SUPPORTED_GEMINI_MODELS) {
    if (normalized.includes(model)) return model;
  }
  if (/\bgemini[-\s]*2\.5[-\s]*pro\b/i.test(text)) return normalizeGeminiModel("gemini-2.5-pro");
  if (/\bgemini[-\s]*2\.5[-\s]*flash\b/i.test(text)) return normalizeGeminiModel("gemini-2.5-flash");
  return "";
}

function hasCodeChangeIntent(text) {
  return /\b(code|implement|modify|edit|fix|refactor|write|change)\b|구현|수정|편집|고치|변경|추가/i.test(String(text || ""));
}

function hasCheapLocalIntent(text) {
  return /\b(local|cheap|zero[-\s]?token|free|quick|simple|lint|format|comment|classify|classification|label|smoke|sanity)\b|로컬|저렴|토큰\s*0|무비용|빠른|간단|주석|분류|라벨|스모크/i.test(String(text || ""));
}

function hasReviewIntent(text) {
  return /\b(design|review|architecture|critique|plan)\b|설계|검토|비평|아키텍처/i.test(String(text || ""));
}

function hasLeadingCheapLocalIntent(text) {
  return /^\s*(?:cheap|local|zero[-\s]?token|free|quick|simple|smoke|sanity|classify|classification|간단|로컬|저렴|무비용|빠른|스모크|분류)\b/i.test(String(text || ""));
}

function selectExecutor(goal, requested = "auto", routeHints = {}) {
  const explicit = String(requested || "auto").toLowerCase();
  if (SUPPORTED_EXECUTORS.has(explicit)) return explicit;
  if (explicit !== "auto") throw new Error(`Unsupported executor: ${requested}. Expected auto|antigravity|codex|gemini|local-llm.`);
  if (normalizeGeminiModel(routeHints.geminiModel) || inferGeminiModelFromGoal(goal)) return "gemini";
  const text = String(goal || "");
  if (hasCodeChangeIntent(text)) {
    return "codex";
  }
  if (hasReviewIntent(text)) {
    return hasLeadingCheapLocalIntent(text) ? "local-llm" : "antigravity";
  }
  if (hasCheapLocalIntent(text)) {
    return "local-llm";
  }
  return "codex";
}

function workerClassFor(executor) {
  if (executor === "local-llm") return "local-smoke";
  if (executor === "gemini" || executor === "antigravity") return "reviewer";
  return "executor";
}

function roleFor(executor) {
  if (executor === "local-llm") return "local-smoke";
  if (executor === "gemini" || executor === "antigravity") return "reviewer";
  return "implementer";
}

function stopConditionFor(executor) {
  if (executor === "local-llm") return "Stop after one read-only smoke result, missing required evidence, or any write claim.";
  return "Stop when retry budget is exhausted, a forbidden-path policy violation appears, required evidence is missing, or the same failure repeats.";
}

function approvalConditionFor(executor) {
  if (executor === "codex") return "Human approval is required before credential access, deploy/external-send actions, direct vault write, risky write, or write-scope expansion.";
  return "Human approval is required before any write, credential access, deploy/external-send action, direct vault write, or scope expansion.";
}

function evidenceRequiredFor(executor) {
  if (executor === "local-llm") return ["no-write confirmation", "commands run", "classification/smoke evidence", "unresolved failures"];
  return ["files changed or no-write confirmation", "commands run", "current-run expected tests/evidence", "unresolved failures"];
}

function canWriteFor(executor) {
  return executor === "codex";
}

function defaultRiskFor(executor) {
  return executor === "local-llm" ? "Green" : "Yellow";
}

function defaultTokenBudgetFor(executor) {
  if (executor === "local-llm") return "local-zero";
  if (executor === "antigravity" || executor === "gemini") return "medium";
  return "small";
}

function buildExecutorPrompt(options) {
  const canWrite = canWriteFor(options.executor);
  return [
    "# Connect AI Executor Dispatch",
    "",
    "You are receiving one bounded Connect AI queue item as an executor endpoint.",
    "Do not route this task onward. Do not write to the Obsidian vault.",
    "",
    `Goal: ${options.goal}`,
    options.executor === "gemini" ? `Gemini model: ${options.geminiModel}` : "",
    `Risk: ${options.risk}`,
    `Allowed write scope: ${options.writeScope.join(", ")}`,
    `Forbidden paths: ${DEFAULT_FORBIDDEN_PATHS.join(", ")}`,
    `Expected tests/evidence: ${options.expectedTests.join("; ")}`,
    `Rollback path: ${options.rollbackPath}`,
    `Stop condition: ${options.stopCondition}`,
    `Approval condition: ${options.approvalCondition}`,
    `Evidence required: ${options.evidenceRequired.join("; ")}`,
    "",
    "Execution rule:",
    canWrite
      ? "- Make changes only inside the allowed write scope when your environment permits it."
      : "- Do not change files; return read-only smoke/classification evidence only.",
    canWrite
      ? "- If you cannot write, return a precise reason and the patch you would apply."
      : "- If the task requires a file change, report that this executor cannot perform it.",
    "- Report READY_FOR_VERIFICATION, never DONE. A separate verifier is S7 scope.",
    "",
    "Required result format:",
    "```json",
    JSON.stringify({
      status: "READY_FOR_VERIFICATION",
      executor: options.executor,
      filesChanged: canWrite ? options.writeScope : [],
      commandsRun: [],
      unresolvedFailures: [],
      evidence: "short current-run evidence",
    }, null, 2),
    "```",
    "",
  ].join("\n");
}

function defaultRunDir() {
  return path.join(envPaths.companyDir(), "s4-dispatch");
}

function createQueueItem(options, promptFile) {
  const args = [
    "add",
    "--assignee", options.executor,
    "--priority", options.priority,
    "--title", titleFromGoal(options.goal),
    "--prompt-file", promptFile,
    "--risk", options.risk,
    "--risk-class", options.risk,
    "--executor", options.executor,
    "--reviewer", options.reviewer,
    "--intent", `queue-dispatch-${options.executor}`,
    "--role", roleFor(options.executor),
    "--worker-class", workerClassFor(options.executor),
    "--stop-condition", options.stopCondition,
    "--approval-condition", options.approvalCondition,
    "--can-write", String(canWriteFor(options.executor)),
    "--allowed-assignee", options.executor,
    "--token-budget", options.tokenBudget,
    "--retry-budget", String(options.retryBudget),
    "--agent-os-status", "QUEUED",
  ];
  for (const file of options.files) args.push("--file", file);
  for (const scope of options.writeScope) args.push("--write-scope", scope);
  for (const forbidden of DEFAULT_FORBIDDEN_PATHS) args.push("--forbidden-path", forbidden);
  for (const expected of options.expectedTests) args.push("--expected-test", expected);
  for (const evidence of options.evidenceRequired) args.push("--evidence-required", evidence);
  args.push("--rollback-path", options.rollbackPath);
  return runQueue(args);
}

function executorInvocation(options, promptFile, queueItemFile, executorResultFile) {
  const protocolArgs = [
    "--queue-item-file", queueItemFile,
    "--prompt-file", promptFile,
    "--result-file", executorResultFile,
  ];
  const customCommand = getArg("executor-command");
  if (customCommand) {
    return {
      cmd: customCommand,
      args: [
        ...getMultiArg("executor-arg"),
        ...protocolArgs,
      ],
      cwd: repoRoot,
    };
  }
  if (options.executor === "codex") {
    return {
      cmd: process.execPath,
      args: [codexAdapter, ...protocolArgs, "--process-timeout-ms", getArg("process-timeout-ms", "420000")],
      cwd: repoRoot,
    };
  }
  if (options.executor === "local-llm") {
    const model = getArg("local-model", process.env.CONNECT_AI_LOCAL_LLM_MODEL || "");
    const args = [localLlmAdapter, ...protocolArgs, "--process-timeout-ms", getArg("process-timeout-ms", "60000")];
    if (model) args.push("--model", model);
    return { cmd: process.execPath, args, cwd: repoRoot };
  }
  if (options.executor === "gemini") {
    const model = normalizeGeminiModel(options.geminiModel) || "gemini-2.5-flash";
    const evidenceDir = path.join(envPaths.companyDir(), "s5-dispatch");
    return {
      cmd: process.execPath,
      args: [
        geminiAdapter,
        "--model", model,
        "--prompt-file", promptFile,
        "--evidence-dir", evidenceDir,
      ],
      cwd: repoRoot,
    };
  }
  const antigravityArgs = [
    antigravityAdapter,
    "--prompt-file", promptFile,
    "--direct-only",
    "--force-agy",
    "--cwd", repoRoot,
    "--timeout", getArg("antigravity-timeout", "5m"),
    "--process-timeout-ms", getArg("process-timeout-ms", "420000"),
  ];
  // Antigravity inherits its model from the IDE/account current selection.
  // `agy` does not expose a real model-selection flag, so the dispatcher must
  // not pass a fake label and imply multi-model routing here.
  return {
    cmd: process.execPath,
    args: antigravityArgs,
    cwd: repoRoot,
  };
}

function runExecutor(invocation) {
  const startedAt = new Date().toISOString();
  const result = spawnSync(invocation.cmd, invocation.args, {
    cwd: invocation.cwd,
    env: process.env,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    windowsHide: true,
    timeout: Number(getArg("executor-timeout-ms", getArg("process-timeout-ms", "420000"))),
  });
  return {
    startedAt,
    completedAt: new Date().toISOString(),
    command: invocation.cmd,
    args: invocation.args,
    cwd: invocation.cwd,
    exitCode: result.status ?? 1,
    stdout: redact(result.stdout || "", 12000),
    stderr: redact(result.stderr || result.error?.message || "", 4000),
    parsedStdout: parseLastJson(result.stdout),
  };
}

function commandLine(executorResult) {
  return redact([executorResult.command, ...(Array.isArray(executorResult.args) ? executorResult.args : [])].filter(Boolean).join(" "), 800);
}

function successfulDispatchSummary(executorName, executorResult, dispatchLogPath) {
  const parsed = executorResult.parsedStdout || {};
  const filesChanged = Array.isArray(parsed.filesChanged) ? parsed.filesChanged : [];
  const commandsRun = Array.isArray(parsed.commandsRun) ? parsed.commandsRun : [];
  const unresolved = Array.isArray(parsed.unresolvedFailures) ? parsed.unresolvedFailures : [];
  return [
    `READY_FOR_VERIFICATION: ${executorName} executor dispatch returned exit 0.`,
    filesChanged.length ? `Files changed: ${filesChanged.join(", ")}.` : "No files changed.",
    `Commands run: ${commandsRun.length ? commandsRun.join("; ") : commandLine(executorResult)}.`,
    `Current-run expected tests/evidence: ${parsed.evidence ? redact(parsed.evidence, 500) : `executor exit 0; evidence log: ${dispatchLogPath}`}.`,
    `Unresolved failures: ${unresolved.length ? unresolved.join("; ") : "none"}.`,
  ].join(" ");
}

function dispatchBlockReason(executorName, executorResult, context = null) {
  if (executorResult.exitCode !== 0) return `EXECUTOR_EXIT_${executorResult.exitCode}`;
  const parsed = executorResult.parsedStdout || {};
  const status = String(parsed.status || "").trim().toUpperCase();
  if (status === "BLOCKED") return String(parsed.reason || parsed.error || "EXECUTOR_REPORTED_BLOCKED");
  if (status && status !== "READY_FOR_VERIFICATION") return `UNSUPPORTED_EXECUTOR_STATUS_${status}`;
  if (canWriteFor(executorName) && Array.isArray(executorResult.writeScopeViolations) && executorResult.writeScopeViolations.length) {
    return `WRITE_SCOPE_VIOLATION: ${executorResult.writeScopeViolations.map((entry) => entry.path).join(", ")}`;
  }
  const fileViolations = !canWriteFor(executorName) ? noWriteReportedFileViolations(executorResult, context) : [];
  if (fileViolations.length) return `NO_WRITE_EXECUTOR_CLAIMED_FILES_CHANGED: ${fileViolations.join(", ")}`;
  if (!canWriteFor(executorName) && Array.isArray(executorResult.noWriteFilesystemChanges) && executorResult.noWriteFilesystemChanges.length) {
    return `NO_WRITE_EXECUTOR_MODIFIED_FILES: ${executorResult.noWriteFilesystemChanges.map((entry) => entry.path).join(", ")}`;
  }
  if (!canWriteFor(executorName) && Array.isArray(executorResult.noWriteUnclassifiedArtifacts) && executorResult.noWriteUnclassifiedArtifacts.length) {
    return `UNCLASSIFIED_EXECUTOR_ARTIFACTS: ${executorResult.noWriteUnclassifiedArtifacts.map((entry) => entry.path).join(", ")}`;
  }
  return "";
}

function blockedDispatchSummary(executorName, executorResult, dispatchLogPath, reason = "") {
  const parsed = executorResult.parsedStdout || {};
  const unresolved = Array.isArray(parsed.unresolvedFailures) ? parsed.unresolvedFailures.filter(Boolean) : [];
  const evidence = parsed.evidence ? ` Evidence: ${redact(parsed.evidence, 500)}.` : "";
  return [
    `BLOCKED: ${executorName} executor dispatch failed contract check${reason ? ` (${reason})` : ""}.`,
    `Exit: ${executorResult.exitCode}.`,
    unresolved.length ? `Unresolved failures: ${unresolved.join("; ")}.` : "Unresolved failures: contract check blocked dispatch.",
    `Evidence log: ${dispatchLogPath}.`,
    evidence,
  ].filter(Boolean).join(" ");
}

function updateQueueAfterDispatch(itemId, executorName, executorResult, dispatchLogPath, context = null) {
  const blockReason = dispatchBlockReason(executorName, executorResult, context);
  if (!blockReason) {
    return runQueue([
      "update",
      "--id", itemId,
      "--status", "ready_for_verification",
      "--result-summary",
      successfulDispatchSummary(executorName, executorResult, dispatchLogPath),
    ]);
  }
  return runQueue([
    "update",
    "--id", itemId,
    "--status", "blocked",
    "--result-summary",
    blockedDispatchSummary(executorName, executorResult, dispatchLogPath, blockReason),
  ]);
}

function dispatch() {
  const goal = getArg("goal");
  if (!goal) throw new Error("queue-dispatcher dispatch requires --goal");
  const requestedExecutor = getArg("executor", "auto").toLowerCase();
  const geminiModel = normalizeGeminiModel(getArg("gemini-model")) || inferGeminiModelFromGoal(goal);
  const executor = selectExecutor(goal, requestedExecutor, { geminiModel });
  const files = getMultiArg("file");
  const writeScope = getMultiArg("write-scope");
  const expectedTests = getMultiArg("expected-test");
  const runDir = path.resolve(getArg("run-dir", defaultRunDir()));
  ensureDir(runDir);
  if (hasFlag("ensure-file")) {
    for (const file of files) {
      ensureDir(path.dirname(file));
      if (!fs.existsSync(file)) fs.writeFileSync(file, "function smoke() { return true; }\n", "utf8");
    }
  }
  const options = {
    goal,
    executor,
    reviewer: getArg("reviewer", "pending-s7"),
    requestedExecutor,
    risk: getArg("risk", defaultRiskFor(executor)),
    priority: getArg("priority", "P2").toUpperCase(),
    files,
    writeScope: writeScope.length ? writeScope : files,
    expectedTests: expectedTests.length ? expectedTests : ["executor returns READY_FOR_VERIFICATION evidence"],
    rollbackPath: getArg("rollback-path", "not-applicable"),
    stopCondition: getArg("stop-condition", stopConditionFor(executor)),
    approvalCondition: getArg("approval-condition", approvalConditionFor(executor)),
    evidenceRequired: getMultiArg("evidence-required").length ? getMultiArg("evidence-required") : evidenceRequiredFor(executor),
    tokenBudget: getArg("token-budget", defaultTokenBudgetFor(executor)),
    retryBudget: Number.parseInt(getArg("retry-budget", "1"), 10) || 1,
    geminiModel: executor === "gemini" ? (geminiModel || "gemini-2.5-flash") : geminiModel,
  };
  if (!options.files.length) throw new Error("queue-dispatcher dispatch requires at least one --file");
  if (!options.writeScope.length) throw new Error("queue-dispatcher dispatch requires --write-scope or --file");

  const runStamp = stamp();
  const artifactPrefix = `queue-dispatch-${executor}-${runStamp}`;
  const promptFile = path.join(runDir, `${artifactPrefix}-prompt.md`);
  const queueItemFile = path.join(runDir, `${artifactPrefix}-queue-item.json`);
  const executorResultFile = path.join(runDir, `${artifactPrefix}-executor-result.json`);
  const dispatchLogPath = path.join(runDir, `${artifactPrefix}-dispatch-log.json`);
  fs.writeFileSync(promptFile, buildExecutorPrompt(options), "utf8");

  const created = createQueueItem(options, promptFile);
  fs.writeFileSync(queueItemFile, `${JSON.stringify(created.item, null, 2)}\n`, "utf8");

  const invocation = executorInvocation(options, promptFile, queueItemFile, executorResultFile);
  const noWriteMonitor = canWriteFor(executor) ? null : noWriteContext(options, runDir, executorResultFile);
  const writeScopeMonitor = canWriteFor(executor) ? startWriteScopeMonitor(options) : null;
  const executorResult = runExecutor(invocation);
  if (!canWriteFor(executor)) {
    Object.assign(executorResult, finishNoWriteMonitor(noWriteMonitor, executorResult));
  } else {
    executorResult.writeScopeViolations = writeScopeViolations(writeScopeMonitor, executorResult);
  }
  if (executorResult.parsedStdout) {
    fs.writeFileSync(executorResultFile, `${JSON.stringify(executorResult.parsedStdout, null, 2)}\n`, "utf8");
  }
  const updated = updateQueueAfterDispatch(created.item.id, executor, executorResult, dispatchLogPath, noWriteMonitor);
  const log = {
    schema: "connect-ai.s4.dispatch-log.v1",
    generatedAt: new Date().toISOString(),
    queuePath: created.path,
    promptFile,
    queueItemFile,
    executorResultFile: fs.existsSync(executorResultFile) ? executorResultFile : "",
    queueItemBeforeDispatch: created.item,
    queueItemAfterDispatch: updated.item,
    executor: executorResult,
  };
  fs.writeFileSync(dispatchLogPath, `${JSON.stringify(log, null, 2)}\n`, "utf8");

  const output = {
    success: updated.item.status === "ready_for_verification",
    status: updated.item.status === "ready_for_verification" ? "PARTIAL_READY_FOR_VERIFICATION" : "BLOCKED",
    queuePath: created.path,
    dispatchLogPath,
    promptFile,
    queueItemFile,
    executorResultFile: log.executorResultFile,
    requestedExecutor,
    queueItem: updated.item,
    executor: executorResult,
  };
  console.log(JSON.stringify(output, null, 2));
  if (!output.success) process.exit(1);
}

function usage() {
  console.log(`Usage:
  node scripts/queue-dispatcher.js dispatch --goal "..." --executor auto|antigravity|codex|gemini|local-llm --file path --write-scope path --expected-test "..." --rollback-path "..." [--gemini-model gemini-2.5-flash|gemini-2.5-pro]

Auto routing: explicit --gemini-model -> gemini, comment/lint/format -> local-llm, code change -> codex, design/review -> antigravity.`);
}

if (require.main === module) {
  try {
    if (process.argv[2] === "dispatch") dispatch();
    else usage();
  } catch (error) {
    console.log(JSON.stringify({ success: false, error: redact(error.message || String(error), 4000) }, null, 2));
    process.exit(1);
  }
}

module.exports = {
  selectExecutor,
  defaultRiskFor,
  defaultTokenBudgetFor,
  normalizeGeminiModel,
  inferGeminiModelFromGoal,
  hasCheapLocalIntent,
  hasCodeChangeIntent,
  hasReviewIntent,
  hasLeadingCheapLocalIntent,
  roleFor,
  stopConditionFor,
};
