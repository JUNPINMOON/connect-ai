#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const { buildVerificationPrompt, hasVerifierRequiredEvidence, sourceIdFromText, verdictFromSummary } = require("./verification-dispatch.js");
const { noWriteTaskViolations, startNoWriteMonitor } = require("./no-write-monitor.js");

const repoRoot = path.resolve(__dirname, "..");
const queueCli = path.join(__dirname, "agent-queue.js");
const antigravityReviewer = path.join(__dirname, "antigravity-reviewer.js");

function getArg(name, fallback = "") {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return fallback;
  return process.argv[idx + 1] || fallback;
}

function redact(text, maxLen = 3000) {
  let value = String(text ?? "");
  value = value.replace(/\bAuthorization\s*:\s*Bearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi, "Authorization: Bearer <redacted>");
  value = value.replace(/\b((?:token|secret|password|passwd|api[_-]?key|client[_-]?secret|authorization|cookie|localStorage)\b\s*[:=]\s*)["']?[^"'\s,}]+/gi, "$1<redacted>");
  value = value.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi, "Bearer <redacted>");
  value = value.trim();
  return value.length > maxLen ? `${value.slice(0, maxLen)}\n...[truncated]` : value;
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

function isReadOnlyTask(task) {
  const text = `${task.title || ""}\n${task.prompt || ""}`;
  return /read-?only|읽기\s*전용|파일\s*수정\s*금지|수정\s*금지|do not edit|do not modify|review|audit|검토|감사|분석/i.test(text);
}

function buildPrompt(task, verifierSourceTask = null, promptOptions = {}) {
  const files = Array.isArray(task.files) && task.files.length
    ? `\n\nRelevant files/directories:\n${task.files.map((file) => `- ${file}`).join("\n")}`
    : "";
  const taskPrompt = verifierSourceTask
    ? buildVerificationPrompt(verifierSourceTask, promptOptions)
    : task.prompt;
  return [
    "You are a Connect AI Google reviewer worker.",
    "You are read-only. Do not edit, create, delete, move, send, deploy, buy, authenticate, or approve anything.",
    "Do not claim user approval. Do not close approval gates.",
    "Do not touch broker/live/order/token/balance/harness/baseline/protected-path workflows.",
    "Return concise evidence, residual risk, and next safe action.",
    "",
    `Task id: ${task.id}`,
    `Title: ${task.title}`,
    `Priority: ${task.priority}`,
    files,
    "",
    "Task prompt:",
    taskPrompt,
  ].join("\n");
}

function parseAntigravityOutput(stdout) {
  try {
    const parsed = JSON.parse(stdout);
    return {
      ok: Boolean(parsed.success),
      text: parsed.response || parsed.stderr || stdout,
      meta: parsed,
    };
  } catch {
    return { ok: Boolean(String(stdout || "").trim()), text: stdout, meta: null };
  }
}

function runAntigravity(prompt, timeout) {
  const result = spawnSync(process.execPath, [antigravityReviewer, "--prompt", prompt, "--timeout", timeout], {
    cwd: repoRoot,
    env: process.env,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    windowsHide: true,
    timeout: Number(getArg("process-timeout-ms", "420000")),
  });
  const parsed = parseAntigravityOutput(result.stdout);
  return {
    ok: result.status === 0 && parsed.ok,
    exitCode: result.status ?? 1,
    text: parsed.text,
    stderr: result.stderr,
  };
}

function runGemini(prompt, timeout) {
  const geminiBin = getArg("gemini-bin", "gemini");
  const env = { ...process.env };
  delete env.GEMINI_API_KEY;
  const processTimeout = Number(getArg("process-timeout-ms", timeout === "2m" ? "150000" : "420000"));
  let result;
  let promptFile = "";
  if (process.platform === "win32") {
    promptFile = path.join(os.tmpdir(), `connect-ai-gemini-prompt-${process.pid}-${Date.now()}.txt`);
    fs.writeFileSync(promptFile, prompt, "utf8");
    env.GEMINI_WORKER_PROMPT_FILE = promptFile;
    const command = [
      "$utf8NoBom = New-Object System.Text.UTF8Encoding $false;",
      "[Console]::InputEncoding = $utf8NoBom;",
      "[Console]::OutputEncoding = $utf8NoBom;",
      "$OutputEncoding = $utf8NoBom;",
      "$prompt = Get-Content -Raw -Encoding UTF8 -LiteralPath $env:GEMINI_WORKER_PROMPT_FILE;",
      "$prompt | gemini --skip-trust --approval-mode plan --output-format json --prompt 'Read the stdin task and answer concisely.'",
    ].join(" ");
    result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], {
      cwd: repoRoot,
      env,
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
      windowsHide: true,
      timeout: processTimeout,
    });
    try { fs.unlinkSync(promptFile); } catch {}
  } else {
    result = spawnSync(geminiBin, ["--skip-trust", "--approval-mode", "plan", "--output-format", "json", "--prompt", "Read the stdin task and answer concisely."], {
      cwd: repoRoot,
      env,
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
      windowsHide: true,
      input: prompt,
      timeout: processTimeout,
    });
  }
  let text = result.stdout || result.stderr || result.error?.message || "";
  try {
    const parsed = JSON.parse(String(result.stdout || "").trim());
    text = parsed.response || parsed.text || result.stdout;
  } catch {
    // Gemini may return plain text depending on CLI settings/version.
  }
  return {
    ok: result.status === 0 && Boolean(String(text || "").trim()),
    exitCode: result.status ?? 1,
    text,
    stderr: result.stderr,
  };
}

