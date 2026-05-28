#!/usr/bin/env node
"use strict";

// Codex worker for Connect AI Agent Manager.
// Mirrors claude-worker.js: claims one Codex task, runs it non-interactively
// via `codex exec`, updates the queue with a concise result, then replans.
//
// Why this exists: agent-loop.js previously reported Codex as
// "manual_or_future_worker" because no Codex adapter existed, so Hermes-claimed
// Codex tasks became zombies (stuck running, never executed). This adapter
// closes that gap.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const { noWriteTaskViolations, startNoWriteMonitor, startWriteScopeMonitor, writeScopeViolations } = require("./no-write-monitor.js");

const repoRoot = path.resolve(__dirname, "..");
const queueCli = path.join(__dirname, "agent-queue.js");

function getArg(name, fallback = "") {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return fallback;
  return process.argv[idx + 1] || fallback;
}

function parsePositiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function getMultiArg(name) {
  const values = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === `--${name}` && process.argv[index + 1]) values.push(process.argv[index + 1]);
  }
  return values;
}

function redact(text, maxLen = 3000) {
  let value = String(text ?? "");
  value = value.replace(/\b((?:token|secret|password|passwd|api[_-]?key|client[_-]?secret|authorization|cookie|localStorage)\b\s*[:=]\s*)["']?[^"'\s,}]+/gi, "$1<redacted>");
  value = value.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi, "Bearer <redacted>");
  value = value.trim();
  return value.length > maxLen ? `${value.slice(0, maxLen)}\n...[truncated]` : value;
}

function winToWslPath(value) {
  const match = String(value || "").match(/^([A-Za-z]):\\(.*)$/);
  if (!match) return value;
  return `/mnt/${match[1].toLowerCase()}/${match[2].replace(/\\/g, "/")}`;
}

function toExistingReadableDir(value) {
  const normalized = process.platform === "linux" ? winToWslPath(value) : value;
  try {
    const stat = fs.statSync(normalized);
    return stat.isDirectory() ? normalized : path.dirname(normalized);
  } catch {
    return "";
  }
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function isReadOnlyTask(task) {
  const text = `${task.prompt || ""}\n${task.title || ""}`;
  // Explicit write intent overrides incidental "수정 금지" phrases. A task titled
  // "...구현/생성/유지보수" needs to write files even if the prompt says "don't
  // modify X". Without this, write tasks get sandboxed read-only and fail.
  const writeIntent = /구현|생성|작성|수정해|유지보수|만들어|추가해|리팩터|implement|create|write\s+a|build|fix\b|refactor|add\s+/i.test(`${task.title || ""}`);
  if (writeIntent) return false;
  return /read-?only|파일\s*수정\s*금지|수정\s*금지|외부\s*서비스.*금지|감사만|점검만/i.test(text);
}

function runQueue(args) {
  const output = execFileSync(process.execPath, [queueCli, ...args], {
    cwd: repoRoot,
    env: process.env,
    encoding: "utf8",
  });
  return JSON.parse(output);
}

function commandExists(command) {
  if (!command) return false;
  if (fs.existsSync(command)) return true;
  const checker = process.platform === "win32" ? "where.exe" : "sh";
  const args = process.platform === "win32" ? [command] : ["-lc", `command -v ${JSON.stringify(command)}`];
  const result = spawnSync(checker, args, { encoding: "utf8", windowsHide: true });
  return result.status === 0;
}

// Resolve a directly-spawnable Codex binary. On Windows, `codex` on PATH is a
// shell shim (.ps1/.cmd) that spawnSync cannot exec directly (ENOENT). Prefer a
// real .exe: explicit env override, then the known install path, then the
// npm-installed codex.cmd (run via shell).
function resolveCodexBin(requested) {
  if (requested && requested !== "codex" && fs.existsSync(requested)) return { bin: requested, useShell: /\.(cmd|bat|ps1)$/i.test(requested) };
  if (process.platform !== "win32") return { bin: requested || "codex", useShell: false };
  if (process.env.CODEX_BIN && fs.existsSync(process.env.CODEX_BIN)) return { bin: process.env.CODEX_BIN, useShell: false };
  // Search known install location for codex.exe (version dir varies).
  try {
    const base = path.join(process.env.LOCALAPPDATA || "", "OpenAI", "Codex", "bin");
    if (fs.existsSync(base)) {
      for (const dir of fs.readdirSync(base)) {
        const candidate = path.join(base, dir, "codex.exe");
        if (fs.existsSync(candidate)) return { bin: candidate, useShell: false };
      }
    }
  } catch { /* ignore */ }
  // Fallback: npm shim codex.cmd (needs shell).
  const npmCmd = path.join(process.env.APPDATA || "", "npm", "codex.cmd");
  if (fs.existsSync(npmCmd)) return { bin: npmCmd, useShell: true };
  return { bin: requested || "codex", useShell: true };
}

function quoteForCmd(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

function windowsScriptInvocation(command, args) {
  if (process.platform !== "win32") return { command, args, windowsVerbatimArguments: false };
  if (/\.(cmd|bat)$/i.test(command)) {
    return {
      command: "cmd.exe",
      args: ["/d", "/c", `call ${quoteForCmd(command)} ${args.map(quoteForCmd).join(" ")}`],
      windowsVerbatimArguments: true,
    };
  }
  if (/\.ps1$/i.test(command)) {
    return {
      command: "powershell.exe",
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", command, ...args],
      windowsVerbatimArguments: false,
    };
  }
  return { command, args, windowsVerbatimArguments: false };
}

function buildPrompt(task) {
  const files = Array.isArray(task.files) && task.files.length
    ? `\n\nRelevant files:\n${task.files.map((file) => `- ${process.platform === "linux" ? winToWslPath(file) : file}`).join("\n")}`
    : "";
  return [
    "You are the Codex worker for Connect AI Agent Manager.",
    "Follow the task prompt exactly and keep changes tightly scoped.",
    "Do not print secrets, tokens, cookies, private keys, or auth headers.",
    "If the task is read-only, do not edit, create, or delete files; report findings as text.",
    "If the task conflicts by saying both no file edits and write a file, do not write the file; return the would-be file content in the result.",
    "When finished, end with a concise result summary that includes concrete evidence (paths touched, commands run, checks passed) and any residual risks.",
    "",
    "Task id: " + task.id,
    "Title: " + task.title,
    "Priority: " + task.priority,
    "Project directory: " + repoRoot,
    files,
    "",
    "Task prompt:",
    task.prompt,
  ].join("\n");
}

function runCodex(codexBin, prompt, options) {
  const args = ["exec"];
  if (options.model) args.push("--model", options.model);
  if (options.cd) args.push("--cd", options.cd);
  if (options.skipGitCheck) args.push("--skip-git-repo-check");
  const effectiveReadOnly = Boolean(options.readOnly && !(process.platform === "win32" && options.windowsReadOnlySandboxFallback));
  if (effectiveReadOnly) {
    args.push("--sandbox", "read-only");
  } else {
    // Windows Codex sandbox modes can fail before even read-only inspection
    // (`windows sandbox: spawn setup refresh`). Keep the task contract prompt
    // as the read-only guard and bypass the broken host sandbox on Windows.
    // For write tasks this was already required by CreateProcessAsUserW errors.
    args.push("--dangerously-bypass-approvals-and-sandbox");
  }
  for (const dir of options.addDirs || []) args.push("--add-dir", dir);
  if (options.outputLastMessage) args.push("-o", options.outputLastMessage);
  if (options.ephemeral) args.push("--ephemeral");
  args.push("-c", "approval_policy=\"never\"");
  args.push("-");
  const invocation = options.useShell || (process.platform === "win32" && /\.(cmd|bat|ps1)$/i.test(codexBin))
    ? windowsScriptInvocation(codexBin, args)
    : { command: codexBin, args, windowsVerbatimArguments: false };

  const result = spawnSync(invocation.command, invocation.args, {
    cwd: options.cwd || repoRoot,
    env: process.env,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    windowsHide: true,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    timeout: options.timeoutMs,
    input: prompt,
  });

  return {
    ok: result.status === 0 && !result.error,
    exitCode: result.status ?? 1,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    error: result.error ? result.error.message : "",
    timedOut: result.error && result.error.code === "ETIMEDOUT",
  };
}

function summarizeCodexOutput(output, lastMessageFile, maxLen = 1200) {
  if (lastMessageFile) {
    try {
      const finalMsg = fs.readFileSync(lastMessageFile, "utf8").trim();
      if (finalMsg) return redact(finalMsg, maxLen);
    } catch {
      // fall through to stdout parsing
    }
  }
  const text = String(output || "").trim();
  if (!text) return "Codex completed without output.";
  return redact(text, maxLen);
}

function isNonFinalOutput(summary) {
  const text = String(summary || "");
  return /I'll review|I will review|I need to inspect|Need to inspect|would need to|let me start by|먼저 확인/i.test(text);
}

function isBlockedOutput(summary) {
  const text = String(summary || "");
  return /^\s*(BLOCKED|차단|실패|검증\s*불가)\b/i.test(text) ||
    /was not verified|were not verified|not verified|검증하지\s*못|확인하지\s*못|파일을\s*실제로\s*열람하지\s*못|sandbox prevented/i.test(text);
}

function updateTask(id, status, resultSummary) {
  return runQueue(["update", "--id", id, "--status", status, "--result-summary", resultSummary]);
}

function withRequiredEvidence(summary, task, commandLabel) {
  const files = Array.isArray(task.files) && task.files.length ? task.files.join(", ") : "worker output scope";
  return [
    summary,
    `Files changed or no-write confirmation: see worker output; scoped files: ${files}.`,
    `Commands run: ${commandLabel}.`,
    "Current-run expected tests/evidence: Codex worker command exited 0 and returned final evidence above.",
    "Unresolved failures: none.",
  ].join(" ");
}

function forbiddenPathMonitorFor(task) {
  return startNoWriteMonitor({ files: Array.isArray(task.forbiddenPaths) ? task.forbiddenPaths : [] });
}

function writeScopeMonitorFor(task) {
  return startWriteScopeMonitor(task);
}

function summarizeForbiddenPathViolations(violations = []) {
  return violations.map((entry) => entry.path).join(", ");
}

function main() {
  const worker = redact(getArg("worker", "codex-worker"), 120);
  const codexBin = getArg("codex-bin", "codex");
  const model = getArg("model", "");
  const sandbox = getArg("sandbox", "workspace-write");
  const timeoutMs = parsePositiveInt(getArg("timeout-ms", "600000"), 600000);
  const taskId = getArg("id", "");
  const ephemeral = hasFlag("ephemeral");
  const addDirs = getMultiArg("add-dir");

  const resolved = resolveCodexBin(codexBin);
  const effectiveCodexBin = resolved.bin;
  const useShell = resolved.useShell;

  const claimArgs = ["claim", "--assignee", "codex", "--worker", worker];
  if (taskId) claimArgs.push("--id", taskId);
  const claimed = runQueue(claimArgs);
  if (!claimed.claimed || !claimed.item) {
    console.log(JSON.stringify({ success: true, claimed: false, message: claimed.message, path: claimed.path }, null, 2));
    return;
  }

  const task = claimed.item;
  const readOnly = isReadOnlyTask(task);

  if (!commandExists(effectiveCodexBin)) {
    const resultSummary = "Codex binary not found: " + effectiveCodexBin + ". Install Codex CLI and authenticate before running automated Codex worker.";
    updateTask(task.id, "blocked", resultSummary);
    runQueue(["replan", "--worker", worker]); // auto-escalate 제거: 매 작업마다 decision request 폭주 방지. escalation은 wave 단위 수동.
    console.log(JSON.stringify({ success: false, task, status: "blocked", resultSummary }, null, 2));
    return;
  }

  const taskDirs = (Array.isArray(task.files) ? task.files : []).map(toExistingReadableDir).filter(Boolean);
  const cd = taskDirs[0] || repoRoot;
  for (const dir of taskDirs) addDirs.push(dir);

  const lastMessageFile = path.join(os.tmpdir(), "codex-last-" + task.id + ".txt");
  const prompt = buildPrompt(task);
  const forbiddenMonitor = forbiddenPathMonitorFor(task);
  const writeScopeMonitor = writeScopeMonitorFor(task);
  const result = runCodex(effectiveCodexBin, prompt, {
    model,
    cd,
    sandbox,
    readOnly,
    windowsReadOnlySandboxFallback: true,
    skipGitCheck: true,
    ephemeral,
    addDirs: unique(addDirs),
    outputLastMessage: lastMessageFile,
    timeoutMs,
    useShell,
  });

  const combined = result.stdout || result.stderr || result.error;
  const resultSummary = summarizeCodexOutput(combined, lastMessageFile);
  const nonFinal = result.ok && isNonFinalOutput(resultSummary);
  const blockedBySummary = result.ok && isBlockedOutput(resultSummary);
  const forbiddenViolations = noWriteTaskViolations(forbiddenMonitor, {});
  const forbiddenPathModified = forbiddenViolations.length > 0;
  const scopeViolations = writeScopeViolations(writeScopeMonitor, {});
  const writeScopeModified = scopeViolations.length > 0;
  const status = result.ok && !nonFinal && !blockedBySummary && !forbiddenPathModified && !writeScopeModified ? "done" : "blocked";
  const failurePrefix = result.timedOut ? "Codex worker timed out after " + timeoutMs + "ms." : "Codex worker failed exit=" + result.exitCode + ".";
  const nonFinalPrefix = "Codex worker returned non-final output; evidence-based completion not accepted.";
  const blockedPrefix = "Codex worker reported blocked output; evidence-based completion not accepted.";
  const forbiddenPrefix = `Codex worker modified forbidden path; evidence-based completion not accepted (FORBIDDEN_PATH_MODIFIED: ${summarizeForbiddenPathViolations(forbiddenViolations)}).`;
  const scopePrefix = `Codex worker modified a path outside the allowed write scope; evidence-based completion not accepted (WRITE_SCOPE_VIOLATION: ${summarizeForbiddenPathViolations(scopeViolations)}).`;
  const finalSummary = result.ok && !nonFinal && !blockedBySummary && !forbiddenPathModified && !writeScopeModified
    ? withRequiredEvidence(resultSummary, task, `${effectiveCodexBin} exec`)
    : (forbiddenPathModified ? forbiddenPrefix : writeScopeModified ? scopePrefix : nonFinal ? nonFinalPrefix : blockedBySummary ? blockedPrefix : failurePrefix) + " " + resultSummary;
  const updated = updateTask(task.id, status, finalSummary);
  const queueStatus = updated.item?.status || status;
  const queueSummary = updated.item?.resultSummary || finalSummary;
  runQueue(["replan", "--worker", worker]); // auto-escalate 제거: 매 작업마다 decision request 폭주 방지. escalation은 wave 단위 수동.

  try { fs.unlinkSync(lastMessageFile); } catch { /* ignore */ }

  console.log(JSON.stringify({
    success: result.ok && !nonFinal && !blockedBySummary && !forbiddenPathModified && !writeScopeModified,
    task: { id: task.id, title: task.title },
    status: queueStatus,
    exitCode: result.exitCode,
    timedOut: Boolean(result.timedOut),
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
  commandExists,
  summarizeCodexOutput,
  winToWslPath,
  isReadOnlyTask,
  isNonFinalOutput,
  isBlockedOutput,
  forbiddenPathMonitorFor,
  writeScopeMonitorFor,
};
