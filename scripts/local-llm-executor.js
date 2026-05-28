#!/usr/bin/env node
"use strict";

const fs = require("node:fs");

function getArg(name, fallback = "") {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return fallback;
  return process.argv[idx + 1] || fallback;
}

function redact(text, maxLen = 8000) {
  let value = String(text ?? "");
  value = value.replace(/\b((?:token|secret|password|passwd|api[_-]?key|client[_-]?secret|authorization|cookie|localStorage)\b\s*[:=]\s*)["']?[^"'\s,}]+/gi, "$1<redacted>");
  value = value.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi, "Bearer <redacted>");
  value = value.trim();
  return value.length > maxLen ? `${value.slice(0, maxLen)}\n...[truncated]` : value;
}

function hasWriteClaim(text) {
  const value = String(text || "");
  return (
    /\b(added|modified|wrote|changed|created|deleted|updated|edited)\b/i.test(value) ||
    /(추가|수정|작성|삭제|변경|생성|편집)\s*(했|함|완료|했습니다|되었|됨)?/i.test(value)
  );
}

function hasTemplateEchoEvidence(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value || {});
  return (
    /\bshort current-run evidence\b/i.test(text) ||
    /\brequired result format\b/i.test(text) ||
    /["']?filesChanged["']?\s*:\s*\[\s*["'][^\]]+["']\s*\]/i.test(text)
  );
}

function localSmokeEvidenceViolation(value) {
  if (!value) return "";
  if (hasTemplateEchoEvidence(value)) return "LOCAL_LLM_TEMPLATE_ECHO_EVIDENCE";
  return "";
}

function buildLocalSmokeResult({ model, latencyMs, rawEvidence }) {
  const safeEvidence = redact(rawEvidence || "", 4000);
  const templateEcho = hasTemplateEchoEvidence(safeEvidence);
  if (templateEcho) {
    return {
      success: false,
      status: "BLOCKED",
      executor: "local-llm",
      model,
      latencyMs,
      filesChanged: [],
      commandsRun: [`ollama chat ${model}`],
      unresolvedFailures: ["LOCAL_LLM_TEMPLATE_ECHO_EVIDENCE"],
      evidence: [
        "LOCAL_SMOKE_ONLY: no files were changed by local-llm executor.",
        "TEMPLATE_ECHO_IGNORED: local model output looked like a prompt/template echo, so this task is blocked instead of marked READY_FOR_VERIFICATION.",
      ].join("\n"),
    };
  }
  const writeClaim = hasWriteClaim(safeEvidence);
  if (writeClaim) {
    return {
      success: false,
      status: "BLOCKED",
      executor: "local-llm",
      model,
      latencyMs,
      filesChanged: [],
      commandsRun: [`ollama chat ${model}`],
      unresolvedFailures: ["LOCAL_LLM_CLAIMED_WRITE_WITHOUT_WRITE_PERMISSION"],
      evidence: [
        "LOCAL_SMOKE_ONLY: no files were changed by local-llm executor.",
        "MODEL_WRITE_CLAIM_IGNORED: local model output appeared to claim a file write, so this task is blocked instead of marked READY_FOR_VERIFICATION.",
      ].join("\n"),
    };
  }
  return {
    success: true,
    status: "READY_FOR_VERIFICATION",
    executor: "local-llm",
    model,
    latencyMs,
    filesChanged: [],
    commandsRun: [`ollama chat ${model}`],
    unresolvedFailures: [],
    evidence: [
      "LOCAL_SMOKE_ONLY: no files were changed by local-llm executor.",
      "MODEL_EVIDENCE:",
      safeEvidence,
    ].join("\n"),
  };
}

async function fetchJson(url, options = {}) {
  const timeoutMs = Number(getArg("process-timeout-ms", "60000"));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`);
    return JSON.parse(text || "{}");
  } finally {
    clearTimeout(timer);
  }
}

async function chooseModel(baseUrl) {
  const requested = getArg("model");
  if (requested) return requested;
  const tags = await fetchJson(`${baseUrl}/api/tags`);
  const models = Array.isArray(tags.models) ? tags.models : [];
  const preferred = ["qwen2.5-coder:1.5b", "llama3.2:1b", "gemma2:2b", "qwen2.5-coder:7b"];
  for (const name of preferred) {
    if (models.some((model) => model.name === name)) return name;
  }
  if (models.length) return models.slice().sort((a, b) => (a.size || 0) - (b.size || 0))[0].name;
  throw new Error("Ollama is reachable but has no installed models.");
}

async function runLocalLlm(item, promptText) {
  const baseUrl = (getArg("ollama-url", process.env.OLLAMA_URL || "http://127.0.0.1:11434") || "").replace(/\/+$/, "");
  const model = await chooseModel(baseUrl);
  const started = Date.now();
  const system = [
    "You are the Local LLM smoke executor for Connect AI.",
    "Only handle short, non-secret, low-risk sanity checks.",
    "Do not edit files, do not write to the Obsidian vault, and do not approve DONE.",
    "Return compact JSON-like evidence for READY_FOR_VERIFICATION.",
  ].join(" ");
  const user = [
    `Queue item: ${JSON.stringify({
      id: item.id,
      title: item.title,
      risk: item.risk,
      writeScope: item.writeScope,
      expectedTests: item.expectedTests,
      rollbackPath: item.rollbackPath,
    })}`,
    "",
    promptText.slice(0, 4000),
  ].join("\n");
  const response = await fetchJson(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      options: { num_predict: 220, temperature: 0.1 },
    }),
  });
  return buildLocalSmokeResult({
    model,
    latencyMs: Date.now() - started,
    rawEvidence: response.message?.content || response.response || "",
  });
}

async function main() {
  const queueItemFile = getArg("queue-item-file");
  const promptFile = getArg("prompt-file");
  const resultFile = getArg("result-file");
  if (!queueItemFile || !promptFile) throw new Error("local-llm-executor requires --queue-item-file and --prompt-file");
  const item = JSON.parse(fs.readFileSync(queueItemFile, "utf8"));
  const promptText = fs.readFileSync(promptFile, "utf8");
  const result = await runLocalLlm(item, promptText);
  if (resultFile) fs.writeFileSync(resultFile, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(result, null, 2));
  if (!result.success) process.exit(1);
}

if (require.main === module) {
  main().catch((error) => {
    const result = {
      success: false,
      status: "BLOCKED",
      executor: "local-llm",
      error: redact(error.message || String(error), 2000),
    };
    const resultFile = getArg("result-file");
    try { if (resultFile) fs.writeFileSync(resultFile, `${JSON.stringify(result, null, 2)}\n`, "utf8"); } catch { /* ignore */ }
    console.log(JSON.stringify(result, null, 2));
    process.exit(1);
  });
}

module.exports = {
  buildLocalSmokeResult,
  hasTemplateEchoEvidence,
  hasWriteClaim,
  localSmokeEvidenceViolation,
};
