#!/usr/bin/env node
"use strict";

// Connect AI Deep Debug Swarm
// Runs a read-only 6 Gemini + 6 Antigravity reviewer swarm against the current
// repo state. It writes reports under repo reports/, never directly to vault.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const envPaths = require("./env-paths.js");
const antigravity = require("./antigravity-reviewer.js");

const repoRoot = envPaths.repoRoot();
const reviewerScript = path.join(__dirname, "antigravity-reviewer.js");
const geminiExecutor = require("./gemini-executor.js");

const ANTIGRAVITY_MODEL_CONTROL = "global-selected-model-only";

const AGENTS = [
  {
    id: "gemini-transport",
    provider: "gemini",
    domain: "chat-to-worker transport",
    modelIntent: "gemini-2.5-pro",
    modelId: "gemini-2.5-pro",
    persona: "transport failure reviewer",
    focus: "Find failures in Connect AI chat -> planner -> queue -> worker handoff. Pay special attention to empty CLI responses, stale extension bundles, false completion, and blocked_by_prompt_constraints.",
  },
  {
    id: "gemini-queue-safety",
    provider: "gemini",
    domain: "agent queue safety",
    modelIntent: "gemini-2.5-pro",
    modelId: "gemini-2.5-pro",
    persona: "queue safety reviewer",
    focus: "Audit agent-queue lifecycle, locks, ready_for_verification, blocked backlog, race conditions, and status transitions. Identify ways tasks can be lost, falsely marked done, or stuck.",
  },
  {
    id: "gemini-cli-health",
    provider: "gemini",
    domain: "CLI health and auth",
    modelIntent: "gemini-2.5-flash",
    modelId: "gemini-2.5-flash",
    persona: "CLI health reviewer",
    focus: "Audit Codex, Claude, Gemini, Antigravity, Hermes health checks, auth drift, session limits, fallback paths, and stale worker-status versus worker-health mismatch.",
  },
  {
    id: "gemini-vault-memory",
    provider: "gemini",
    domain: "vault and memory integrity",
    modelIntent: "gemini-2.5-pro",
    modelId: "gemini-2.5-pro",
    persona: "memory integrity reviewer",
    focus: "Audit Obsidian/vault writes, verified.md promotion, decisions learning, runtime-vs-vault separation, and weak-evidence memory pollution.",
  },
  {
    id: "gemini-ui-runtime",
    provider: "gemini",
    domain: "VS Code UI and runtime",
    modelIntent: "gemini-2.5-flash",
    modelId: "gemini-2.5-flash",
    persona: "UI runtime reviewer",
    focus: "Audit sidebar/dashboard/team-room runtime behavior, stale webview state, Reload Window dependency, bundle sync, and user-visible failure reporting.",
  },
  {
    id: "gemini-policy-gates",
    provider: "gemini",
    domain: "policy gates and protected paths",
    modelIntent: "gemini-2.5-flash",
    modelId: "gemini-2.5-flash",
    persona: "policy gate reviewer",
    focus: "Audit Red/high-risk controls, human approval enforcement, protected path handling, reviewer write prevention, and Hermes observer-only invariants.",
  },
  {
    id: "antigravity-transport",
    provider: "antigravity",
    domain: "chat-to-worker transport",
    modelIntent: "Antigravity selected model",
    persona: "transport failure reviewer",
    focus: "Review the same transport path from Antigravity perspective. Look for failure modes Gemini might miss, especially around transcript extraction and planner JSON parsing.",
  },
  {
    id: "antigravity-queue-safety",
    provider: "antigravity",
    domain: "agent queue safety",
    modelIntent: "Antigravity selected model",
    persona: "queue safety reviewer",
    focus: "Review queue storage, locks, backup/recovery, ready_for_verification, run-queue dry-run and execution separation, and blocked backlog strategy.",
  },
  {
    id: "antigravity-cli-health",
    provider: "antigravity",
    domain: "CLI health and auth",
    modelIntent: "Antigravity selected model",
    persona: "CLI health reviewer",
    focus: "Review Antigravity/Gemini/Codex/Claude/Hermes CLI invocation details, Windows cmd shim problems, stdout/stderr parsing, and fallback reliability.",
  },
  {
    id: "antigravity-vault-memory",
    provider: "antigravity",
    domain: "vault and memory integrity",
    modelIntent: "Antigravity selected model",
    persona: "memory integrity reviewer",
    focus: "Review self-RAG, verified.md, decisions.md, _company sessions, runtime-vs-vault separation, and evidence quality gates.",
  },
  {
    id: "antigravity-ui-runtime",
    provider: "antigravity",
    domain: "VS Code UI and runtime",
    modelIntent: "Antigravity selected model",
    persona: "UI runtime reviewer",
    focus: "Review Connect AI UI, dashboard/team-room clarity, agent status visibility, error rendering, and whether user can tell what is actually running.",
  },
  {
    id: "antigravity-policy-gates",
    provider: "antigravity",
    domain: "policy gates and protected paths",
    modelIntent: "Antigravity selected model",
    persona: "policy gate reviewer",
    focus: "Review role model, reviewer/executor boundaries, human approval, protected path rules, and dangerous automation edge cases.",
  },
];

