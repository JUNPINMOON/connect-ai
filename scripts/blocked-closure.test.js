#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const test = require("node:test");

const closureCli = path.join(__dirname, "blocked-closure.js");
const { buildClosureSummary, planClosure, selectClosureCandidates } = require("./blocked-closure.js");

function run(args, env = {}) {
  const output = execFileSync(process.execPath, [closureCli, ...args], {
    cwd: path.resolve(__dirname, ".."),
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  return JSON.parse(output);
}

function runBlocked(args, env = {}) {
  const result = spawnSync(process.execPath, [closureCli, ...args], {
    cwd: path.resolve(__dirname, ".."),
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  return JSON.parse(result.stdout || result.stderr || "{}");
}

function tempQueue(items) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-closure-"));
  const file = path.join(dir, "agent-queue.json");
  fs.writeFileSync(file, `${JSON.stringify(items, null, 2)}\n`, "utf8");
  return { dir, file, env: { CONNECT_AI_AGENT_QUEUE: file } };
}

test("selects only verified archive candidates", () => {
  const report = {
    details: [
      { id: "a", closureRecommendation: "candidate_for_verified_archive" },
      { id: "b", closureRecommendation: "keep_blocked_until_user_decision" },
    ],
  };
  assert.deepEqual(selectClosureCandidates(report, [], true).map((item) => item.id), ["a"]);
  assert.deepEqual(selectClosureCandidates(report, ["a", "b"], false).map((item) => item.id), ["a"]);
});

test("dry-run plans without mutating the queue", () => {
  const { file, env } = tempQueue([
    {
      id: "a",
      status: "blocked",
      title: "Old broad task",
      assignee: "codex",
      priority: "P2",
      resultSummary: "Superseded by coordinator.",
      prompt: "old",
    },
  ]);
  const before = fs.readFileSync(file, "utf8");
  const result = run([], env);
  assert.equal(result.mode, "dry-run");
  assert.equal(result.mutatesQueue, false);
  assert.equal(result.plan.availableCandidateCount, 1);
  assert.equal(result.plan.selectedCount, 0);
  assert.equal(result.plan.availableCandidates[0].id, "a");
  assert.equal(fs.readFileSync(file, "utf8"), before);
});

test("execute is blocked without human approval", () => {
  const { env } = tempQueue([
    {
      id: "a",
      status: "blocked",
      title: "Old broad task",
      assignee: "codex",
      priority: "P2",
      resultSummary: "Superseded by coordinator.",
      prompt: "old",
    },
  ]);
  const result = runBlocked(["--execute", "--all"], env);
  assert.equal(result.reason, "HUMAN_APPROVAL_REQUIRED");
});

test("execute with human approval closes selected archive candidate", () => {
  const { file, env } = tempQueue([
    {
      id: "a",
      status: "blocked",
      title: "Old broad task",
      assignee: "codex",
      priority: "P2",
      resultSummary: "Superseded by coordinator.",
      prompt: "old",
    },
    {
      id: "b",
      status: "blocked",
      title: "Decision request: approval",
      assignee: "hermes",
      priority: "P2",
      resultSummary: "HUMAN_APPROVAL_REQUIRED",
      prompt: "approval",
    },
  ]);
  const result = run(["--execute", "--human-approved", "--id", "a"], env);
  assert.equal(result.success, true);
  assert.equal(result.closedCount, 1);
  const queue = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(queue.find((item) => item.id === "a").status, "done");
  assert.equal(queue.find((item) => item.id === "a").verifiedAt.length > 0, true);
  assert.equal(queue.find((item) => item.id === "a").humanApprovedAt.length > 0, true);
  assert.equal(queue.find((item) => item.id === "b").status, "blocked");
});

test("plan reports requested ids that are not closable", () => {
  const report = {
    totalBlocked: 2,
    details: [
      { id: "a", closureRecommendation: "candidate_for_verified_archive" },
      { id: "b", closureRecommendation: "keep_blocked_until_user_decision" },
    ],
  };
  const plan = planClosure(report, { requestedIds: ["b"], includeAll: false });
  assert.deepEqual(plan.missingOrNotClosable, ["b"]);
});

test("closure summary includes evidence and no protected path changes", () => {
  const summary = buildClosureSummary({
    bucket: "superseded_or_duplicate",
    closureRecommendation: "candidate_for_verified_archive",
    resultSummary: "Superseded by coordinator.",
  });
  assert.match(summary, /VERIFIED_ARCHIVE/);
  assert.match(summary, /No protected path changes/);
});
