#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const antigravity = require("./antigravity-reviewer.js");

const SUPPORTED_MODELS = new Set([
  "gemini-2.5-flash",
  "gemini-2.5-pro",
]);

const APPROVED_EVIDENCE_ROOTS = [
  path.resolve("C:\\Users\\mjb58\\connect-ai-runtime\\company\\s5-dispatch"),
  path.resolve("C:\\Users\\mjb58\\antigravity-projects\\connect-ai\\reports\\deep-debug-swarm"),
];

const VAULT_ROOT = path.resolve("C:\\Users\\mjb58\\connect-ai-vault");
const DEFAULT_GEMINI_CHAT_ROOT = path.join(os.homedir(), ".gemini", "tmp", "connect-ai", "chats");

function getArg(argv, name, fallback = "") {
  const idx = argv.indexOf(`--${name}`);
  return idx === -1 ? fallback : (argv[idx + 1] || fallback);
}

function hasFlag(argv, name) {
  return argv.includes(`--${name}`);
}

function normalizeForCompare(value) {
  return path.resolve(String(value || "")).toLowerCase();
}

function isUnder(parent, child) {
  const root = normalizeForCompare(parent);
  const target = normalizeForCompare(child);
  return target === root || target.startsWith(`${root}${path.sep}`);
}

function isVaultPath(target) {
  return isUnder(VAULT_ROOT, target);
}

function isApprovedEvidencePath(target) {
  return APPROVED_EVIDENCE_ROOTS.some((root) => isUnder(root, target));
}

function stripCliNoise(text) {
  return antigravity.stripCliNoise(String(text || ""));
}

function classifyGeminiCliFailure(text) {
  const value = String(text || "");
  if (/QUOTA_EXHAUSTED|TerminalQuotaError|exhausted your capacity/i.test(value)) return "QUOTA_EXHAUSTED";
  if (/authentication|unauthorized|permission denied|consent could not be obtained/i.test(value)) return "AUTH_FAILED";
  if (/rate limit|429/i.test(value)) return "RATE_LIMITED";
  return "";
}

function isObservedModelAllowedForRequest(requestedModel, observedModel) {
  const requested = String(requestedModel || "").trim();
  const observed = String(observedModel || "").trim();
  if (!requested || !observed) return false;
  return requested === observed;
}

function buildResult(fields) {
  return {
    status: fields.status || "BLOCKED",
    executor: "gemini",
    requestedModel: fields.requestedModel || "",
    observedModel: fields.observedModel || "",
    filesChanged: fields.filesChanged || [],
    commandsRun: fields.commandsRun || [],
    unresolvedFailures: fields.unresolvedFailures || [],
    evidence: fields.evidence || "",
    reason: fields.reason || "",
  };
}

function inferObservedModelFromCommand(commandsRun, requestedModel) {
  const joined = commandsRun.join("\n");
  const match = joined.match(/--model\s+([^\s]+)/);
  return match?.[1] || requestedModel || "";
}

function eventContainsMarker(event, marker) {
  if (!marker) return true;
  return JSON.stringify(event).includes(marker);
}

function latestGeminiCliObservedModel(chatRoot = DEFAULT_GEMINI_CHAT_ROOT, sinceMs = 0, marker = "") {
  let entries = [];
  try {
    entries = fs.readdirSync(chatRoot, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^session-.*\.jsonl$/i.test(entry.name))
      .map((entry) => {
        const fullPath = path.join(chatRoot, entry.name);
        const stat = fs.statSync(fullPath);
        return { path: fullPath, mtimeMs: stat.mtimeMs };
      })
      .filter((entry) => !sinceMs || entry.mtimeMs + 2000 >= sinceMs)
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
  } catch {
    return { model: "", transcript: "" };
  }

  for (const entry of entries.slice(0, 8)) {
    let lines = [];
    try {
      lines = fs.readFileSync(entry.path, "utf8").split(/\r?\n/).filter(Boolean);
    } catch {
      continue;
    }
    let markerSeen = !marker;
    const parsedLines = [];
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        parsedLines.push(event);
        if (eventContainsMarker(event, marker)) markerSeen = true;
      } catch {
        // Gemini CLI session files are append-only JSONL. Ignore partial lines.
      }
    }
    if (!markerSeen) continue;
    for (let idx = parsedLines.length - 1; idx >= 0; idx -= 1) {
      const event = parsedLines[idx];
      if (String(event.type || "").toLowerCase() === "gemini" && typeof event.model === "string" && event.model.trim()) {
        return { model: event.model.trim(), transcript: entry.path };
      }
    }
  }
  return { model: "", transcript: "" };
}

