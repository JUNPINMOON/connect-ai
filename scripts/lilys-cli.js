#!/usr/bin/env node
"use strict";

const { execFile } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");

const DEFAULT_PORT = "9223";
const VAULT_ROOT = process.env.CONNECT_AI_VAULT || path.join(os.homedir(), "connect-ai-vault");
const VAULT_TOOLS = process.env.CONNECT_AI_VAULT_TOOLS || path.join(VAULT_ROOT, "youtube", "tools");
const NOTIFY_SCRIPT = path.join(__dirname, "windows-notify.ps1");

function normalizePathForWsl(value) {
  if (!value || process.platform !== "linux") return value;
  const text = String(value);
  const match = text.match(/^([A-Za-z]):\\(.*)$/);
  if (!match) return text;
  return `/mnt/${match[1].toLowerCase()}/${match[2].replace(/\\/g, "/")}`;
}

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = execFile(command, args, {
      windowsHide: true,
      maxBuffer: 20 * 1024 * 1024,
      ...options,
    }, (error, stdout, stderr) => {
      const exitCode = error
        ? (typeof error.status === "number" ? error.status : (typeof child.exitCode === "number" ? child.exitCode : 1))
        : 0;
      const text = stdout || stderr || (error ? error.message : "");
      resolve({ exitCode, stdout, stderr, text, ok: exitCode === 0 });
    });
    if (options.stdin !== undefined && child.stdin) child.stdin.end(options.stdin);
  });
}

function redact(text) {
  return String(text || "")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi, "Bearer ***")
    .replace(/\b(idToken|accessToken|refreshToken|password|cookie|authorization)\b(\s*[:=]\s*)("[^"]+"|'[^']+'|[^\s,;}]+)/gi, "$1$2***")
    .replace(/\b(?:sk-|gh[pousr]_|ya29\.)[A-Za-z0-9._-]{12,}\b/g, "***");
}

