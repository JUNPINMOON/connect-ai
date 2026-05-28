#!/usr/bin/env node
"use strict";

const path = require("node:path");
const { spawn } = require("node:child_process");
const { canAssigneeRun, hasAutomationContract, normalizeQueueItem, scopesConflict } = require("./agent-policy.js");

const repoRoot = path.resolve(__dirname, "..");
const queueCli = path.join(__dirname, "agent-queue.js");
const runQueue = path.join(__dirname, "run-queue.js");

function getArg(name, fallback = "") {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return fallback;
  return process.argv[idx + 1] || fallback;
}
function hasFlag(name) { return process.argv.includes(`--${name}`); }

function normalizeMaxWorkers(value) {
  const parsed = Number(value ?? 2);
  const bounded = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 2;
  return Math.max(1, Math.min(3, bounded));
}

function runJson(script, args) {
  const out = require("node:child_process").execFileSync(process.execPath, [script, ...args], {
    cwd: repoRoot,
    env: process.env,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  return JSON.parse(out);
}

function selectParallel(items, maxWorkers) {
  const rank = { P0: 0, P1: 1, P2: 2 };
  const selected = [];
  const candidates = items
    .filter((item) => item.status === "queued")
    .filter(hasAutomationContract)
    .map(normalizeQueueItem)
    .filter((item) => canAssigneeRun(item, item.assignee).ok)
    .sort((a, b) => (rank[a.priority] ?? 9) - (rank[b.priority] ?? 9) || String(a.createdAt || "").localeCompare(String(b.createdAt || "")));
  const usedAssignees = new Set();
  for (const item of candidates) {
    if (selected.length >= maxWorkers) break;
    if (usedAssignees.has(item.assignee)) continue;
    if (selected.some((other) => scopesConflict(other, item))) continue;
    selected.push(item);
    usedAssignees.add(item.assignee);
  }
  return selected;
}

function runOne(item) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [runQueue, "--execute", "--only", item.assignee, "--id", item.id, "--max", "1"], {
      cwd: repoRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => {
      let parsed = null;
      try { parsed = JSON.parse(stdout); } catch {}
      resolve({ assignee: item.assignee, id: item.id, exitCode: code, success: code === 0, result: parsed, stderr });
    });
  });
}

function isBlockedOrFailed(value = {}) {
  const status = String(value.status || "").toLowerCase();
  return value.success === false || status === "blocked" || status === "failed";
}

function workerResultFailed(item = {}) {
  if (!item || item.success !== true || item.exitCode !== 0) return true;
  const result = item.result || {};
  if (isBlockedOrFailed(result)) return true;
  if (Array.isArray(result.results) && result.results.some(isBlockedOrFailed)) return true;
  return false;
}

function summarizeExecutionResults(results = []) {
  const failed = results.filter(workerResultFailed);
  return {
    success: failed.length === 0,
    exitCode: failed.length ? 1 : 0,
    failed,
  };
}

async function main() {
  const execute = hasFlag("execute");
  const maxWorkers = normalizeMaxWorkers(getArg("max-workers", "2"));
  const items = runJson(queueCli, ["list"]).items || [];
  const selected = selectParallel(items, maxWorkers);
  if (!execute) {
    console.log(JSON.stringify({ mode: "dry-run", selected: selected.map((item) => ({ id: item.id, assignee: item.assignee, title: item.title, riskClass: item.riskClass, writeScope: item.writeScope })) }, null, 2));
    return;
  }
  const results = await Promise.all(selected.map((item) => runOne(item)));
  const summary = summarizeExecutionResults(results);
  console.log(JSON.stringify({ mode: "execute", success: summary.success, selected: selected.map((item) => item.id), results, failed: summary.failed }, null, 2));
  process.exitCode = summary.exitCode;
}

if (require.main === module) {
  main().catch((error) => {
    console.log(JSON.stringify({ success: false, error: String(error.message || error) }, null, 2));
    process.exit(1);
  });
}

module.exports = { selectParallel, normalizeMaxWorkers, summarizeExecutionResults };
