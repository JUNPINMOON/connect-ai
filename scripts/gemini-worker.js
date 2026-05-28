#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const envPaths = require("./env-paths.js");
const { noWriteTaskViolations, startNoWriteMonitor } = require("./no-write-monitor.js");
const geminiExecutorContract = require("./gemini-executor.js");

const repoRoot = path.resolve(__dirname, "..");
const queueCli = path.join(__dirname, "agent-queue.js");
const geminiExecutor = path.join(__dirname, "gemini-executor.js");
const SUPPORTED_GEMINI_MODELS = geminiExecutorContract.SUPPORTED_MODELS;

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

function redact(text, maxLen = 8000) {
  let value = String(text ?? "");
  value = value.replace(/\b((?:token|secret|password|passwd|api[_-]?key|client[_-]?secret|authorization|cookie|localStorage)\b\s*[:=]\s*)["']?[^"'\s,}]+/gi, "$1<redacted>");
  value = value.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi, "Bearer <redacted>");
  value = value.trim();
  return value.length > maxLen ? `${value.slice(0, maxLen)}\n...[truncated]` : value;
}

function stamp() {
  return new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
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

function parseLastJson(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { /* continue */ }
  const lastBrace = raw.lastIndexOf("\n{");
  if (lastBrace >= 0) {
    try { return JSON.parse(raw.slice(lastBrace + 1)); } catch { /* continue */ }
  }
  const firstBrace = raw.indexOf("{");
  if (firstBrace >= 0) {
    try { return JSON.parse(raw.slice(firstBrace)); } catch { /* continue */ }
  }
  return null;
}

function requestedModelFor(item) {
  const explicit = getArg("model") || item.geminiModel || item.requestedModel || item.model;
  const fromPrompt = String(item.prompt || "").match(/Gemini model:\s*([A-Za-z0-9._-]+)/i)?.[1] || "";
  const model = String(explicit || fromPrompt || "gemini-2.5-flash").trim();
  return SUPPORTED_GEMINI_MODELS.has(model) ? model : model;
}

function buildPrompt(item, requestedModel) {
  return [
    "# Connect AI Gemini Queue Worker",
    "",
    "You are the Gemini executor endpoint for model-specific read-only tasks.",
    "Do not edit repo files. Do not write to the Obsidian vault. Do not mark DONE.",
    "Return READY_FOR_VERIFICATION evidence only.",
    "",
    "Queue item:",
    JSON.stringify({
      id: item.id,
      title: item.title,
      risk: item.risk,
      riskClass: item.riskClass,
      requestedModel,
      writeScope: item.writeScope,
      expectedTests: item.expectedTests,
      rollbackPath: item.rollbackPath,
      prompt: item.prompt,
    }, null, 2),
  ].join("\n");
}

function executorInvocation(promptFile, queueItemFile, resultFile, requestedModel) {
  const custom = getArg("executor-command");
  const protocolArgs = [
    "--queue-item-file", queueItemFile,
    "--prompt-file", promptFile,
    "--result-file", resultFile,
    "--model", requestedModel,
  ];
  if (custom) {
    return {
      cmd: custom,
      args: [
        ...getMultiArg("executor-arg"),
        ...protocolArgs,
      ],
    };
  }
  return {
    cmd: process.execPath,
    args: [
      geminiExecutor,
      "--model", requestedModel,
      "--prompt-file", promptFile,
      "--evidence-dir", path.join(envPaths.companyDir(), "s5-dispatch"),
    ],
  };
}

function runExecutor(invocation) {
  const result = spawnSync(invocation.cmd, invocation.args, {
    cwd: repoRoot,
    env: process.env,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    windowsHide: true,
    timeout: Number(getArg("executor-timeout-ms", getArg("process-timeout-ms", "180000"))),
  });
  return {
    command: invocation.cmd,
    args: invocation.args,
    exitCode: result.status ?? 1,
    stdout: redact(result.stdout || "", 8000),
    stderr: redact(result.stderr || result.error?.message || "", 4000),
    parsedStdout: parseLastJson(result.stdout),
  };
}

function updateTask(id, status, resultSummary) {
  return runQueue(["update", "--id", id, "--status", status, "--result-summary", resultSummary]);
}

function commandLine(executor) {
  return redact([executor.command, ...(Array.isArray(executor.args) ? executor.args : [])].filter(Boolean).join(" "), 800);
}

function main() {
  const worker = redact(getArg("worker", "gemini-worker"), 120);
  const taskId = getArg("id", "");
  const claimArgs = ["claim", "--assignee", "gemini", "--worker", worker];
  if (taskId) claimArgs.push("--id", taskId);
  const claimed = runQueue(claimArgs);
  if (!claimed.claimed || !claimed.item) {
    console.log(JSON.stringify({ success: true, claimed: false, message: claimed.message, path: claimed.path }, null, 2));
    return;
  }

  const item = claimed.item;
  const requestedModel = requestedModelFor(item);
  const runDir = path.join(envPaths.companyDir(), "gemini-worker");
  fs.mkdirSync(runDir, { recursive: true });
  const runStamp = stamp();
  const queueItemFile = path.join(runDir, `gemini-worker-${runStamp}-${item.id}.queue-item.json`);
  const promptFile = path.join(runDir, `gemini-worker-${runStamp}-${item.id}.prompt.md`);
  const resultFile = path.join(runDir, `gemini-worker-${runStamp}-${item.id}.executor-result.json`);
  const dispatchLogPath = path.join(runDir, `gemini-worker-${runStamp}-${item.id}.dispatch-log.json`);
  fs.writeFileSync(queueItemFile, `${JSON.stringify(item, null, 2)}\n`, "utf8");
  fs.writeFileSync(promptFile, buildPrompt(item, requestedModel), "utf8");

  const noWriteMonitor = startNoWriteMonitor(item);
  const executor = runExecutor(executorInvocation(promptFile, queueItemFile, resultFile, requestedModel));
  const noWriteViolations = noWriteTaskViolations(noWriteMonitor, executor);
  executor.noWriteTaskViolations = noWriteViolations;
  if (executor.parsedStdout) {
    fs.writeFileSync(resultFile, `${JSON.stringify(executor.parsedStdout, null, 2)}\n`, "utf8");
  }
  const parsed = executor.parsedStdout || {};
  const unresolved = Array.isArray(parsed.unresolvedFailures) ? parsed.unresolvedFailures : [];
  const ok = executor.exitCode === 0 &&
    parsed.status === "READY_FOR_VERIFICATION" &&
    parsed.executor === "gemini" &&
    parsed.observedModel &&
    parsed.requestedModel === requestedModel &&
    parsed.observedModel === requestedModel &&
    unresolved.length === 0 &&
    noWriteViolations.length === 0;
  const status = ok ? "ready_for_verification" : "blocked";
  const resultSummary = ok
    ? [
      `READY_FOR_VERIFICATION: gemini queue worker returned ${requestedModel} evidence.`,
      "No files changed.",
      `Commands run: ${commandLine(executor)}`,
      `Current-run expected tests/evidence: gemini executor returned READY_FOR_VERIFICATION for ${requestedModel}; evidence log: ${dispatchLogPath}`,
      "Unresolved failures: none.",
    ].join(" ")
    : noWriteViolations.length
      ? `BLOCKED: gemini queue worker failed contract check (NO_WRITE_WORKER_MODIFIED_FILES: ${noWriteViolations.map((entry) => entry.path).join(", ")}). Evidence log: ${dispatchLogPath}`
      : `BLOCKED: gemini queue worker failed model=${requestedModel} exit=${executor.exitCode} reason=${redact(parsed.reason || unresolved[0] || "UNKNOWN", 400)}. Evidence log: ${dispatchLogPath}`;
  const updated = updateTask(item.id, status, resultSummary);
  const log = {
    schema: "connect-ai.gemini-worker-log.v1",
    generatedAt: new Date().toISOString(),
    requestedModel,
    queueItemBeforeDispatch: item,
    queueItemAfterDispatch: updated.item,
    queueItemFile,
    promptFile,
    resultFile: fs.existsSync(resultFile) ? resultFile : "",
    executor,
  };
  fs.writeFileSync(dispatchLogPath, `${JSON.stringify(log, null, 2)}\n`, "utf8");

  console.log(JSON.stringify({
    success: ok,
    claimed: true,
    task: { id: item.id, title: item.title },
    requestedModel,
    status,
    resultSummary,
    dispatchLogPath,
    executor,
  }, null, 2));
  if (!ok) process.exit(1);
}

if (require.main === module) {
  try { main(); }
  catch (error) {
    console.log(JSON.stringify({ success: false, error: redact(error.message || String(error), 3000) }, null, 2));
    process.exit(1);
  }
}

module.exports = {
  buildPrompt,
  requestedModelFor,
};