function runGeminiExecutor(options = {}) {
  const requestedModel = String(options.model || "").trim();
  if (!SUPPORTED_MODELS.has(requestedModel)) {
    return buildResult({
      status: "BLOCKED",
      requestedModel,
      reason: "UNSUPPORTED_MODEL",
      unresolvedFailures: ["UNSUPPORTED_MODEL"],
      evidence: `Model ${requestedModel || "(empty)"} is not in the approved Gemini executor allowlist.`,
    });
  }

  const requestedWritePath = String(options.writePath || "").trim();
  if (requestedWritePath) {
    if (isVaultPath(requestedWritePath)) {
      return buildResult({
        status: "BLOCKED",
        requestedModel,
        observedModel: requestedModel,
        reason: "VAULT_WRITE_FORBIDDEN",
        unresolvedFailures: ["VAULT_WRITE_FORBIDDEN"],
        evidence: "Gemini executor does not write to vault. Use task-dispatch-goal.js -> vault-writer.js for vault routing.",
      });
    }
    if (!isApprovedEvidencePath(requestedWritePath)) {
      return buildResult({
        status: "BLOCKED",
        requestedModel,
        observedModel: requestedModel,
        reason: "EVIDENCE_PATH_FORBIDDEN",
        unresolvedFailures: ["EVIDENCE_PATH_FORBIDDEN"],
        evidence: `Requested write path is outside approved evidence roots: ${requestedWritePath}`,
      });
    }
  }

  const prompt = String(options.prompt || "").trim();
  if (!prompt) {
    return buildResult({
      status: "BLOCKED",
      requestedModel,
      observedModel: requestedModel,
      reason: "EMPTY_PROMPT",
      unresolvedFailures: ["EMPTY_PROMPT"],
      evidence: "No prompt supplied.",
    });
  }

  const requestedEvidenceDir = String(options.evidenceDir || "").trim();
  if (requestedEvidenceDir) {
    if (isVaultPath(requestedEvidenceDir)) {
      return buildResult({
        status: "BLOCKED",
        requestedModel,
        observedModel: "",
        reason: "VAULT_WRITE_FORBIDDEN",
        unresolvedFailures: ["VAULT_WRITE_FORBIDDEN"],
        evidence: "Evidence dir points inside vault; blocked.",
      });
    }
    if (!isApprovedEvidencePath(requestedEvidenceDir)) {
      return buildResult({
        status: "BLOCKED",
        requestedModel,
        observedModel: "",
        reason: "EVIDENCE_PATH_FORBIDDEN",
        unresolvedFailures: ["EVIDENCE_PATH_FORBIDDEN"],
        evidence: `Evidence dir is outside approved evidence roots: ${requestedEvidenceDir}`,
      });
    }
  }

  const invocation = antigravity.geminiCliInvocation();
  const env = { ...process.env };
  delete env.GEMINI_API_KEY;
  const args = [
    ...invocation.argsPrefix,
    "--skip-trust",
    "--approval-mode",
    "plan",
    "--output-format",
    "text",
    "--model",
    requestedModel,
    "--prompt",
    "Read stdin and provide the requested answer. Do not edit files.",
  ];
  const commandDisplay = `${invocation.cmd} ${args.map((arg) => /\s/.test(arg) ? JSON.stringify(arg) : arg).join(" ")}`;
  const started = Date.now();
  const marker = options.marker || `connect-ai-gemini-executor-${process.pid}-${started}`;
  const runner = options.spawnSync || spawnSync;
  const result = runner(invocation.cmd, args, {
    cwd: options.cwd || process.cwd(),
    env,
    encoding: "utf8",
    input: `${marker}\n\n${prompt}`,
    windowsHide: true,
    shell: invocation.shell,
    timeout: Number(options.timeoutMs || 180000),
    maxBuffer: 20 * 1024 * 1024,
  });
  const commandsRun = [commandDisplay];
  const observed = latestGeminiCliObservedModel(options.chatRoot || DEFAULT_GEMINI_CHAT_ROOT, options.sinceMs || started, marker);
  const observedModel = observed.model;
  const response = stripCliNoise(result.stdout);
  const stderr = stripCliNoise(result.stderr || result.error?.message || "");
  const cliFailure = classifyGeminiCliFailure(stderr);
  const unresolvedFailures = [];
  if (cliFailure) {
    unresolvedFailures.push(cliFailure);
  } else {
    if ((result.status ?? 1) !== 0) unresolvedFailures.push(`EXIT_${result.status ?? 1}`);
    if (!response) unresolvedFailures.push("EMPTY_RESPONSE");
    if (!observedModel) unresolvedFailures.push("MISSING_OBSERVED_MODEL");
    if (observedModel && !isObservedModelAllowedForRequest(requestedModel, observedModel)) unresolvedFailures.push("MODEL_MISMATCH");
  }

  const status = unresolvedFailures.length ? "BLOCKED" : "READY_FOR_VERIFICATION";
  let evidencePath = "";
  const filesChanged = [];
  if (status === "READY_FOR_VERIFICATION" && !hasFlag(options.argv || [], "no-evidence")) {
    const evidenceDir = path.resolve(String(options.evidenceDir || APPROVED_EVIDENCE_ROOTS[0]));
    fs.mkdirSync(evidenceDir, { recursive: true });
    evidencePath = path.join(evidenceDir, `gemini-executor-${Date.now()}.json`);
    fs.writeFileSync(evidencePath, JSON.stringify({
      generatedAt: new Date().toISOString(),
      executor: "gemini",
      requestedModel,
      observedModel,
      observedModelEvidence: observed.transcript,
      marker,
      response,
      stderr,
    }, null, 2), "utf8");
    filesChanged.push(evidencePath);
  }

  return buildResult({
    status,
    requestedModel,
    observedModel,
    filesChanged,
    commandsRun,
    unresolvedFailures,
    evidence: evidencePath || response,
    reason: unresolvedFailures[0] || "",
  });
}

function main(argv = process.argv.slice(2)) {
  const model = getArg(argv, "model", "");
  const prompt = getArg(argv, "prompt", "");
  const promptFile = getArg(argv, "prompt-file", "");
  const evidenceDir = getArg(argv, "evidence-dir", "");
  const writePath = getArg(argv, "write-path", "");
  let promptText = prompt;
  if (!promptText && promptFile) {
    try { promptText = fs.readFileSync(promptFile, "utf8"); } catch { promptText = ""; }
  }
  if (!promptText && !process.stdin.isTTY) {
    try { promptText = fs.readFileSync(0, "utf8"); } catch { promptText = ""; }
  }
  const result = runGeminiExecutor({
    model,
    prompt: promptText,
    evidenceDir,
    writePath,
    argv,
  });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.status === "READY_FOR_VERIFICATION" ? 0 : 1);
}

if (require.main === module) main();

module.exports = {
  SUPPORTED_MODELS,
  APPROVED_EVIDENCE_ROOTS,
  classifyGeminiCliFailure,
  isApprovedEvidencePath,
  isVaultPath,
  isObservedModelAllowedForRequest,
  inferObservedModelFromCommand,
  latestGeminiCliObservedModel,
  runGeminiExecutor,
};
