#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const repoRoot = path.resolve(__dirname, "..");

function getArg(name, fallback = "") {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return fallback;
  return process.argv[idx + 1] || fallback;
}

function redact(text, maxLen = 12000) {
  let value = String(text ?? "");
  value = value.replace(/\b((?:token|secret|password|passwd|api[_-]?key|client[_-]?secret|authorization|cookie|localStorage)\b\s*[:=]\s*)["']?[^"'\s,}]+/gi, "$1<redacted>");
  value = value.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi, "Bearer <redacted>");
  value = value.trim();
  return value.length > maxLen ? `${value.slice(0, maxLen)}\n...[truncated]` : value;
}

function resolveCodexBin(requested = "codex") {
  if (requested && requested !== "codex" && fs.existsSync(requested)) return { bin: requested, shell: /\.(cmd|bat|ps1)$/i.test(requested) };
  if (process.platform !== "win32") return { bin: requested || "codex", shell: false };
  if (process.env.CODEX_BIN && fs.existsSync(process.env.CODEX_BIN)) return { bin: process.env.CODEX_BIN, shell: false };
  try {
    const base = path.join(process.env.LOCALAPPDATA || "", "OpenAI", "Codex", "bin");
    if (fs.existsSync(base)) {
      for (const dir of fs.readdirSync(base)) {
        const candidate = path.join(base, dir, "codex.exe");
        if (fs.existsSync(candidate)) return { bin: candidate, shell: false };
      }
    }
  } catch { /* ignore */ }
  const npmShim = path.join(process.env.APPDATA || "", "npm", "codex.cmd");
  if (fs.existsSync(npmShim)) return { bin: npmShim, shell: true };
  return { bin: requested || "codex", shell: process.platform === "win32" };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function buildPrompt(item, promptText) {
  return [
    "You are the Codex executor adapter for Connect AI.",
    "Use the queue item contract exactly. Do not mark this task DONE.",
    "Allowed write scope:",
    ...(item.writeScope || []).map((scope) => `- ${scope}`),
    "Forbidden paths:",
    "- C:\\Users\\mjb58\\connect-ai-vault",
    "- credentials, tokens, deploys, external sends, destructive cleanup",
    "",
    "Return READY_FOR_VERIFICATION with files changed, commands run, unresolved failures, and rollback notes.",
    "",
    "Queue item JSON:",
    JSON.stringify(item, null, 2),
    "",
    "Task prompt:",
    promptText,
  ].join("\n");
}

function buildCodexResult(item, execution = {}) {
  const success = Boolean(execution.success);
  const failure = redact(execution.stderr || execution.error || "codex exec failed", 1000);
  return {
    success,
    status: success ? "READY_FOR_VERIFICATION" : "BLOCKED",
    executor: "codex",
    exitCode: execution.exitCode ?? (success ? 0 : 1),
    filesChanged: Array.isArray(item.filesChanged) ? item.filesChanged : [],
    commandsRun: execution.commandsRun || ["codex exec"],
    unresolvedFailures: success ? [] : [failure],
    evidence: redact(execution.finalMessage || execution.stdout || execution.stderr || execution.error || "", 6000),
  };
}

function runCodex(item, promptText) {
  const resolved = resolveCodexBin(getArg("codex-bin", "codex"));
  const outputFile = path.join(os.tmpdir(), `connect-ai-codex-adapter-${item.id || process.pid}.txt`);
  const args = [
    "exec",
    "--skip-git-repo-check",
    "--dangerously-bypass-approvals-and-sandbox",
    "-c", "approval_policy=\"never\"",
    "-o", outputFile,
    "-",
  ];
  const model = getArg("model");
  if (model) args.splice(1, 0, "--model", model);
  const result = spawnSync(resolved.bin, args, {
    cwd: repoRoot,
    env: process.env,
    encoding: "utf8",
    input: buildPrompt(item, promptText),
    maxBuffer: 20 * 1024 * 1024,
    windowsHide: true,
    shell: resolved.shell,
    timeout: Number(getArg("process-timeout-ms", "420000")),
  });
  let finalMessage = "";
  try { finalMessage = fs.readFileSync(outputFile, "utf8"); } catch { /* ignore */ }
  try { fs.unlinkSync(outputFile); } catch { /* ignore */ }
  return buildCodexResult(item, {
    success: result.status === 0 && !result.error,
    exitCode: result.status ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error?.message || "",
    finalMessage,
  });
}

function main() {
  const queueItemFile = getArg("queue-item-file");
  const promptFile = getArg("prompt-file");
  const resultFile = getArg("result-file");
  if (!queueItemFile || !promptFile) throw new Error("codex-executor-adapter requires --queue-item-file and --prompt-file");
  const item = readJson(queueItemFile);
  const promptText = fs.readFileSync(promptFile, "utf8");
  const result = runCodex(item, promptText);
  if (resultFile) fs.writeFileSync(resultFile, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(result, null, 2));
  if (!result.success) process.exit(1);
}

if (require.main === module) {
  try { main(); }
  catch (error) {
    console.log(JSON.stringify({ success: false, status: "BLOCKED", executor: "codex", error: redact(error.message || String(error), 2000) }, null, 2));
    process.exit(1);
  }
}

module.exports = {
  buildCodexResult,
  buildPrompt,
  readJson,
  redact,
  resolveCodexBin,
  runCodex,
};
