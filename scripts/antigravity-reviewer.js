#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function getArg(name, fallback = "") {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return fallback;
  return process.argv[idx + 1] || fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function fallbackDisabled() {
  return hasFlag("no-fallback") || hasFlag("direct-only");
}

function isDirectSource(source) {
  return /^(agy|antigravity|stdout|transcript)$/i.test(String(source || ""));
}

function redact(text, maxLen = 12000) {
  let value = String(text ?? "");
  value = value.replace(/\bAuthorization\s*:\s*Bearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi, "Authorization: Bearer <redacted>");
  value = value.replace(/\b((?:token|secret|password|passwd|api[_-]?key|client[_-]?secret|authorization|cookie|localStorage)\b\s*[:=]\s*)["']?[^"'\s,}]+/gi, "$1<redacted>");
  value = value.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi, "Bearer <redacted>");
  value = value.trim();
  return value.length > maxLen ? `${value.slice(0, maxLen)}\n...[truncated]` : value;
}

function defaultAgyPath() {
  if (process.env.AGY_BIN) return process.env.AGY_BIN;
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, "agy", "bin", "agy.exe");
  }
  return "agy";
}

function defaultBrainRoot() {
  return path.join(os.homedir(), ".gemini", "antigravity-cli", "brain");
}

function defaultLogRoot() {
  return path.join(os.homedir(), ".gemini", "antigravity-cli", "log");
}

function latestAgyDiagnostic(logRoot = defaultLogRoot(), sinceMs = 0) {
  let entries = [];
  try {
    entries = fs.readdirSync(logRoot, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^cli-.*\.log$/i.test(entry.name))
      .map((entry) => {
        const fullPath = path.join(logRoot, entry.name);
        const stat = fs.statSync(fullPath);
        return { path: fullPath, mtimeMs: stat.mtimeMs };
      })
      .filter((entry) => !sinceMs || entry.mtimeMs + 2000 >= sinceMs)
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
  } catch {
    return { status: "", message: "", log: "" };
  }
  for (const entry of entries.slice(0, 3)) {
    let text = "";
    try { text = fs.readFileSync(entry.path, "utf8"); } catch { continue; }
    const lines = text.split(/\r?\n/).filter(Boolean);
    const quota = [...lines].reverse().find((line) => /RESOURCE_EXHAUSTED|Individual quota reached|quota reached|code 429|HTTP\s*429/i.test(line));
    if (quota) return { status: "RATE_LIMITED", message: redact(quota.replace(/^.*?(RESOURCE_EXHAUSTED|Individual quota|quota reached|429)/i, "$1"), 1000), log: entry.path };
    const authenticated = lines.some((line) => /OAuth: authenticated successfully/i.test(line));
    const streamed = lines.some((line) => /streamGenerateContent\?alt=sse/i.test(line));
    if (authenticated && streamed) return { status: "", message: "", log: entry.path };
    const auth = authenticated ? "" : [...lines].reverse().find((line) => /not logged into Antigravity|OAuth token|AUTH|login/i.test(line));
    if (auth) return { status: "AUTH_EXPIRED", message: redact(auth.replace(/^.*?(not logged|OAuth|AUTH|login)/i, "$1"), 1000), log: entry.path };
  }
  return { status: "", message: "", log: "" };
}

function latestObservedModelLabel(logRoot = defaultLogRoot(), sinceMs = 0) {
  let entries = [];
  try {
    entries = fs.readdirSync(logRoot, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^cli-.*\.log$/i.test(entry.name))
      .map((entry) => {
        const fullPath = path.join(logRoot, entry.name);
        const stat = fs.statSync(fullPath);
        return { path: fullPath, mtimeMs: stat.mtimeMs };
      })
      .filter((entry) => !sinceMs || entry.mtimeMs + 2000 >= sinceMs)
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
  } catch {
    return { label: "", log: "" };
  }
  for (const entry of entries.slice(0, 3)) {
    let text = "";
    try { text = fs.readFileSync(entry.path, "utf8"); } catch { continue; }
    const lines = text.split(/\r?\n/).filter(Boolean);
    for (let idx = lines.length - 1; idx >= 0; idx -= 1) {
      const match = lines[idx].match(/Propagating selected model override to backend:\s*label="([^"]+)"/i);
      if (match) return { label: match[1], log: entry.path };
    }
  }
  return { label: "", log: "" };
}

function modelSelectionState(requestedModelLabel, observedModelLabel) {
  if (!requestedModelLabel) return null;
  return requestedModelLabel === observedModelLabel;
}

function eventContainsMarker(event, marker) {
  if (!marker) return true;
  return JSON.stringify(event).includes(marker);
}

function newestTranscriptFiles(brainRoot, limit = 8) {
  const found = [];
  function walk(dir) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && entry.name === "transcript.jsonl") {
        try {
          found.push({ path: fullPath, mtimeMs: fs.statSync(fullPath).mtimeMs });
        } catch {
          // Ignore disappearing transcript files.
        }
      }
    }
  }
  walk(brainRoot);
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit);
}

