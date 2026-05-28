#!/usr/bin/env node
"use strict";

// Read-only smoke for the real CLI planner path used by Connect AI.
// It asks the Antigravity wrapper for a tiny CEO planner JSON object and
// verifies that the response can be parsed into { brief, tasks }.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const envPaths = require("./env-paths.js");

const repoRoot = envPaths.repoRoot();
const reviewerScript = path.join(__dirname, "antigravity-reviewer.js");

function getArg(name, fallback = "") {
  const idx = process.argv.indexOf(`--${name}`);
  return idx === -1 ? fallback : (process.argv[idx + 1] || fallback);
}

function redact(text, maxLen = 12000) {
  let value = String(text ?? "");
  value = value.replace(/\bAuthorization\s*:\s*Bearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi, "Authorization: Bearer <redacted>");
  value = value.replace(/\b((?:token|secret|password|passwd|api[_-]?key|client[_-]?secret|authorization|cookie|localStorage)\b\s*[:=]\s*)["']?[^"'\s,}]+/gi, "$1<redacted>");
  value = value.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi, "Bearer <redacted>");
  value = value.trim();
  return value.length > maxLen ? `${value.slice(0, maxLen)}\n...[truncated]` : value;
}

function extractJsonObjects(raw) {
  const text = String(raw || "").replace(/```[a-zA-Z]*\n?|```/g, "");
  const out = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        const candidate = text.slice(start, i + 1);
        const parsed = parseJsonCandidate(candidate);
        if (parsed) {
          out.push(parsed);
        } else {
          // Ignore prose-like brace fragments.
        }
        start = -1;
      }
    }
  }
  return out;
}

function stripTrailingJsonCommas(input) {
  const text = String(input ?? "");
  let out = "";
  let inString = false;
  let escape = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j += 1;
      if (text[j] === "}" || text[j] === "]") continue;
    }
    out += ch;
  }
  return out;
}

function tryParseJsonObject(candidate) {
  try {
    const parsed = JSON.parse(candidate);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function parseJsonCandidate(candidate) {
  const variants = [String(candidate), stripTrailingJsonCommas(candidate)];
  for (const variant of variants) {
    const parsed = tryParseJsonObject(variant);
    if (parsed) return parsed;
  }
  // Rescue common model output on Windows: C:\Users\... inside JSON strings.
  // This runs only after strict JSON.parse fails, so preserving exact escape
  // semantics matters less than recovering a planner object instead of
  // dropping the whole response.
  for (const variant of variants) {
    const parsed = tryParseJsonObject(variant.replace(/\\/g, "\\\\"));
    if (parsed) return parsed;
  }
  return null;
}

function parsePlannerResponse(raw) {
  const candidates = extractJsonObjects(raw);
  const plan = candidates.find((candidate) => candidate && Array.isArray(candidate.tasks));
  if (!plan) return { ok: false, reason: "NO_TASKS_JSON", candidates };
  const tasks = plan.tasks || [];
  if (typeof plan.brief !== "string" || !plan.brief.trim()) {
    return { ok: false, reason: "MISSING_BRIEF", plan };
  }
  if (!tasks.length) return { ok: false, reason: "EMPTY_TASKS", plan };
  const joined = `${plan.brief}\n${tasks.map((task) => task?.task || "").join("\n")}`;
  if (!/Connect AI/i.test(joined)) {
    return { ok: false, reason: "MISSING_CONNECT_AI_CONTEXT", plan };
  }
  for (const task of tasks) {
    if (!task || typeof task.agent !== "string" || !task.agent.trim()) {
      return { ok: false, reason: "TASK_MISSING_AGENT", plan };
    }
    if (typeof task.task !== "string" || !task.task.trim()) {
      return { ok: false, reason: "TASK_MISSING_TEXT", plan };
    }
  }
  return { ok: true, plan };
}

function buildPrompt(userCommand = "Connect AI 현재 운영 구조를 5줄로 요약해줘. 구현 작업 금지.") {
  return [
    "[Connect AI CEO Planner Smoke]",
    "- Return exactly one JSON object.",
    "- Do not use markdown fences.",
    "- Do not claim tool/file execution.",
    "- Do not edit files or run commands.",
    "- This is a read-only planner smoke.",
    "- The JSON brief or task must explicitly mention Connect AI.",
    "- Schema: {\"brief\":\"...\",\"tasks\":[{\"agent\":\"secretary|developer|researcher|reviewer\",\"task\":\"...\"}]}",
    "",
    `[사용자 명령]\n${userCommand}`,
  ].join("\n");
}

function runPlannerSmoke(options = {}) {
  const prompt = options.prompt || buildPrompt(options.userCommand);
  const promptFile = path.join(os.tmpdir(), `connect-ai-planner-smoke-${process.pid}-${Date.now()}.txt`);
  fs.writeFileSync(promptFile, prompt, "utf8");
  const result = spawnSync(process.execPath, [
    reviewerScript,
    "--prompt-file",
    promptFile,
    "--timeout",
    options.printTimeout || "45s",
    "--process-timeout-ms",
    String(options.processTimeoutMs || 90000),
    "--fallback-timeout-ms",
    String(options.fallbackTimeoutMs || 180000),
    "--fallback-attempts",
    String(options.fallbackAttempts || 2),
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 20 * 1024 * 1024,
    timeout: options.wrapperTimeoutMs || 480000,
  });
  try { fs.unlinkSync(promptFile); } catch { /* best effort */ }

  let wrapper = null;
  try {
    wrapper = JSON.parse(result.stdout || "{}");
  } catch {
    wrapper = null;
  }
  const response = wrapper?.response || result.stdout || "";
  const parsed = parsePlannerResponse(response);
  return {
    success: result.status === 0 && Boolean(wrapper?.success) && parsed.ok,
    exitCode: result.status ?? 1,
    source: wrapper?.source || "",
    directStatus: wrapper?.directStatus || "",
    agyDiagnostic: wrapper?.agyDiagnostic || null,
    apiKeyRemovedForChild: wrapper?.apiKeyRemovedForChild,
    parsed,
    responsePreview: redact(response, 1500),
    stderr: redact(wrapper?.stderr || result.stderr || result.error?.message || "", 2000),
  };
}

function main() {
  const result = runPlannerSmoke({
    userCommand: getArg("command", undefined),
    printTimeout: getArg("print-timeout", "45s"),
    processTimeoutMs: Number(getArg("process-timeout-ms", "90000")) || 90000,
    fallbackTimeoutMs: Number(getArg("fallback-timeout-ms", "180000")) || 180000,
    fallbackAttempts: Number(getArg("fallback-attempts", "2")) || 2,
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.success) process.exit(1);
}

if (require.main === module) main();

module.exports = {
  buildPrompt,
  extractJsonObjects,
  parseJsonCandidate,
  parsePlannerResponse,
  runPlannerSmoke,
};
