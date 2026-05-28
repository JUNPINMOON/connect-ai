#!/usr/bin/env node
"use strict";

// Safe closure gate for blocked queue items.
// Default is dry-run. It only closes superseded/duplicate items when the user
// explicitly supplies --execute --human-approved and either --all or --id.

const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const { summarize } = require("./blocked-triage.js");

const repoRoot = path.resolve(__dirname, "..");
const queueCli = path.join(__dirname, "agent-queue.js");

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function getMultiArg(name) {
  const values = [];
  for (let i = 0; i < process.argv.length; i += 1) {
    if (process.argv[i] === `--${name}` && process.argv[i + 1]) values.push(process.argv[i + 1]);
  }
  return values;
}

function parseJson(text) {
  return JSON.parse(String(text || "").trim());
}

function runQueue(args) {
  const output = execFileSync(process.execPath, [queueCli, ...args], {
    cwd: repoRoot,
    env: process.env,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  return parseJson(output);
}

function runQueueWithStatus(args) {
  const result = spawnSync(process.execPath, [queueCli, ...args], {
    cwd: repoRoot,
    env: process.env,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    windowsHide: true,
  });
  let json = null;
  try {
    json = parseJson(result.stdout || result.stderr || "{}");
  } catch {
    json = { success: false, stdout: result.stdout || "", stderr: result.stderr || "" };
  }
  return {
    ok: result.status === 0 && !result.error,
    exitCode: result.status ?? 1,
    error: result.error ? result.error.message : "",
    json,
  };
}

function selectClosureCandidates(report, requestedIds = [], includeAll = false) {
  const candidates = report.details.filter((item) => item.closureRecommendation === "candidate_for_verified_archive");
  if (includeAll) return candidates;
  const requested = new Set(requestedIds);
  return candidates.filter((item) => requested.has(item.id));
}

function buildClosureSummary(item) {
  return [
    "VERIFIED_ARCHIVE: Superseded blocked task closed after human-approved cleanup.",
    `Original bucket: ${item.bucket}.`,
    `Closure recommendation: ${item.closureRecommendation}.`,
    `Evidence: ${item.resultSummary || "blocked-triage identified this as superseded_or_duplicate."}`,
    "No worker rerun performed. No protected path changes performed by this closure command.",
  ].join(" ");
}

function planClosure(report, options = {}) {
  const requestedIds = options.requestedIds || [];
  const includeAll = Boolean(options.includeAll);
  const availableCandidates = selectClosureCandidates(report, [], true);
  const candidates = selectClosureCandidates(report, requestedIds, includeAll);
  const requestedSet = new Set(requestedIds);
  const missingOrNotClosable = requestedIds.filter((id) => !candidates.some((item) => item.id === id));
  const formatCandidate = (item) => ({
    id: item.id,
    title: item.title,
    assignee: item.assignee,
    priority: item.priority,
    bucket: item.bucket,
    closureRecommendation: item.closureRecommendation,
    willClose: includeAll || requestedSet.has(item.id),
    resultSummary: item.resultSummary,
  });
  return {
    totalBlocked: report.totalBlocked,
    availableCandidateCount: availableCandidates.length,
    candidateCount: candidates.length,
    selectedCount: candidates.length,
    requestedIds,
    includeAll,
    missingOrNotClosable,
    availableCandidates: availableCandidates.map(formatCandidate),
    candidates: candidates.map(formatCandidate),
  };
}

function applyClosure(candidates) {
  const results = [];
  for (const item of candidates) {
    const result = runQueueWithStatus([
      "update",
      "--id", item.id,
      "--status", "done",
      "--result-summary", buildClosureSummary(item),
      "--verified",
      "--human-approved",
    ]);
    results.push({
      id: item.id,
      title: item.title,
      ok: result.ok && result.json && result.json.success,
      exitCode: result.exitCode,
      status: result.json?.item?.status || "",
      json: result.json,
    });
  }
  return results;
}

function main() {
  const execute = hasFlag("execute");
  const humanApproved = hasFlag("human-approved");
  const includeAll = hasFlag("all");
  const requestedIds = getMultiArg("id");
  const listed = runQueue(["list"]);
  const report = summarize(listed.items || []);
  const plan = planClosure(report, { requestedIds, includeAll });

  if (!execute) {
    console.log(JSON.stringify({
      success: true,
      mode: "dry-run",
      mutatesQueue: false,
      queuePath: listed.path,
      instructions: "Use --execute --human-approved with --id <task> or --all to close selected superseded blocked tasks.",
      plan,
    }, null, 2));
    return;
  }

  if (!humanApproved) {
    console.log(JSON.stringify({
      success: false,
      mode: "execute",
      blocked_by_guard: true,
      reason: "HUMAN_APPROVAL_REQUIRED",
      message: "Blocked closure requires --human-approved. Dry-run output is safe to inspect first.",
      plan,
    }, null, 2));
    process.exit(3);
  }
  if (!includeAll && requestedIds.length === 0) {
    console.log(JSON.stringify({
      success: false,
      mode: "execute",
      blocked_by_guard: true,
      reason: "NO_TARGET_SELECTED",
      message: "Specify --id <task> or --all. No queue changes were made.",
      plan,
    }, null, 2));
    process.exit(2);
  }
  if (plan.missingOrNotClosable.length) {
    console.log(JSON.stringify({
      success: false,
      mode: "execute",
      blocked_by_guard: true,
      reason: "REQUESTED_ID_NOT_CLOSABLE",
      message: "One or more requested ids are not candidate_for_verified_archive items. No queue changes were made.",
      plan,
    }, null, 2));
    process.exit(2);
  }

  const results = applyClosure(plan.candidates);
  const success = results.every((item) => item.ok && item.status === "done");
  console.log(JSON.stringify({
    success,
    mode: "execute",
    queuePath: listed.path,
    closedCount: results.filter((item) => item.ok && item.status === "done").length,
    results,
  }, null, 2));
  if (!success) process.exit(1);
}

if (require.main === module) main();

module.exports = {
  applyClosure,
  buildClosureSummary,
  planClosure,
  selectClosureCandidates,
};
