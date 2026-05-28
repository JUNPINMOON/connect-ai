#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { buildReadinessReport, classifyReadiness, severityCounts } = require("./connect-ai-readiness.js");

function audit(overrides = {}) {
  return {
    package: {
      plannerProviderDefault: "antigravity",
      localLlmEnabledDefault: false,
    },
    queue: {
      count: 87,
      counts: { queued: 0, copied: 0, running: 0, blocked: 8, done: 79 },
    },
    blockedTriage: {
      candidateCounts: {
        verifiedArchiveCandidates: 5,
        retryCandidates: 0,
        userDecisionRequired: 7,
        evidenceOnly: 1,
      },
    },
    plannerCliSmoke: {
      source: "gemini-fallback",
      directStatus: "SKIPPED_RATE_LIMITED",
    },
    findings: [
      {
        severity: "P2",
        code: "ANTIGRAVITY_DIRECT_RATE_LIMITED",
        message: "direct agy print recently hit quota",
      },
    ],
    ...overrides,
  };
}

test("counts finding severities", () => {
  assert.deepEqual(severityCounts([
    { severity: "P0" },
    { severity: "P2" },
    { severity: "P2" },
    { severity: "unknown" },
  ]), { P0: 1, P1: 0, P2: 2, P3: 0 });
});

test("classifies current fallback profile as limited ready", () => {
  const readiness = classifyReadiness(audit());
  assert.equal(readiness.verdict, "LIMITED_READY");
  assert.equal(readiness.usableForGreenChat, true);
});

test("P0 findings make Connect Chat not ready", () => {
  const readiness = classifyReadiness(audit({
    findings: [{ severity: "P0", code: "PLANNER_CLI_SMOKE_FAILED", message: "failed" }],
  }));
  assert.equal(readiness.verdict, "NOT_READY");
  assert.equal(readiness.usableForGreenChat, false);
});

test("local LLM defaults are a readiness blocker", () => {
  const readiness = classifyReadiness(audit({
    package: {
      plannerProviderDefault: "local",
      localLlmEnabledDefault: true,
    },
    findings: [],
  }));
  assert.equal(readiness.verdict, "NEEDS_TRIAGE");
  assert.equal(readiness.usableForGreenChat, false);
});

test("active queue is busy but still usable without P0 or P1 findings", () => {
  const readiness = classifyReadiness(audit({
    queue: {
      count: 88,
      counts: { queued: 1, copied: 0, running: 0, blocked: 8, done: 79 },
    },
    findings: [],
  }));
  assert.equal(readiness.verdict, "BUSY_BUT_USABLE");
  assert.equal(readiness.usableForGreenChat, true);
});

test("readiness report includes next action guardrails", () => {
  const report = buildReadinessReport(audit());
  assert.equal(report.verdict, "LIMITED_READY");
  assert.equal(report.queue.blocked, 8);
  assert.equal(report.planner.smokeSource, "gemini-fallback");
  assert.ok(report.nextActions.some((action) => action.includes("Gemini fallback")));
  assert.ok(report.nextActions.some((action) => action.includes("Red/high-risk")));
});