function getArg(name, fallback = "") {
  const idx = process.argv.indexOf(`--${name}`);
  return idx === -1 ? fallback : (process.argv[idx + 1] || fallback);
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function redact(text, maxLen = 6000) {
  let value = String(text ?? "");
  value = value.replace(/\bAuthorization\s*:\s*Bearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi, "Authorization: Bearer <redacted>");
  value = value.replace(/\b((?:token|secret|password|passwd|api[_-]?key|client[_-]?secret|authorization|cookie|localStorage)\b\s*[:=]\s*)["']?[^"'\s,}]+/gi, "$1<redacted>");
  value = value.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi, "Bearer <redacted>");
  value = value.trim();
  return value.length > maxLen ? `${value.slice(0, maxLen)}\n...[truncated]` : value;
}

function run(cmd, args, options = {}) {
  const started = Date.now();
  const result = spawnSync(cmd, args, {
    cwd: options.cwd || repoRoot,
    env: options.env || process.env,
    encoding: "utf8",
    windowsHide: true,
    shell: Boolean(options.shell),
    input: options.input,
    timeout: options.timeoutMs || 120000,
    maxBuffer: 30 * 1024 * 1024,
  });
  return {
    exitCode: result.status ?? 1,
    ok: result.status === 0 && !result.error,
    stdout: String(result.stdout || ""),
    stderr: String(result.stderr || result.error?.message || ""),
    ms: Date.now() - started,
  };
}

function collectContext() {
  const snippets = [];
  const lite = hasFlag("context-lite") || hasFlag("lite-context");
  const commands = [
    ["git status --short", process.platform === "win32" ? ["cmd.exe", ["/d", "/c", "git status --short"]] : ["sh", ["-lc", "git status --short"]]],
    ...(lite ? [] : [["transport audit", [process.execPath, [path.join(__dirname, "transport-audit.js"), "--json"]]]]),
    ...(lite ? [] : [["agent dashboard", [process.execPath, [path.join(__dirname, "agent-os-dashboard.js")]]]]),
  ];
  for (const [label, [cmd, args]] of commands) {
    const result = run(cmd, args, { timeoutMs: 30000 });
    snippets.push(`## ${label}\nexit=${result.exitCode}\nstdout:\n${redact(result.stdout, 10000)}\nstderr:\n${redact(result.stderr, 2000)}`);
  }
  return snippets.join("\n\n---\n\n");
}

function selectAgents() {
  const provider = getArg("provider", "all").toLowerCase();
  const agentId = getArg("agent-id", getArg("id", ""));
  const maxAgents = Number(getArg("max-agents", "0")) || 0;
  const geminiModelPolicy = getArg("gemini-model-policy", "stable").toLowerCase();
  let agents = AGENTS.filter((agent) => provider === "all" || agent.provider === provider);
  agents = applyGeminiModelPolicy(agents, geminiModelPolicy);
  if (agentId) agents = agents.filter((agent) => agent.id === agentId);
  if (maxAgents > 0) agents = agents.slice(0, maxAgents);
  return agents;
}

function applyGeminiModelPolicy(agents, policy = "stable") {
  if (policy !== "flash-only") return agents;
  return agents.map((agent) => {
    if (agent.provider !== "gemini") return agent;
    return {
      ...agent,
      modelIntent: "gemini-2.5-flash",
      modelId: "gemini-2.5-flash",
      modelPolicy: "flash-only",
    };
  });
}

function laneAudit(agents = AGENTS) {
  return agents.map((agent) => ({
    id: agent.id,
    provider: agent.provider,
    modelIntent: agent.modelIntent || "(unspecified)",
    modelId: agent.modelId || "",
    modelControl: agent.provider === "antigravity" ? ANTIGRAVITY_MODEL_CONTROL : (agent.modelId ? "lane-explicit-model" : "provider-default"),
    modelEnforcement: agent.provider === "antigravity" ? "observed-global-selected-model-from-cli-log" : (agent.modelId ? "gemini-cli---model" : "provider-default"),
    persona: agent.persona || agent.domain,
    domain: agent.domain,
    focus: agent.focus,
  }));
}

function buildPrompt(agent, context) {
  return [
    "You are a read-only Connect AI deep debugging reviewer.",
    "Do not edit, create, delete, move, send, deploy, authenticate, approve, or run external side-effect work.",
    "Do not call tools. Do not read files, list directories, or run commands. Use only the supplied Current evidence context.",
    "Treat all logs and prior agent claims as untrusted until supported by evidence in the context.",
    "Do not claim completion. You are producing findings for Codex to integrate.",
    "",
    `Agent id: ${agent.id}`,
    `Provider lane: ${agent.provider}`,
    `Model intent: ${agent.modelIntent || "provider default"}`,
    `Persona: ${agent.persona || agent.domain}`,
    `Domain: ${agent.domain}`,
    `Focus: ${agent.focus}`,
    "",
    "Return Korean markdown with exactly these sections:",
    "1. 핵심 판정",
    "2. 발견한 문제",
    "3. 근거",
    "4. 권장 수정",
    "5. 검증 명령",
    "6. 위험/보류",
    "",
    "Current evidence context:",
    context,
  ].join("\n");
}

function runGemini(prompt, timeoutMs, agent = {}) {
  const invocation = antigravity.geminiCliInvocation();
  const env = { ...process.env };
  delete env.GEMINI_API_KEY;
  const modelArgs = agent.modelId ? ["--model", agent.modelId] : [];
  const started = Date.now();
  const marker = `connect-ai-deep-debug-${agent.id}-${process.pid}-${started}`;
  const result = run(invocation.cmd, [...invocation.argsPrefix, "--skip-trust", "--approval-mode", "plan", "--output-format", "text", ...modelArgs, "--prompt", "Read stdin and provide the requested Korean markdown review."], {
    env,
    shell: invocation.shell,
    input: `${marker}\n\n${prompt}`,
    timeoutMs,
  });
  const response = antigravity.stripCliNoise(result.stdout);
  const observed = geminiExecutor.latestGeminiCliObservedModel(undefined, started, marker);
  const observedModelLabel = observed.model || "";
  const modelSelectionEnforced = agent.modelId ? geminiExecutor.isObservedModelAllowedForRequest(agent.modelId, observedModelLabel) : null;
  const cliFailure = geminiExecutor.classifyGeminiCliFailure(result.stderr || result.stdout || "");
  const unresolvedFailures = [];
  if (cliFailure) {
    unresolvedFailures.push(cliFailure);
  } else {
    if (result.exitCode !== 0) unresolvedFailures.push(`EXIT_${result.exitCode}`);
    if (!response) unresolvedFailures.push("EMPTY_RESPONSE");
    if (!observedModelLabel) unresolvedFailures.push("MISSING_OBSERVED_MODEL");
    if (observedModelLabel && modelSelectionEnforced === false) unresolvedFailures.push("MODEL_MISMATCH");
  }
  return {
    ok: unresolvedFailures.length === 0,
    exitCode: result.exitCode,
    source: "gemini",
    requestedModel: agent.modelId || "",
    observedModel: observedModelLabel,
    requestedModelLabel: agent.modelId || "",
    observedModelLabel,
    observedModelEvidence: observed.transcript || "",
    modelSelectionEnforced,
    unresolvedFailures,
    response: redact(response, 12000),
    stderr: redact(result.stderr, 3000),
    ms: result.ms,
  };
}

function runAntigravity(prompt, timeoutMs) {
  const promptFile = path.join(os.tmpdir(), `connect-ai-deep-debug-${process.pid}-${Date.now()}.txt`);
  fs.writeFileSync(promptFile, prompt, "utf8");
  const printTimeout = getArg("antigravity-print-timeout", "30s");
  const fallbackTimeoutMs = Number(getArg("fallback-timeout-ms", "180000")) || 180000;
  const fallbackAttempts = Math.max(1, Number(getArg("fallback-attempts", "2")) || 2);
  const directOnly = hasFlag("direct-only") || hasFlag("no-fallback");
  const forceAgy = hasFlag("force-agy");
  const modelLabel = getArg("model-label", "");
  const wrapperTimeoutMs = timeoutMs + (fallbackTimeoutMs * fallbackAttempts) + 30000;
  const args = buildAntigravityReviewerArgs({
    promptFile,
    printTimeout,
    timeoutMs,
    fallbackTimeoutMs,
    fallbackAttempts,
    directOnly,
    forceAgy,
    modelLabel,
  });
  const result = run(process.execPath, args, { timeoutMs: wrapperTimeoutMs });
  try { fs.unlinkSync(promptFile); } catch { /* best effort cleanup */ }
  let parsed = null;
  try { parsed = JSON.parse(result.stdout); } catch { /* keep raw */ }
  const source = parsed?.source || "antigravity-reviewer";
  const direct = /^(antigravity|agy|transcript|stdout)$/i.test(source);
  const hasResponse = Boolean(parsed?.response || result.stdout.trim());
  const modelSelectionEnforced = parsed?.modelSelectionEnforced ?? null;
  const responseText = String(parsed?.response || result.stdout || "");
  const reviewShapeOk = /핵심\s*판정/.test(responseText) && /발견한\s*문제/.test(responseText) && /검증\s*명령/.test(responseText);
  return {
    ok: result.exitCode === 0 && hasResponse && direct && modelSelectionEnforced !== false && reviewShapeOk,
    exitCode: result.exitCode,
    source,
    modelControl: ANTIGRAVITY_MODEL_CONTROL,
    response: redact(parsed?.response || result.stdout, 12000),
    stderr: redact(parsed?.stderr || result.stderr, 3000),
    direct,
    fallbackUsed: Boolean(hasResponse && !direct),
    observedModelLabel: parsed?.observedModelLabel || "",
    requestedModelLabel: parsed?.requestedModelLabel || "",
    modelSelectionEnforced,
    reviewShapeOk,
    ms: result.ms,
  };
}

function buildAntigravityReviewerArgs(options) {
  const args = [
    reviewerScript,
    "--prompt-file",
    options.promptFile,
    "--timeout",
    options.printTimeout,
    "--process-timeout-ms",
    String(options.timeoutMs),
    "--fallback-timeout-ms",
    String(options.fallbackTimeoutMs),
    "--fallback-attempts",
    String(options.fallbackAttempts),
  ];
  if (options.directOnly) args.push("--no-fallback");
  if (options.forceAgy) args.push("--force-agy");
  if (options.modelLabel) args.push("--model-label", options.modelLabel);
  return args;
}

function synthesize(results) {
  const failed = results.filter((result) => !result.ok);
  const lines = [];
  lines.push("# Connect AI Deep Debug Swarm Report");
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Agents: ${results.length} (${results.filter((r) => r.provider === "gemini").length} Gemini, ${results.filter((r) => r.provider === "antigravity").length} Antigravity)`);
  lines.push(`Failed agents: ${failed.length}`);
  lines.push("");
  lines.push("## Executive Summary");
  lines.push("");
  lines.push("- This is a read-only multi-agent review. It did not enqueue, claim, run workers, edit files, or write to the vault.");
  lines.push("- Treat findings as review evidence, not automatic truth. Codex must integrate and verify concrete fixes separately.");
  if (results.some((result) => result.provider === "antigravity")) {
    lines.push("- Antigravity CLI has no verified per-lane model flag in this runner; Antigravity lanes are persona-diverse and use the globally selected observed model.");
  }
  if (failed.length) lines.push(`- ${failed.length} reviewer lane(s) failed and need retry or CLI repair.`);
  lines.push("");
  for (const result of results) {
    lines.push(`## ${result.id}`);
    lines.push("");
    lines.push(`- provider: ${result.provider}`);
    lines.push(`- source: ${result.source}`);
    if (result.modelControl) lines.push(`- modelControl: ${result.modelControl}`);
    if (result.observedModel) lines.push(`- observedModel: ${result.observedModel}`);
    if (result.requestedModel) lines.push(`- requestedModel: ${result.requestedModel}`);
    if (result.observedModelLabel) lines.push(`- observedModelLabel: ${result.observedModelLabel}`);
    if (result.requestedModelLabel) lines.push(`- requestedModelLabel: ${result.requestedModelLabel}`);
    if (result.modelSelectionEnforced !== null && result.modelSelectionEnforced !== undefined) lines.push(`- modelSelectionEnforced: ${result.modelSelectionEnforced}`);
    if (Array.isArray(result.unresolvedFailures) && result.unresolvedFailures.length) lines.push(`- unresolvedFailures: ${result.unresolvedFailures.join(", ")}`);
    if (result.reviewShapeOk !== null && result.reviewShapeOk !== undefined) lines.push(`- reviewShapeOk: ${result.reviewShapeOk}`);
    lines.push(`- ok: ${result.ok}`);
    lines.push(`- exitCode: ${result.exitCode}`);
    lines.push(`- ms: ${result.ms}`);
    if (result.stderr) {
      lines.push("");
      lines.push("stderr:");
      lines.push("```");
      lines.push(result.stderr.slice(0, 1200));
      lines.push("```");
    }
    lines.push("");
    lines.push(result.response || "(no response)");
    lines.push("");
  }
  return lines.join("\n");
}

function main() {
  const agents = selectAgents();
  const timeoutMs = Number(getArg("timeout-ms", "240000")) || 240000;
  if (hasFlag("list-agents") || hasFlag("dry-run")) {
    console.log(JSON.stringify({ count: agents.length, agents, laneAudit: laneAudit(agents) }, null, 2));
    return;
  }

  const context = collectContext();
  const results = [];
  for (const agent of agents) {
    const prompt = buildPrompt(agent, context);
    const outcome = agent.provider === "gemini" ? runGemini(prompt, timeoutMs, agent) : runAntigravity(prompt, timeoutMs);
    results.push({ id: agent.id, provider: agent.provider, domain: agent.domain, ...outcome });
    console.error(`[${agent.id}] ok=${outcome.ok} source=${outcome.source} ms=${outcome.ms}`);
  }

  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "Z");
  const outDir = path.join(repoRoot, "reports", "deep-debug-swarm", stamp);
  fs.mkdirSync(outDir, { recursive: true });
  const report = {
    generatedAt: new Date().toISOString(),
    repoRoot,
    agentCount: results.length,
    results,
  };
  fs.writeFileSync(path.join(outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(outDir, "report.md"), synthesize(results), "utf8");
  console.log(JSON.stringify({ success: results.every((result) => result.ok), outDir, agentCount: results.length, failed: results.filter((result) => !result.ok).map((result) => result.id) }, null, 2));
  if (!results.every((result) => result.ok)) process.exit(1);
}

if (require.main === module) main();

module.exports = { AGENTS, applyGeminiModelPolicy, buildPrompt, selectAgents, synthesize, buildAntigravityReviewerArgs, laneAudit };