function parseJson(text) {
  const cleaned = String(text || "").trim();
  if (!cleaned) return null;
  try {
    return JSON.parse(cleaned);
  } catch {
    const firstObject = cleaned.indexOf("{");
    const lastObject = cleaned.lastIndexOf("}");
    if (firstObject >= 0 && lastObject > firstObject) {
      try {
        return JSON.parse(cleaned.slice(firstObject, lastObject + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function baseEnvelope(command, result) {
  return {
    success: result.ok,
    error: result.ok ? null : redact(result.stderr || result.stdout || result.text || "command failed"),
    command,
    exit_code: result.exitCode,
  };
}

function sessionData(parsed) {
  const status = parsed?.status || null;
  const valid = parsed?.ok === true && status === "already_logged_in";
  return {
    valid,
    expires_at: null,
    action_required: valid ? "none" : "login",
    status,
    href: parsed?.href || null,
  };
}

function exportData(parsed) {
  const files = Array.isArray(parsed?.files) ? parsed.files : [];
  const filePath =
    parsed?.file ||
    parsed?.file_path ||
    files.find((file) => String(file).endsWith(".lilys-export.json")) ||
    files[0] ||
    null;
  const prettyFilePath =
    parsed?.prettyFile ||
    parsed?.pretty_file_path ||
    files.find((file) => String(file).endsWith(".pretty.json")) ||
    null;
  const videoId = parsed?.videoId || parsed?.video_id || null;
  return {
    file_path: normalizePathForWsl(filePath),
    pretty_file_path: normalizePathForWsl(prettyFilePath),
    video_id: videoId || (filePath ? path.win32.basename(String(filePath)).replace(/\.lilys-export\.json$/, "") : null),
    title: parsed?.title || null,
    duration_sec: typeof parsed?.duration_sec === "number" ? parsed.duration_sec : null,
    transcript_available: typeof parsed?.transcript_available === "boolean" ? parsed.transcript_available : null,
    raw: parsed || null,
  };
}

async function runPowerShellFile(scriptName, args = []) {
  const scriptPath = path.join(VAULT_TOOLS, scriptName);
  return runPowerShell([
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    scriptPath,
    ...args,
  ]);
}

async function runWindowsNode(scriptName, args = []) {
  const scriptPath = path.join(VAULT_TOOLS, scriptName);
  return runPowerShell([
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    `node ${JSON.stringify(scriptPath)} ${args.map((arg) => JSON.stringify(String(arg))).join(" ")}`,
  ]);
}

async function runPowerShell(args) {
  const candidates = process.platform === "linux" ? ["pwsh.exe", "powershell.exe"] : ["pwsh", "powershell.exe"];
  let lastResult = null;
  for (const command of candidates) {
    const result = await run(command, args);
    lastResult = result;
    if (result.ok || !/ENOENT|not found|not recognized/i.test(result.text)) return result;
  }
  return lastResult;
}

async function sendLoginRequiredNotification(reason) {
  if (process.env.CONNECT_AI_DISABLE_NOTIFICATIONS === "1") {
    return { attempted: false, disabled: true };
  }
  if (process.platform !== "win32" && process.platform !== "linux") {
    return { attempted: false, unsupported_platform: process.platform };
  }
  const title = "Connect AI: Lilys 로그인 필요";
  const body = `Lilys 자동화가 로그인 대기 상태입니다. ${String(reason || "lilys_ensure_login 확인 필요").slice(0, 120)}`;
  const result = await runPowerShell([
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    NOTIFY_SCRIPT,
    "-Title",
    title,
    "-Body",
    body,
  ]);
  return {
    attempted: true,
    ok: result.ok,
    exit_code: result.exitCode,
  };
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const port = process.env.LILYS_CDP_PORT || DEFAULT_PORT;

  if (!command || command === "help") {
    console.log(`Usage:
  node scripts/lilys-cli.js session-check
  node scripts/lilys-cli.js ensure-login
  node scripts/lilys-cli.js submit-url <youtubeUrl>
  node scripts/lilys-cli.js export-json [digestUrl] [videoId]
`);
    return;
  }

  let result;
  if (command === "session-check") {
    result = await runPowerShellFile("invoke-lilys-email-login.ps1", ["-Port", port, "-CheckOnly"]);
  } else if (command === "ensure-login") {
    result = await runPowerShellFile("invoke-lilys-email-login.ps1", ["-Port", port]);
  } else if (command === "submit-url") {
    const youtubeUrl = rest[0];
    if (!youtubeUrl) {
      console.error(JSON.stringify({ success: false, error: "youtube URL is required", command, data: null }, null, 2));
      process.exit(2);
    }
    result = await runWindowsNode("lilys-submit-youtube-cdp.js", ["--port", port, "--url", youtubeUrl]);
  } else if (command === "export-json") {
    const digestUrl = rest[0];
    const videoId = rest[1];
    const args = ["--port", port];
    if (digestUrl) args.push("--digest-url", digestUrl);
    if (videoId) args.push("--video-id", videoId);
    result = await runWindowsNode("lilys-export-json-cdp.js", args);
  } else {
    console.error(`Unknown command: ${command}`);
    process.exit(2);
  }

  const parsed = parseJson(result.text);
  const output = baseEnvelope(command, result);

  if (command === "session-check" || command === "ensure-login") {
    output.data = sessionData(parsed);
    if (!result.ok && parsed?.error) output.error = redact(parsed.error);
    if (command === "ensure-login" && output.data.action_required !== "none") {
      output.data.notification = await sendLoginRequiredNotification(output.data.status || output.error || "login_required");
    }
  } else if (command === "submit-url") {
    output.data = {
      digest_url: parsed?.digestUrl || parsed?.digest_url || parsed?.href || null,
      title: parsed?.title || null,
      ready: Boolean(parsed?.ready),
      raw: parsed || null,
    };
    if (!result.ok && parsed?.error) output.error = redact(parsed.error);
  } else if (command === "export-json") {
    output.data = exportData(parsed);
    if (result.ok && !output.data.file_path) {
      output.success = false;
      output.error = "export completed but no file path was returned";
    }
  }

  if (!parsed && result.text) {
    output.raw_output = redact(result.text).slice(0, 4000);
  }

  console.log(JSON.stringify(output, null, 2));
  if (!output.success) process.exit(result.exitCode || 1);
}

main().catch((error) => {
  console.error(JSON.stringify({ success: false, error: redact(error.message), data: null }, null, 2));
  process.exit(1);
});
