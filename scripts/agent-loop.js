#!/usr/bin/env node
"use strict";

const { execFileSync } = require("node:child_process");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");
const queueCli = path.join(__dirname, "agent-queue.js");
const claudeWorker = path.join(__dirname, "claude-worker.js");
const codexWorker = path.join(__dirname, "codex-worker.js");

const priorityRank = { P0: 0, P1: 1, P2: 2 };

function getArg(name, fallback = "") {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return fallback;
  return process.argv[idx + 1] || fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function redact(text, maxLen = 3000) {
  let value = String(text ?? "");
  value = value.replace(/\b((?:token|secret|password|passwd|api[_-]?key|client[_-]?secret|authorization|cookie|localStorage)\b\s*[:=]\s*)["']?[^"'\s,}]+/gi, "$1<redacted>");
  value = value.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi, "Bearer <redacted>");
  value = value.trim();
  return value.length > maxLen ? `${value.slice(0, maxLen)}\n...[truncated]` : value;
}

function runJson(script, args) {
  const output = execFileSync(process.execPath, [script, ...args], {
    cwd: repoRoot,
    env: process.env,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  return JSON.parse(output);
}

function runQueue(args) {
  return runJson(queueCli, args);
}

function sortByPriorityThenTime(items) {
  return [...items].sort((a, b) => {
    const byPriority = (priorityRank[a.priority] ?? 9) - (priorityRank[b.priority] ?? 9);
    if (byPriority !== 0) return byPriority;
    return String(a.createdAt || "").localeCompare(String(b.createdAt || ""));
  });
}

function compact(item) {
  return {
    id: item.id,
    title: item.title,
    assignee: item.assignee,
    status: item.status,
    priority: item.priority,
    updatedAt: item.updatedAt || item.createdAt || "",
  };
}

function analyze(summary) {
  const queued = summary.queued || [];
  const running = summary.running || [];
  const blocked = summary.blocked || [];
  const copied = (summary.copied || []).concat(
    // Older replan reports did not expose copied as a first-class list.
    []
  );
  const decisionRequests = summary.decisionRequests || [];
  const queuedDecisionRequests = queued.filter((item) => item.assignee === "hermes" && /^Decision request:/i.test(item.title || ""));
  const copiedOrRunningDecisionRequests = running
    .concat(copied)
    .filter((item) => item.assignee === "hermes" && /^Decision request:/i.test(item.title || ""));

  const attention = [];
  for (const item of blocked) {
    attention.push({ type: "blocked_task", item: compact(item), action: "Hermes/user must resolve before dependent automation continues." });
  }
  for (const item of queuedDecisionRequests) {
    attention.push({ type: "queued_decision_request", item: compact(item), action: "Hermes should ask the user or create approved follow-up work." });
  }
  for (const item of copiedOrRunningDecisionRequests) {
    attention.push({ type: `${item.status}_decision_request`, item: compact(item), action: "Finish the human-facing decision loop before treating this risk as closed." });
  }
  for (const request of decisionRequests.filter((request) => !request.alreadyEscalated)) {
    attention.push({
      type: "uncreated_decision_request",
      sourceTaskId: request.sourceTaskId,
      action: "Run replan with autoEscalateRisks so residual risk becomes a Hermes queue item.",
    });
  }

  const nextClaude = sortByPriorityThenTime(queued.filter((item) => item.assignee === "claude"))[0] || null;
  const nextCodex = sortByPriorityThenTime(queued.filter((item) => item.assignee === "codex"))[0] || null;
  const nextHermes = sortByPriorityThenTime(queued.filter((item) => item.assignee === "hermes"))[0] || null;

  const dispatch = [];
  if (nextClaude) {
    dispatch.push({
      assignee: "claude",
      mode: "autoable",
      item: compact(nextClaude),
      command: "npm run agent:claude -- --worker claude-auto --max-turns 5 --output-format text",
    });
  }
  if (nextCodex) {
    dispatch.push({
      assignee: "codex",
      mode: "autoable",
      item: compact(nextCodex),
      command: "npm run agent:codex -- --worker codex-auto",
    });
  }
  if (nextHermes) {
    dispatch.push({
      assignee: "hermes",
      mode: "single_conductor",
      item: compact(nextHermes),
      command: `Hermes should finish ${nextHermes.id} in the active orchestrator session.`,
    });
  }

  return {
    state: attention.length ? "ATTENTION_REQUIRED" : "READY_TO_DISPATCH",
    attention,
    dispatch,
  };
}

function replan() {
  const worker = getArg("worker", "agent-loop");
  const args = ["replan", "--worker", worker];
  if (hasFlag("auto-escalate-risks")) args.push("--auto-escalate-risks");
  const report = runQueue(args);
  const loop = analyze(report.summary);
  return { ...report, loop };
}

function runClaudeOnce() {
  const args = [
    "--worker", getArg("claude-worker", "claude-auto-loop"),
    "--claude-bin", getArg("claude-bin", "claude"),
    "--max-turns", getArg("max-turns", "5"),
    "--output-format", getArg("output-format", "text"),
    "--permission-mode", getArg("permission-mode", "plan"),
    "--timeout-ms", getArg("timeout-ms", "180000"),
  ];
  const model = getArg("model", "");
  if (model) args.push("--model", model);
  return runJson(claudeWorker, args);
}

function runCodexOnce() {
  const args = [
    "--worker", getArg("codex-worker", "codex-auto-loop"),
    "--codex-bin", getArg("codex-bin", "codex"),
    "--timeout-ms", getArg("codex-timeout-ms", "600000"),
  ];
  const model = getArg("codex-model", "");
  if (model) args.push("--model", model);
  const sandbox = getArg("codex-sandbox", "");
  if (sandbox) args.push("--sandbox", sandbox);
  return runJson(codexWorker, args);
}

function once() {
  const before = replan();
  const shouldRunClaude = hasFlag("run-claude");
  const shouldRunCodex = hasFlag("run-codex");
  const hasClaudeTask = before.loop.dispatch.some((item) => item.assignee === "claude" && item.mode === "autoable");
  const holdForAttention = before.loop.attention.length > 0;
  const holdReason = before.loop.attention.some((item) => /decision_request$/.test(item.type) || item.type === "uncreated_decision_request")
    ? "pending_decision_request"
    : "attention_required";

  const hasCodexTask = before.loop.dispatch.some((item) => item.assignee === "codex" && item.mode === "autoable");

  const actions = [];
  if (shouldRunClaude && hasClaudeTask && !holdForAttention) {
    actions.push({ type: "claude_worker", result: runClaudeOnce() });
  } else if (shouldRunCodex && hasCodexTask && !holdForAttention) {
    actions.push({ type: "codex_worker", result: runCodexOnce() });
  } else if ((shouldRunClaude || shouldRunCodex) && holdForAttention) {
    actions.push({ type: "held", reason: holdReason });
  } else {
    actions.push({ type: "dry_run", reason: "use --run-claude or --run-codex to let the loop execute one task" });
  }

  const after = replan();
  return {
    success: actions.every((action) => (action.type !== "claude_worker" && action.type !== "codex_worker") || action.result.success),
    before: { reportPath: before.reportPath, loop: before.loop, statusCounts: before.summary.statusCounts },
    actions,
    after: { reportPath: after.reportPath, loop: after.loop, statusCounts: after.summary.statusCounts },
  };
}

function usage() {
  return {
    usage: [
      "node scripts/agent-loop.js status [--auto-escalate-risks]",
      "node scripts/agent-loop.js once [--auto-escalate-risks] [--run-claude] [--run-codex] [--claude-bin claude] [--codex-bin codex]",
    ],
    notes: [
      "Hermes remains the single conductor for decision requests.",
      "Claude is autoable through scripts/claude-worker.js.",
      "Codex is autoable through scripts/codex-worker.js (codex exec).",
    ],
  };
}

function main() {
  const command = process.argv[2] || "status";
  if (command === "status") {
    console.log(JSON.stringify(replan(), null, 2));
    return;
  }
  if (command === "once") {
    console.log(JSON.stringify(once(), null, 2));
    return;
  }
  console.log(JSON.stringify(usage(), null, 2));
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
  analyze,
};