function updateTask(id, status, summary) {
  return runQueue(updateArgsForTask(id, status, summary));
}

function isVerifierTask(task) {
  return task && (task.role === "verifier" || task.intent === "verification" || /^Verification request:/i.test(String(task.title || "")));
}

function loadVerifierSourceTask(task) {
  const sourceId = sourceIdFromText(`${task.prompt || ""}\n${task.resultSummary || ""}`);
  if (!sourceId) return null;
  try {
    const result = runQueue(["get", "--id", sourceId]);
    return result.item || null;
  } catch {
    return null;
  }
}

function updateArgsForTask(taskOrId, status, summary) {
  const task = typeof taskOrId === "string" ? { id: taskOrId } : taskOrId || {};
  const args = ["update", "--id", task.id, "--status", status, "--result-summary", summary];
  if (status === "done" && isVerifierTask(task) && hasVerifierRequiredEvidence({ resultSummary: summary })) args.push("--verified");
  return args;
}

function finalizeReviewerResult(task, result, assignee) {
  const noWriteViolations = Array.isArray(result.noWriteTaskViolations) ? result.noWriteTaskViolations : [];
  if (noWriteViolations.length) {
    return {
      status: "blocked",
      summary: redact(`BLOCKED: ${assignee} reviewer failed contract check (NO_WRITE_REVIEWER_MODIFIED_FILES: ${noWriteViolations.map((entry) => entry.path).join(", ")}).`, 3000),
    };
  }
  if (!result.ok) {
    return {
      status: "blocked",
      summary: redact(`${assignee} reviewer failed exit=${result.exitCode}. ${result.text || result.stderr || "No output."}`, 3000),
    };
  }
  const summary = redact(result.text, 3000);
  if (isVerifierTask(task) && !verdictFromSummary(summary)) {
    return {
      status: "blocked",
      summary: redact(`BLOCKED: verifier output missing explicit verifier verdict. Expected 검증 판정: accept|reject|needs_human. Output: ${summary}`, 3000),
    };
  }
  if (isVerifierTask(task) && !hasVerifierRequiredEvidence({ resultSummary: summary })) {
    return {
      status: "blocked",
      summary: redact(`BLOCKED: verifier output missing required verifier evidence. Expected non-empty 근거 and 누락 증거 sections. Output: ${summary}`, 3000),
    };
  }
  return { status: "done", summary };
}

function main() {
  const assignee = getArg("assignee", "antigravity").toLowerCase();
  if (!["gemini", "antigravity"].includes(assignee)) {
    console.log(JSON.stringify({ success: false, error: "assignee must be gemini or antigravity" }, null, 2));
    process.exit(2);
  }
  const worker = redact(getArg("worker", `${assignee}-reviewer`), 120);
  const taskId = getArg("id", "");
  const claimArgs = ["claim", "--assignee", assignee, "--worker", worker];
  if (taskId) claimArgs.push("--id", taskId);
  const claimed = runQueue(claimArgs);
  if (!claimed.claimed || !claimed.item) {
    console.log(JSON.stringify({ success: true, claimed: false, message: claimed.message, path: claimed.path }, null, 2));
    return;
  }

  const task = claimed.item;
  if (!isReadOnlyTask(task)) {
    const summary = `${assignee} worker blocked: task is not explicitly read-only/review/audit. Google reviewers cannot edit or approve work.`;
    const updated = updateTask(task, "blocked", summary);
    console.log(JSON.stringify({ success: false, task: { id: task.id, title: task.title }, status: updated.item?.status || "blocked", resultSummary: updated.item?.resultSummary || summary }, null, 2));
    return;
  }

  const verifierSourceTask = isVerifierTask(task) ? loadVerifierSourceTask(task) : null;
  const prompt = buildPrompt(task, verifierSourceTask);
  const timeout = getArg("print-timeout", "5m");
  const noWriteMonitor = startNoWriteMonitor(task);
  const result = assignee === "antigravity" ? runAntigravity(prompt, timeout) : runGemini(prompt, timeout);
  result.noWriteTaskViolations = noWriteTaskViolations(noWriteMonitor, result);
  const finalized = finalizeReviewerResult(task, result, assignee);
  const status = finalized.status;
  const summary = finalized.summary;
  const updated = updateTask(task, status, summary);
  const queueStatus = updated.item?.status || status;
  const queueSummary = updated.item?.resultSummary || summary;

  console.log(JSON.stringify({
    success: result.ok,
    task: { id: task.id, title: task.title },
    assignee,
    status: queueStatus,
    exitCode: result.exitCode,
    resultSummary: queueSummary,
  }, null, 2));
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.log(JSON.stringify({ success: false, error: redact(error.message) }, null, 2));
    process.exit(1);
  }
}

module.exports = {
  buildPrompt,
  finalizeReviewerResult,
  isReadOnlyTask,
  isVerifierTask,
  loadVerifierSourceTask,
  parseAntigravityOutput,
  redact,
  updateArgsForTask,
};
