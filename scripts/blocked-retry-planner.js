#!/usr/bin/env node
"use strict";

// Plan safe retry actions for blocked tasks. Default is dry-run. With
// --execute, only retry_after_health_check items whose assignee health is READY
// and whose prompt/title is explicitly read-only are re-queued.

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { isReadOnlyText } = require("./agent-policy.js");
const triage = require("./blocked-triage.js");
const envPaths = require("./env-paths.js");

const repoRoot = path.resolve(__dirname, "..");
const queueCli = path.join(__dirname, "agent-queue.js");

function getArg(name, fallback = "") {
  const idx = process.argv.indexOf(`--${name}`);
  return idx === -1 ? fallback : (process.argv[idx + 1] || fallback);
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function runQueue(args, options = {}) {
  const output = execFileSync(process.execPath, [queueCli, ...args], {
    cwd: repoRoot,
    env: options.env || process.env,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  return JSON.parse(output);
}

function readHealth(healthFile = "") {
  const file = healthFile || path.join(path.dirname(envPaths.agentQueuePath()), "worker-health.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && parsed.agents ? parsed.agents : {};
  } catch {
    return {};
  }
}

function defaultEventLogPath() {
  return path.join(path.dirname(envPaths.agentQueuePath()), "agent-queue-events.jsonl");
}

function readEvents(eventLog = "") {
  const file = eventLog || defaultEventLogPath();
  try {
    return fs.readFileSync(file, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter((entry) => entry && typeof entry === "object");
  } catch {
    return [];
  }
}

function failureSignature(text) {
  const value = String(text || "");
  if (/Reached max turns/i.test(value)) return "max_turns";
  if (/session limit/i.test(value)) return "session_limit";
  if (/rate.?limit/i.test(value)) return "rate_limit";
  if (/AUTH_EXPIRED|TOKEN/i.test(value)) return "auth_or_token";
  if (/ETIMEDOUT|timeout|timed out/i.test(value)) return "timeout";
  if (/CLI.*failed|exit=1/i.test(value)) return "cli_exit_1";
  return "";
}

function repeatedFailureCircuit(item, events = [], threshold = 2) {
  const signature = failureSignature(item.resultSummary || "");
  if (!signature) return null;
  const blockedEvents = events.filter((event) => event.type === "task.updated" && event.status === "blocked");
  const sameTaskCount = blockedEvents.filter((event) =>
    event.id === item.id && failureSignature(event.resultSummary || "") === signature
  ).length;
  if (sameTaskCount >= threshold) {
    return {
      signature,
      scope: "task",
      count: sameTaskCount,
      reason: `circuit_breaker_repeated_${signature}_for_task_${sameTaskCount}`,
    };
  }
  const sameAssigneeCount = blockedEvents.filter((event) =>
    event.assignee === item.assignee && failureSignature(event.resultSummary || "") === signature
  ).length;
  if (sameAssigneeCount >= threshold) {
    return {
      signature,
      scope: "assignee",
      count: sameAssigneeCount,
      reason: `circuit_breaker_repeated_${signature}_for_${item.assignee}_${sameAssigneeCount}`,
    };
  }
  return null;
}

function retryableReadOnly(item) {
  const text = `${item.title || ""}\n${item.prompt || ""}`;
  if (!isReadOnlyText(text)) return false;
  const hasProtectedTerms = /harness|baseline|protected[_-\s]?paths|broker|order|live.?trade|token|secret|credential|deploy|send|gmail|google sheets/i.test(text);
  const hasExplicitBoundaries = /Hard boundaries:[\s\S]*(Do not|do not|금지|하지\s*말|수정\s*금지|파일\s*수정\s*금지)/i.test(text);
  if (hasProtectedTerms && !hasExplicitBoundaries) {
    return false;
  }
  return true;
}

function itemBlockedTimestamp(item = {}) {
  const value = item.updatedAt || item.completedAt || item.blockedAt || item.createdAt || "";
  const time = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(time) ? time : null;
}

function blockedBacklogReason(item = {}, options = {}) {
  const cutoffHours = Number(options.backlogCutoffHours ?? 6);
  if (!Number.isFinite(cutoffHours) || cutoffHours <= 0) return "";
  const timestamp = itemBlockedTimestamp(item);
  if (timestamp === null) return "";
  const nowMs = options.now ? new Date(options.now).getTime() : Date.now();
  if (!Number.isFinite(nowMs)) return "";
  const ageHours = (nowMs - timestamp) / 3600000;
  if (ageHours <= cutoffHours) return "";
  return `blocked_backlog_stale_${ageHours.toFixed(1)}h_gt_${cutoffHours}h`;
}

function planRetries(items, health, options = {}) {
  const max = Number(options.max ?? getArg("max", "10")) || 10;
  const events = Array.isArray(options.events) ? options.events : [];
  const circuitThreshold = Number(options.circuitThreshold || 2) || 2;
  const backlogCutoffHours = Number(options.backlogCutoffHours ?? getArg("backlog-cutoff-hours", "6")) || 6;
  const now = options.now || new Date();
  const plans = [];
  const skipped = [];
  const backlog = [];
  for (const item of items.filter((entry) => entry.status === "blocked")) {
    const cls = triage.classifyBlocked(item);
    if (cls.bucket !== "retry_after_health_check") {
      skipped.push({ id: item.id, title: item.title, reason: `bucket=${cls.bucket}` });
      continue;
    }
    const backlogReason = blockedBacklogReason(item, { now, backlogCutoffHours });
    if (backlogReason) {
      const timestamp = itemBlockedTimestamp(item);
      const ageHours = timestamp === null ? null : (new Date(now).getTime() - timestamp) / 3600000;
      const entry = {
        id: item.id,
        title: item.title,
        assignee: item.assignee,
        priority: item.priority,
        updatedAt: item.updatedAt || item.completedAt || item.blockedAt || item.createdAt || "",
        ageHours: ageHours === null ? null : Number(ageHours.toFixed(2)),
        reason: backlogReason,
      };
      backlog.push(entry);
      skipped.push({ id: item.id, title: item.title, reason: backlogReason, backlog: entry });
      continue;
    }
    const circuit = repeatedFailureCircuit(item, events, circuitThreshold);
    if (circuit) {
      skipped.push({ id: item.id, title: item.title, reason: circuit.reason, circuit });
      continue;
    }
    const agentHealth = health[item.assignee] || {};
    if (agentHealth.status !== "READY") {
      skipped.push({ id: item.id, title: item.title, reason: `health=${agentHealth.status || "UNKNOWN"}` });
      continue;
    }
    if (!retryableReadOnly(item)) {
      skipped.push({ id: item.id, title: item.title, reason: "not_explicit_read_only_or_contains_protected_terms" });
      continue;
    }
    plans.push({
      id: item.id,
      title: item.title,
      assignee: item.assignee,
      priority: item.priority,
      reason: "retry_after_health_check_and_ready",
    });
    if (plans.length >= max) break;
  }
  return { plans, skipped, backlog, backlogCutoffHours };
}

function executePlan(plan) {
  return runQueue([
    "update",
    "--id", plan.id,
    "--status", "queued",
    "--result-summary", `Requeued by blocked-retry-planner after health READY; previous blocked reason preserved in event log. Reason: ${plan.reason}`,
  ]);
}

function main() {
  const execute = hasFlag("execute");
  const listed = runQueue(["list"]);
  const health = readHealth(getArg("health-file", ""));
  const events = readEvents(getArg("event-log", ""));
  const circuitThreshold = Number(getArg("circuit-threshold", "2")) || 2;
  const backlogCutoffHours = Number(getArg("backlog-cutoff-hours", "6")) || 6;
  const { plans, skipped, backlog } = planRetries(listed.items || [], health, { events, circuitThreshold, backlogCutoffHours });
  const updated = [];
  if (execute) {
    for (const plan of plans) updated.push(executePlan(plan).item);
  }
  console.log(JSON.stringify({
    success: true,
    mode: execute ? "execute" : "dry-run",
    queuePath: listed.path,
    eventLogPath: getArg("event-log", "") || defaultEventLogPath(),
    circuitThreshold,
    backlogCutoffHours,
    plannedCount: plans.length,
    backlogCount: backlog.length,
    plans,
    backlog,
    skipped,
    updated: updated.map((item) => ({
      id: item.id,
      assignee: item.assignee,
      status: item.status,
      title: item.title,
    })),
  }, null, 2));
}

if (require.main === module) main();

module.exports = {
  blockedBacklogReason,
  failureSignature,
  planRetries,
  readHealth,
  readEvents,
  repeatedFailureCircuit,
  retryableReadOnly,
};