function extractModelResponseFromTranscript(filePath) {
  let lines = [];
  try {
    lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean);
  } catch {
    return "";
  }
  const responses = [];
  const answerTypes = new Set(["PLANNER_RESPONSE", "GENERIC"]);
  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      const content = typeof event.content === "string" ? event.content.trim() : "";
      if (event.source === "MODEL" && answerTypes.has(String(event.type || "")) && content) {
        if (/^Created At:/i.test(content)) continue;
        if (/^Your current permission grants/i.test(content)) continue;
        responses.push(content);
      }
    } catch {
      // Transcript is append-only JSONL. Skip partial lines.
    }
  }
  for (let i = responses.length - 1; i >= 0; i -= 1) {
    const response = responses[i];
    if (response.length >= 80 || /"tasks"\s*:|"agent"\s*:|"brief"\s*:|```/.test(response)) {
      return response;
    }
  }
  return responses.at(-1) || "";
}

function transcriptContainsMarker(filePath, marker) {
  if (!marker) return true;
  let lines = [];
  try {
    lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean);
  } catch {
    return false;
  }
  for (const line of lines) {
    try {
      if (eventContainsMarker(JSON.parse(line), marker)) return true;
    } catch {
      // Ignore partial JSONL lines.
    }
  }
  return false;
}

function extractLatestModelResponse(brainRoot, sinceMs = 0, marker = "") {
  for (const file of newestTranscriptFiles(brainRoot)) {
    if (sinceMs && file.mtimeMs + 2000 < sinceMs) continue;
    if (!transcriptContainsMarker(file.path, marker)) continue;
    const response = extractModelResponseFromTranscript(file.path);
    if (response) return { response, transcript: file.path };
  }
  return { response: "", transcript: "" };
}

function stripCliNoise(text) {
  return String(text || "")
    .split(/\r?\n/)
    .filter((line) => !/^Warning:/i.test(line.trim()))
    .filter((line) => !/^Ripgrep is not available/i.test(line.trim()))
    .join("\n")
    .trim();
}

function looksLikeCliFailureResponse(response) {
  const text = String(response || "").trim();
  if (!text) return true;
  if (/핵심\s*판정/.test(text) && /발견한\s*문제/.test(text) && /검증\s*명령/.test(text)) return false;
  return /RESOURCE_EXHAUSTED|quota|rate limit|429|authentication|auth expired|failed to sign in|consent could not be obtained|cli failed|failed exit=\d+|all agents.*failed|모든 에이전트.*실패|CEO 호출 실패|error:/i.test(text);
}

function geminiCliInvocation() {
  if (process.platform === "win32" && process.env.APPDATA) {
    const bundle = path.join(process.env.APPDATA, "npm", "node_modules", "@google", "gemini-cli", "bundle", "gemini.js");
    if (fs.existsSync(bundle)) return { cmd: process.execPath, argsPrefix: [bundle], shell: false };
  }
  return { cmd: "gemini", argsPrefix: [], shell: process.platform === "win32" };
}

function runGeminiFallback(prompt, timeoutMs) {
  const env = { ...process.env };
  delete env.GEMINI_API_KEY;
  const invocation = geminiCliInvocation();
  let promptFile = "";
  let promptArg = prompt;
  let input = "";
  if (String(prompt).length > 20000) {
    promptFile = path.join(os.tmpdir(), `connect-ai-gemini-fallback-${process.pid}-${Date.now()}.txt`);
    fs.writeFileSync(promptFile, prompt, "utf8");
    promptArg = `Read the UTF-8 request file at ${promptFile} and answer the request inside it.`;
  }
  const result = spawnSync(invocation.cmd, [...invocation.argsPrefix, "--skip-trust", "--approval-mode", "plan", "--output-format", "text", "--prompt", promptArg], {
    cwd: process.cwd(),
    env,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    windowsHide: true,
    shell: invocation.shell,
    timeout: timeoutMs,
    input,
  });
  if (promptFile) {
    try { fs.unlinkSync(promptFile); } catch { /* best effort cleanup */ }
  }
  return {
    exitCode: result.status ?? 1,
    response: stripCliNoise(result.stdout),
    stderr: redact(result.stderr || result.error?.message || "", 2000),
  };
}

function runGeminiFallbackWithRetries(prompt, timeoutMs, attempts = 2) {
  const results = [];
  const count = Math.max(1, Number(attempts) || 1);
  for (let attempt = 1; attempt <= count; attempt += 1) {
    const result = runGeminiFallback(prompt, timeoutMs);
    results.push({ attempt, ...result });
    if (result.exitCode === 0 && result.response) return { result, attempts: results };
  }
  return { result: results.at(-1) || { exitCode: 1, response: "", stderr: "fallback did not run" }, attempts: results };
}

function readPrompt() {
  const promptFile = getArg("prompt-file");
  if (promptFile) return fs.readFileSync(promptFile, "utf8");
  return getArg("prompt") || getArg("print") || process.argv.slice(2).join(" ");
}

function main() {
  const prompt = readPrompt().trim();
  if (!prompt) {
    console.error("antigravity-reviewer requires --prompt or --prompt-file");
    process.exit(2);
  }

  const agy = getArg("agy-bin", defaultAgyPath());
  const timeout = getArg("timeout", "5m");
  const brainRoot = getArg("brain-root", defaultBrainRoot());
  const cwd = getArg("cwd", process.cwd());
  const requestedModelLabel = getArg("model-label", "");
  const started = Date.now();
  const marker = `connect-ai-antigravity-reviewer-${process.pid}-${started}`;
  const env = { ...process.env };
  if (!hasFlag("allow-api-key")) delete env.GEMINI_API_KEY;
  const disableFallback = fallbackDisabled();

  const recentDiagnostic = latestAgyDiagnostic(defaultLogRoot(), Date.now() - 24 * 60 * 60 * 1000);
  const skipAgy = !hasFlag("force-agy") && recentDiagnostic.status === "RATE_LIMITED";
  const result = skipAgy
    ? { status: 0, stdout: "", stderr: "" }
    : spawnSync(agy, ["--print", `${marker}\n\n${prompt}`, "--print-timeout", timeout], {
      cwd,
      env,
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
      windowsHide: true,
      timeout: Number(getArg("process-timeout-ms", "420000")),
    });
  const agyDiagnostic = skipAgy ? recentDiagnostic : latestAgyDiagnostic(defaultLogRoot(), started);
  const observedModel = skipAgy ? { label: "", log: "" } : latestObservedModelLabel(defaultLogRoot(), started);

  let response = String(result.stdout || "").trim();
  let source = response ? "stdout" : "";
  let transcript = "";
  if (!response) {
    const extracted = extractLatestModelResponse(brainRoot, started, marker);
    response = extracted.response;
    transcript = extracted.transcript;
    source = response ? "transcript" : "";
  }
  let fallback = null;
  if (!response || looksLikeCliFailureResponse(response)) {
    const fallbackReason = response ? "failure-text" : "empty";
    if (disableFallback) {
      response = "";
      source = "";
      fallback = { skipped: true, disabled: true, reason: fallbackReason };
    } else {
      const fallbackRun = runGeminiFallbackWithRetries(
        prompt,
        Number(getArg("fallback-timeout-ms", getArg("process-timeout-ms", "420000"))),
        Number(getArg("fallback-attempts", "2"))
      );
      fallback = {
        ...fallbackRun.result,
        attempts: fallbackRun.attempts.map((attempt) => ({
          attempt: attempt.attempt,
          exitCode: attempt.exitCode,
          response: attempt.response ? redact(attempt.response, 500) : "",
          stderr: attempt.stderr,
        })),
      };
      response = looksLikeCliFailureResponse(fallback.response) ? "" : fallback.response;
      source = response ? "gemini-fallback" : "";
      if (fallback) fallback.reason = fallbackReason;
    }
  }
  const modelSelectionEnforced = modelSelectionState(requestedModelLabel, observedModel.label);
  const modelSelectionMismatch = modelSelectionEnforced === false;
  const directSuccess = Boolean(response) && isDirectSource(source) && !modelSelectionMismatch;
  const success = Boolean(response) && !modelSelectionMismatch;

  const output = {
    success,
    exitCode: result.status ?? 1,
    response: redact(response),
    source,
    directSuccess,
    fallbackDisabled: disableFallback,
    directStatus: skipAgy ? "SKIPPED_RATE_LIMITED" : (directSuccess ? "READY" : (modelSelectionMismatch ? "MODEL_MISMATCH" : (agyDiagnostic.status || (result.status === 0 ? "EMPTY_OUTPUT" : "UNKNOWN")))),
    requestedModelLabel,
    observedModelLabel: observedModel.label,
    modelSelectionEnforced,
    observedModelLog: observedModel.log ? redact(observedModel.log, 500) : "",
    transcript: transcript ? redact(transcript, 500) : "",
    marker,
    stderr: redact(result.stderr || "", 2000),
    agyDiagnostic: agyDiagnostic.status ? {
      status: agyDiagnostic.status,
      message: agyDiagnostic.message,
      log: redact(agyDiagnostic.log, 500),
    } : null,
    skippedAgy: skipAgy,
    fallback,
    apiKeyRemovedForChild: !hasFlag("allow-api-key"),
  };
  console.log(JSON.stringify(output, null, 2));
  if (!output.success) process.exit(1);
}

if (require.main === module) {
  main();
}

module.exports = {
  extractLatestModelResponse,
  extractModelResponseFromTranscript,
  transcriptContainsMarker,
  newestTranscriptFiles,
  redact,
  geminiCliInvocation,
  latestAgyDiagnostic,
  latestObservedModelLabel,
  modelSelectionState,
  runGeminiFallbackWithRetries,
  stripCliNoise,
  looksLikeCliFailureResponse,
  fallbackDisabled,
  isDirectSource,
};
