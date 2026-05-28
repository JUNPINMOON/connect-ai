#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const envPaths = require("./env-paths.js");
const localExecutor = require("./local-llm-executor.js");
const { noWriteTaskViolations, startNoWriteMonitor } = require("./no-write-monitor.js");

const repoRoot = path.resolve(__dirname, "..");
const queueCli = path.join(__dirname, "agent-queue.js");
const localLlmExecutor = path.join(__dirname, "local-llm-executor.js");

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

function buildPrompt(item) {
  return [
    "# Connect AI Local LLM Queue Worker",
    "",
    "You are the local-smoke executor. Handle only short, non-secret, Green tasks.",
    "Do not edit repo files. Do not write to the Obsidian vault. Do not mark DONE.",
    "",
    "Queue item:",
    JSON.stringify({
      id: item.id,
      title: item.title,
      risk: item.risk,
      riskClass: item.riskClass,
      writeScope: item.writeScope,
      expectedTests: item.expectedTests,
      rollbackPath: item.rollbackPath,
      prompt: item.prompt,
    }, null, 2),
    "",
    "Return READY_FOR_VERIFICATION evidence only.",
  ].join("\n");
}

function executorInvocation(promptFile, queueItemFile, resultFile) {
  const custom = getArg("executor-command");
  if (custom) {
    return {
      cmd: custom,
      args: [
        ...getMultiArg("executor-arg"),
        "--queue-item-file", queueItemFile,
        "--prompt-file", promptFile,
        "--result-file", resultFile,
      ],
    };
  }
  const args = [
    localLlmExecutor,
    "--queue-item-file", queueItemFile,
    "--prompt-file", promptFile,
    "--result-file", resultFile,
    "--process-timeout-ms", getArg("process-timeout-ms", "60000"),
  ];
  const model = getArg("model", process.env.CONNECT_AI_LOCAL_LLM_MODEL || "");
  if (model) args.push("--model", model);
  return { cmd: process.execPath, args };
}

function runExecutor(invocation) {
  const result = spawnSync(invocation.cmd, invocation.args, {
    cwd: repoRoot,
    env: process.env,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    windowsHide: true,
    timeout: Number(getArg("executor-timeout-ms", getArg("process-timeout-ms", "60000"))),
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
  const worker = redact(getArg("worker", "local-llm-worker"), 120);
  const taskId = getArg("id", "");
  const claimArgs = ["claim", "--assignee", "local-llm", "--worker", worker];
  if (taskId) claimArgs.push("--id", taskId);
  const claimed = runQueue(claimArgs);
  if (!claimed.claimed || !claimed.item) {
    console.log(JSON.stringify({ success: true, claimed: false, message: claimed.message, path: claimed.path }, null, 2));
    return;
  }

  const item = claimed.item;
  const runDir = path.join(envPaths.companyDir(), "local-llm-worker");
  fs.mkdirSync(runDir, { recursive: true });
  const runStamp = stamp();
  const queueItemFile = path.join(runDir, `local-llm-worker-${runStamp}-${item.id}.queue-item.json`);
  const promptFile = path.join(runDir, `local-llm-worker-${runStamp}-${item.id}.prompt.md`);
  const resultFile = path.join(runDir, `local-llm-worker-${runStamp}-${item.id}.executor-result.json`);
  const dispatchLogPath = path.join(runDir, `local-llm-worker-${runStamp}-${item.id}.dispatch-log.json`);
  fs.writeFileSync(queueItemFile, `${JSON.stringify(item, null, 2)}\n`, "utf8");
  fs.writeFileSync(promptFile, buildPrompt(item), "utf8");

  const noWriteMonitor = startNoWriteMonitor(item);
  const executor = runExecutor(executorInvocation(promptFile, queueItemFile, resultFile));
  const noWriteViolations = noWriteTaskViolations(noWriteMonitor, executor);
  executor.noWriteTaskViolations = noWriteViolations;
  const evidenceViolation = localExecutor.localSmokeEvidenceViolation(executor.parsedStdout);
  executor.localSmokeEvidenceViolation = evidenceViolation;
  const ok = executor.exitCode === 0
    && executor.parsedStdout
    && executor.parsedStdout.success !== false
    && noWriteViolations.length === 0
    && !evidenceViolation;
  const status = ok ? "ready_for_verification" : "blocked";
  const resultSummary = ok
    ? [
      "READY_FOR_VERIFICATION: local-llm queue worker returned smoke evidence.",
      "No files changed.",
      `Commands run: ${commandLine(executor)}`,
      `Current-run expected tests/evidence: local-smoke executor exit 0; evidence log: ${dispatchLogPath}`,
      "Unresolved failures: none.",
    ].join(" ")
    : noWriteViolations.length
      ? `BLOCKED: local-llm queue worker failed contract check (NO_WRITE_WORKER_MODIFIED_FILES: ${noWriteViolations.map((entry) => entry.path).join(", ")}). Evidence log: ${dispatchLogPath}`
      : evidenceViolation
        ? `BLOCKED: local-llm queue worker failed contract check (${evidenceViolation}). Evidence log: ${dispatchLogPath}`
      : `BLOCKED: local-llm queue worker failed exit=${executor.exitCode}. Evidence log: ${dispatchLogPath}`;
  const updated = updateTask(item.id, status, resultSummary);
  const log = {
    schema: "connect-ai.local-llm-worker-log.v1",
    generatedAt: new Date().toISOString(),
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
