#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  analyzeRuntime,
  dashboardElementIds,
  makeDashboardState,
  makeDashboardStateWithBlockedQueue,
  smokeDashboard,
  smokeDashboardBlockedQueue,
  smokeSidebar,
} = require("./ui-runtime-smoke.js");

test("sidebar runtime shows Antigravity direct planner state", () => {
  const result = smokeSidebar();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.chipText, "Planner: Antigravity");
  assert.doesNotMatch(result.chipClass, /fallback/);
  assert.doesNotMatch(result.chipClass, /limited/);
  assert.match(result.chipTitle, /Antigravity CLI/);
});

test("dashboard runtime marks Antigravity as ready, not quota-blocked", () => {
  const result = smokeDashboard();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.doesNotMatch(result.antigravityClass, /blocked/);
  assert.match(result.stageText, /Antigravity/);
  assert.match(result.stageText, /READY/);
});

test("runtime smoke aggregates sidebar and dashboard checks", () => {
  const result = analyzeRuntime();
  assert.equal(result.success, true, result.checks.filter((check) => !check.ok).map((check) => check.id).join(", "));
  assert.equal(result.checks.length, 3);
});

test("dashboard runtime shows blocked queue reason", () => {
  const result = smokeDashboardBlockedQueue();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.match(result.queueText, /프롬프트 제약/);
  assert.match(result.queueText, /prompt_constraints/);
});

test("dashboard harness includes ids referenced by the script", () => {
  const ids = dashboardElementIds("const x = $('teamRoomStage'); const y = $('toast');");
  assert.ok(ids.includes("teamRoomStage"));
  assert.ok(ids.includes("toast"));
  assert.ok(ids.includes("teamRoomBadge"));
});

test("dashboard fixture models Antigravity direct planner without active queue work", () => {
  const state = makeDashboardState();
  assert.equal(state.workerHealth.agents.antigravity.status, "READY");
  assert.deepEqual(state.agentQueue, []);
});

test("dashboard blocked queue fixture includes structured reason", () => {
  const state = makeDashboardStateWithBlockedQueue();
  assert.equal(state.agentQueue[0].blockedReason.code, "prompt_constraints");
});
