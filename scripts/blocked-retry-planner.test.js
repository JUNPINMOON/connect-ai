#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const test = require("node:test");

const planner = require("./blocked-retry-planner.js");
const queueCli = path.join(__dirname, "agent-queue.js");
const plannerCli = path.join(__dirname, "blocked-retry-planner.js");

function runJson(script, args, env) {
  const output = execFileSync(process.execPath, [script, ...args], {
    env: { ...process.env, ...env },
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  return JSON.parse(output);
}

function runQueue(args, env) {
  return runJson(queueCli, args, env);
}

test("plans only retry-after-health-check blocked read-only items with READY health", () => {
  const items = [
    {
      id: "retry",
      status: "blocked",
      title: "구직 Green: 주간 지원 현황 보고",
      assignee: "claude",
      prompt: "Read-only status report. 파일 수정 금지.",
      resultSummary: "Claude worker failed exit=1. session limit reset.",
    },
    {
      id: "approval",
      status: "blocked",
      title: "Decision request: approve",
      assignee: "hermes",
      prompt: "Ask user.",
      resultSummary: "HUMAN_APPROVAL_REQUIRED",
    },
  ];
  const planned = planner.planRetries(items, { claude: { status: "READY" }, hermes: { status: "READY" } });
  assert.equal(planned.plans.length, 1);
  assert.equal(planned.plans[0].id, "retry");
  assert.ok(planned.skipped.some((item) => item.id === "approval"));
});

test("does not plan retries when health is not READY or protected terms are present", () => {
  const protectedItem = {
    id: "stock",
    status: "blocked",
    title: "주식 Green: 운영 리스크 평가",
    assignee: "claude",
    prompt: "Read-only review, but includes harness baseline protected_paths.",
    resultSummary: "Claude worker failed exit=1. Error: Reached max turns (8)",
  };
  assert.equal(planner.planRetries([protectedItem], { claude: { status: "READY" } }).plans.length, 0);
  const readOnlyItem = { ...protectedItem, prompt: "Read-only review. 파일 수정 금지." };
  assert.equal(planner.planRetries([readOnlyItem], { claude: { status: "AUTH_EXPIRED" } }).plans.length, 0);
});

test("allows protected words when the prompt has explicit hard boundaries", () => {
  const bounded = {
    id: "stock-bounded",
    status: "blocked",
    title: "주식 Green: 운영 리스크 평가",
    assignee: "claude",
    prompt: [
      "Role: read-only reviewer.",
      "Hard boundaries:",
      "- Do not edit files.",
      "- Do not modify harness baseline protected paths.",
      "- Do not use broker/live account/order/token/balance paths.",
    ].join("\n"),
    resultSummary: "Claude worker failed exit=1. Error: Reached max turns (8)",
  };
  assert.equal(planner.planRetries([bounded], { claude: { status: "READY" } }).plans.length, 1);
});

test("circuit breaker skips repeated transient failures before requeue", () => {
  const item = {
    id: "claude-weekly",
    status: "blocked",
    title: "구직 Green: 주간 지원 현황 보고",
    assignee: "claude",
    prompt: "Read-only status report. 파일 수정 금지.",
    resultSummary: "Claude worker failed exit=1. Error: Reached max turns (8)",
  };
  const events = [
    {
      type: "task.updated",
      id: "other-claude-task",
      assignee: "claude",
      status: "blocked",
      resultSummary: "Claude worker failed exit=1. Error: Reached max turns (8)",
    },
    {
      type: "task.updated",
      id: item.id,
      assignee: "claude",
      status: "blocked",
      resultSummary: "Claude worker failed exit=1. Error: Reached max turns (8)",
    },
  ];

  const planned = planner.planRetries([item], { claude: { status: "READY" } }, { events });

  assert.equal(planned.plans.length, 0);
  assert.equal(planned.skipped[0].id, item.id);
  assert.match(planned.skipped[0].reason, /circuit_breaker_repeated_max_turns/);
  assert.equal(planned.skipped[0].circuit.scope, "assignee");
});

test("stale blocked retry candidates are isolated into blocked backlog", () => {
  const item = {
    id: "old-antigravity-review",
    status: "blocked",
    title: "architecture design review for model routing",
    assignee: "antigravity",
    prompt: "Read-only design review. Do not edit files.",
    resultSummary: "BLOCKED: antigravity executor dispatch failed exit=1.",
    updatedAt: "2026-05-27T21:57:45.599Z",
  };

  const planned = planner.planRetries([item], { antigravity: { status: "READY" } }, {
    now: new Date("2026-05-28T06:57:45.599Z"),
    backlogCutoffHours: 6,
  });

  assert.equal(planned.plans.length, 0);
  assert.equal(planned.backlog.length, 1);
  assert.equal(planned.backlog[0].id, item.id);
  assert.match(planned.skipped[0].reason, /blocked_backlog_stale/);
});

test("dry-run does not mutate queue and execute requeues safe item", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-retry-"));
  const queueFile = path.join(tempDir, "agent-queue.json");
  const healthFile = path.join(tempDir, "worker-health.json");
  const eventLog = path.join(tempDir, "agent-queue-events.jsonl");
  const env = { CONNECT_AI_AGENT_QUEUE: queueFile };
  fs.writeFileSync(healthFile, JSON.stringify({ agents: { claude: { status: "READY" } } }), "utf8");
  fs.writeFileSync(eventLog, "", "utf8");

  const item = runQueue([
    "add",
    "--assignee", "claude",
    "--priority", "P0",
    "--title", "구직 Green: 주간 지원 현황 보고",
    "--prompt", "Read-only status report. 파일 수정 금지.",
  ], env).item;
  runQueue([
    "update",
    "--id", item.id,
    "--status", "blocked",
    "--result-summary", "Claude worker failed exit=1. session limit reset.",
  ], env);

  const dry = runJson(plannerCli, ["--health-file", healthFile, "--event-log", eventLog], env);
  assert.equal(dry.mode, "dry-run");
  assert.equal(dry.plannedCount, 1);
  assert.equal(runQueue(["get", "--id", item.id], env).item.status, "blocked");

  const executed = runJson(plannerCli, ["--execute", "--health-file", healthFile, "--event-log", eventLog], env);
  assert.equal(executed.updated.length, 1);
  assert.equal(executed.updated[0].status, "queued");
  assert.equal(runQueue(["get", "--id", item.id], env).item.status, "queued");
});
