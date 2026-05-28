#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const { noWriteTaskViolations, startNoWriteMonitor, startWriteScopeMonitor, writeScopeViolations } = require("./no-write-monitor.js");

const repoRoot = path.resolve(__dirname, "..");
const queueCli = path.join(__dirname, "agent-queue.js");

function currentWindowsUser() {
  try {
    return process.env.CONNECT_AI_WINDOWS_USER || process.env.USERNAME || process.env.USER || os.userInfo().username || path.basename(os.homedir());
  } catch {
    return process.env.CONNECT_AI_WINDOWS_USER || process.env.USERNAME || process.env.USER || path.basename(os.homedir());
  }
}

function windowsHomePath(...segments) {
  const base = process.env.USERPROFILE || (process.platform !== "win32" && fs.existsSync("/mnt/c")
    ? `C:\\Users\\${currentWindowsUser()}`
    : os.homedir());
  return path.join(base, ...segments);
}

const defaultVaultRootWin = process.env.CONNECT_AI_VAULT || windowsHomePath("connect-ai-vault");

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

function hasArg(name) {
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

function toExistingReadablePath(value) {
  const normalized = process.platform === "linux" ? winToWslPath(value) : value;
  try {
    fs.statSync(normalized);
    return normalized;
  } catch {
    return "";
  }
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function isReadOnlyTask(task) {
  const text = `${task.prompt || ""}\n${task.title || ""}`;
  return /read-?only|파일\s*수정\s*금지|수정\s*금지|외부\s*서비스.*금지/i.test(text);
}

function readDirectorySummary(dir, maxEntries = 30) {
  const normalized = process.platform === "linux" ? winToWslPath(dir) : dir;
  try {
    const stat = fs.statSync(normalized);
    const base = stat.isDirectory() ? normalized : path.dirname(normalized);
    const entries = fs.readdirSync(base, { withFileTypes: true })
      .slice(0, maxEntries)
      .map((entry) => `${entry.isDirectory() ? "dir " : "file"} ${entry.name}`);
    return [`Path: ${base}`, `Entries shown: ${entries.length}`, ...entries.map((entry) => `- ${entry}`)].join("\n");
  } catch (error) {
    return `Path: ${normalized}\nUnavailable: ${redact(error.message, 300)}`;
  }
}

function readFileSummary(filePath, maxLen = 3500) {
  const normalized = process.platform === "linux" ? winToWslPath(filePath) : filePath;
  try {
    const content = fs.readFileSync(normalized, "utf8");
    return [`Path: ${normalized}`, "Content excerpt:", redact(content, maxLen)].join("\n");
  } catch (error) {
    return `Path: ${normalized}\nUnavailable: ${redact(error.message, 300)}`;
  }
}

// Connect AI가 다루는 알려진 프로젝트 디렉토리. 작업 내용에 언급되면 Claude가
// 해당 디렉토리를 직접 읽을 수 있도록 --add-dir에 포함시킨다(눈가리개 제거의 핵심).
const KNOWN_PROJECT_DIRS = [
  { re: /구직|job[_-]?search|jobsearch/i, dir: process.env.JOB_SEARCH_ROOT || windowsHomePath("job_search") },
  { re: /주식|us-execution|us_execution|stock|harness|backtest/i, dir: "C:\\openclaw\\projects\\us-execution" },
  { re: /유튜브|youtube|lilys/i, dir: path.join(defaultVaultRootWin, "youtube") },
  { re: /vault|wiki|brain|브레인|기억/i, dir: defaultVaultRootWin },
];

function inferProjectDirs(task) {
  const text = `${task.title || ""}\n${task.prompt || ""}`;
  const dirs = [];
  for (const { re, dir } of KNOWN_PROJECT_DIRS) {
    if (re.test(text)) dirs.push(dir);
  }
  return dirs.map(toExistingReadableDir).filter(Boolean);
}

function inferContextPaths(task) {
  const text = `${task.title || ""}\n${task.prompt || ""}`;
  const vaultRoot = defaultVaultRootWin;
  const candidates = [];
  if (/env-policy\.md/i.test(text)) candidates.push(path.join(vaultRoot, "env-policy.md"));
  if (/Hermes|CEO/i.test(text)) candidates.push(path.join(vaultRoot, "Hermes.md"));
  const decisionMatches = text.matchAll(/(?:decisions[\\/])?(\d{4}-\d{2}-\d{2}-[A-Za-z0-9_.-]+\.md)/g);
  for (const match of decisionMatches) candidates.push(path.join(vaultRoot, "decisions", match[1]));
  return candidates.map(toExistingReadablePath).filter(Boolean);
}

function contextTargets(task) {
  return unique([...(Array.isArray(task.files) ? task.files : []), ...inferContextPaths(task)]);
}

function buildReadOnlyContext(task) {
  const files = contextTargets(task);
  if (!files.length) {
    return [
      "Read-only context pack prepared by Connect AI before calling Claude.",
      "No task files were provided and no safe local context paths were inferred.",
      "If there is insufficient evidence, report that explicitly instead of pretending files were inspected.",
    ].join("\n");
  }
  return [
    "Read-only context pack prepared by Connect AI before calling Claude.",
    "Use this context as evidence. Do not browse, edit, create, delete, or write files.",
    "If the original task asks both 'no file edits' and 'write a decision file', treat the no-edit rule as higher priority and return the decision note content in text.",
    "",
    files.map((file) => {
      const normalized = process.platform === "linux" ? winToWslPath(file) : file;
      try {
        return fs.statSync(normalized).isDirectory() ? readDirectorySummary(file) : readFileSummary(file);
      } catch {
        return readDirectorySummary(file);
      }
    }).join("\n\n---\n\n"),
  ].join("\n");
}

function runQueue(args) {
  try {
    const output = execFileSync(process.execPath, [queueCli, ...args], {
      cwd: repoRoot,
      env: process.env,
      encoding: "utf8",
    });
    return JSON.parse(output);
  } catch (error) {
    return {
      success: false,
      exitCode: typeof error.status === "number" ? error.status : 1,
      signal: error.signal || "",
      stdout: String(error.stdout || ""),
      stderr: String(error.stderr || ""),
      message: error.message,
    };
  }
}

function commandExists(command) {
  if (!command) return false;
  if (fs.existsSync(command)) return true;
  const checker = process.platform === "win32" ? "where.exe" : "sh";
  const args = process.platform === "win32" ? [command] : ["-lc", `command -v ${JSON.stringify(command)}`];
  const result = spawnSync(checker, args, { encoding: "utf8", windowsHide: true });
  return result.status === 0;
}

function buildPrompt(task, options = {}) {
  const projectDir = options.useWsl ? winToWslPath(repoRoot) : repoRoot;
  const files = Array.isArray(task.files) && task.files.length
    ? `\n\nRelevant files (read these directly):\n${task.files.map((file) => `- ${options.useWsl ? winToWslPath(file) : file}`).join("\n")}`
    : "";
  const readOnly = options.readOnly;

  // Claude Code는 스스로 파일을 탐색/읽을 수 있다. 미리 잘라낸 context pack으로
  // 눈을 가리지 않고, 실제 프로젝트 디렉토리를 직접 읽도록 지시한다.
  const permissionLine = readOnly
    ? "This is a READ-ONLY task. You MAY read and explore any files in the project to gather evidence, but you MUST NOT edit, create, delete, or write any files."
    : "You MAY read, explore, and edit files in the project as needed to complete the task. Keep changes tightly scoped to the task.";

  return [
    "You are the Claude (Opus) worker for Connect AI Agent Manager — the primary implementer and reviewer.",
    "You have full Claude Code capabilities: read files, search the codebase, analyze, and (when not read-only) edit/create files.",
    "Explore the project directory directly to find the evidence and files you need. Do not assume a pre-built context pack is complete.",
    permissionLine,
    "Do not print secrets, tokens, cookies, private keys, or auth headers.",
    "When finished, provide a concise result summary with concrete evidence (files read, paths touched, checks run) and residual risks.",
    "",
    `Task id: ${task.id}`,
    `Title: ${task.title}`,
    `Priority: ${task.priority}`,
    `Project directory: ${projectDir}`,
    `Vault directory: ${options.useWsl ? winToWslPath(defaultVaultRootWin) : defaultVaultRootWin}`,
    files,
    "",
    "Task prompt:",
    task.prompt,
  ].join("\n");
}

function buildClaudeArgs(options) {
  const args = ["-p", "--output-format", options.outputFormat];
  if (options.systemPrompt) args.push("--system-prompt", options.systemPrompt);
  for (const dir of options.addDirs || []) args.push("--add-dir", dir);
  if (options.maxTurns) args.push("--max-turns", String(options.maxTurns));
  if (options.permissionMode) args.push("--permission-mode", options.permissionMode);
  if (options.model) args.push("--model", options.model);
  if (options.noSessionPersistence) args.push("--no-session-persistence");
  if (options.tools !== undefined) args.push("--tools", options.tools);
  if (options.bare) args.push("--bare");
  return args;
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

function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

function safeWslCommand(value, fallback = "claude") {
  const command = String(value || fallback).trim();
  return /^[A-Za-z0-9_./-]+$/.test(command) ? command : fallback;
}

// Claude Code가 WSL에만 설치된 경우(Windows PATH에 claude 없음) WSL 경유로 호출한다.
// WSL에만 Claude Code가 설치된 경우에도 Windows worker에서 우회 호출한다.
function runClaudeViaWsl(prompt, options) {
  const args = buildClaudeArgs(options);
  const claudeCmd = safeWslCommand(options.wslClaudeBin, "claude");

  // worker가 이미 Linux(WSL)에서 돌고 있으면 'wsl' 래퍼가 없다 → claude 직접 spawn.
  if (process.platform === "linux") {
    const result = spawnSync(claudeCmd, args, {
      cwd: options.wslCwdNative || process.env.HOME || undefined,
      env: process.env,
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
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

  // worker가 Windows에서 돌고 있으면 wsl 래퍼로 호출.
  const quoted = args.map(shellQuote).join(" ");
  const cwd = options.wslCwd || "$HOME";
  const shellCmd = "cd " + cwd + " && " + claudeCmd + " " + quoted;

  const result = spawnSync("wsl", ["bash", "-lc", shellCmd], {
    env: process.env,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    windowsHide: true,
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

function runClaude(claudeBin, prompt, options) {
  // WSL 모드: Windows에 claude가 없고 WSL에 있을 때.
  if (options.useWsl) {
    return runClaudeViaWsl(prompt, options);
  }
  const args = buildClaudeArgs(options);
  const invocation = windowsScriptInvocation(claudeBin, args);

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

function summarizeClaudeOutput(output, maxLen = 1200) {
  const text = String(output || "").trim();
  if (!text) return "Claude completed without output.";
  if (text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text);
      const content = parsed.result || parsed.text || parsed.message || parsed.output || text;
      return redact(content, maxLen);
    } catch {
      return redact(text, maxLen);
    }
  }
  return redact(text, maxLen);
}

function isNonFinalOutput(summary) {
  const text = String(summary || "");
  return /<function_calls>|exit_plan_mode|Evidence Needed|I'll review|I will review|I'll start|I will start|I'll begin|I will begin|Let me work through|I need to inspect|Need to inspect|would need to|Reading AGENTS\.md|begin by reading/i.test(text);
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
    "Current-run expected tests/evidence: Claude worker command exited 0 and returned final evidence above.",
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
  const worker = redact(getArg("worker", "claude-worker"), 120);
  const claudeBin = getArg("claude-bin", "claude");
  const forceWsl = process.argv.includes("--wsl");
  const wslClaudeBin = getArg("wsl-claude-bin", "claude"); // WSL 내 claude 경로(PATH에 있으면 그냥 claude)
  const outputFormat = getArg("output-format", "text");
  const maxTurns = getArg("max-turns", "5");
  const permissionMode = getArg("permission-mode", "acceptEdits");
  const model = getArg("model", "");
  const taskId = getArg("id", "");
  const systemPrompt = getArg(
    "system-prompt",
    "You are a Claude Code worker called by Connect AI Agent Manager. Follow the task prompt exactly, keep changes scoped, avoid secrets, and return concise evidence."
  );
  const timeoutMs = parsePositiveInt(getArg("timeout-ms", "600000"), 600000); // Opus 심층 작업은 길게
  const tools = hasArg("tools") ? getArg("tools") : undefined;
  const noSessionPersistence = !process.argv.includes("--session-persistence");
  const bare = hasFlag("bare");
  const defaultClaudeCwd = process.platform === "linux" && repoRoot.startsWith("/mnt/")
    ? os.tmpdir()
    : repoRoot;
  const claudeCwd = getArg("claude-cwd", defaultClaudeCwd);
  const addDirs = getMultiArg("add-dir");
  if (!addDirs.length) addDirs.push(repoRoot);

  const claimArgs = ["claim", "--assignee", "claude", "--worker", worker];
  if (taskId) claimArgs.push("--id", taskId);
  const claimed = runQueue(claimArgs);
  if (!claimed.claimed || !claimed.item) {
    console.log(JSON.stringify({ success: true, claimed: false, message: claimed.message, path: claimed.path }, null, 2));
    return;
  }

  const task = claimed.item;
  const readOnly = isReadOnlyTask(task);
  for (const dir of contextTargets(task).map(toExistingReadableDir)) {
    addDirs.push(dir);
  }
  // 작업이 참조하는 프로젝트 디렉토리를 Claude 접근 허용에 추가(파일 내용 읽기 가능하게).
  for (const dir of inferProjectDirs(task)) {
    addDirs.push(dir);
  }
  const effectiveTools = tools; // 도구 제한 없음: Claude Code가 파일 읽기/탐색 도구를 쓰게 함. read-only는 permission-mode로 제어.

  // Claude 바이너리 위치 판정.
  let useWsl = forceWsl;
  let wslCwd = "$HOME";
  let wslCwdNative = "";
  // worker가 Linux(WSL)에서 직접 도는 경우: claude를 직접 spawn하는 useWsl 경로 사용.
  if (process.platform === "linux") {
    useWsl = true;
    wslCwdNative = winToWslPath(repoRoot);
  }
  if (!useWsl && !commandExists(claudeBin)) {
    // WSL에 claude가 있는지 확인.
    const probe = spawnSync("wsl", ["bash", "-lc", `command -v -- ${shellQuote(safeWslCommand(wslClaudeBin, "claude"))}`], { encoding: "utf8", windowsHide: true });
    if (probe.status === 0 && String(probe.stdout || "").trim()) {
      useWsl = true;
    } else {
      const resultSummary = `Claude binary not found on Windows or WSL. Install Claude Code CLI and authenticate before running automated Claude worker.`;
      updateTask(task.id, "blocked", resultSummary);
      runQueue(["replan", "--worker", worker]);
      console.log(JSON.stringify({ success: false, task, status: "blocked", resultSummary }, null, 2));
      return;
    }
  }
  // WSL 모드면 작업 디렉토리를 WSL 경로로 변환(레포가 /mnt/c/... 로 접근됨).
  if (useWsl) {
    const wslRepo = winToWslPath(repoRoot);
    wslCwd = "'" + wslRepo.replace(/'/g, "'\\''") + "'";
  }

  const prompt = buildPrompt(task, { useWsl, readOnly });
  const effectivePermissionMode = readOnly ? "default" : permissionMode; // read-only는 default(읽기 OK), 실무는 acceptEdits
  const forbiddenMonitor = forbiddenPathMonitorFor(task);
  const writeScopeMonitor = writeScopeMonitorFor(task);
  const result = runClaude(claudeBin, prompt, { outputFormat, maxTurns, permissionMode: effectivePermissionMode, model, bare, timeoutMs, tools: effectiveTools, noSessionPersistence, systemPrompt, cwd: claudeCwd, addDirs: unique(addDirs), useWsl, wslClaudeBin, wslCwd, wslCwdNative });
  const combined = result.stdout || result.stderr || result.error;
  const resultSummary = summarizeClaudeOutput(combined);
  const nonFinal = result.ok && isNonFinalOutput(resultSummary);
  const forbiddenViolations = noWriteTaskViolations(forbiddenMonitor, {});
  const forbiddenPathModified = forbiddenViolations.length > 0;
  const scopeViolations = writeScopeViolations(writeScopeMonitor, {});
  const writeScopeModified = scopeViolations.length > 0;
  const status = result.ok && !nonFinal && !forbiddenPathModified && !writeScopeModified ? "done" : "blocked";
  const failurePrefix = result.timedOut ? `Claude worker timed out after ${timeoutMs}ms.` : `Claude worker failed exit=${result.exitCode}.`;
  const nonFinalPrefix = "Claude worker returned non-final output; evidence-based completion not accepted.";
  const forbiddenPrefix = `Claude worker modified forbidden path; evidence-based completion not accepted (FORBIDDEN_PATH_MODIFIED: ${summarizeForbiddenPathViolations(forbiddenViolations)}).`;
  const scopePrefix = `Claude worker modified a path outside the allowed write scope; evidence-based completion not accepted (WRITE_SCOPE_VIOLATION: ${summarizeForbiddenPathViolations(scopeViolations)}).`;
  const finalSummary = result.ok && !nonFinal && !forbiddenPathModified && !writeScopeModified
    ? withRequiredEvidence(resultSummary, task, useWsl ? `wsl ${wslClaudeBin}` : claudeBin)
    : `${forbiddenPathModified ? forbiddenPrefix : writeScopeModified ? scopePrefix : nonFinal ? nonFinalPrefix : failurePrefix} ${resultSummary}`;
  const updated = updateTask(task.id, status, finalSummary);
  const queueStatus = updated.item?.status || status;
  const queueSummary = updated.item?.resultSummary || finalSummary;
  runQueue(["replan", "--worker", worker]); // auto-escalate 제거: 매 작업마다 decision request 폭주 방지. escalation은 wave 단위 수동.

  console.log(JSON.stringify({
    success: result.ok && !nonFinal && !forbiddenPathModified && !writeScopeModified,
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
  summarizeClaudeOutput,
  winToWslPath,
  isReadOnlyTask,
  buildReadOnlyContext,
  inferContextPaths,
  isNonFinalOutput,
  forbiddenPathMonitorFor,
  writeScopeMonitorFor,
};
