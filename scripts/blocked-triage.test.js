#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const triage = require("./blocked-triage.js");

test("classifies approval and protected blocked items conservatively", () => {
  assert.equal(triage.classifyBlocked({
    title: "Decision request: 가드 테스트용 승인 작업",
    resultSummary: "HUMAN_APPROVAL_REQUIRED",
  }).bucket, "needs_human");

  assert.equal(triage.classifyBlocked({
    title: "주식 Green: 시장 데이터 리스크 분석",
    prompt: "Review broker-free stock workflow.",
  }).bucket, "protected_or_high_risk");
});

test("classifies transient CLI failures as retry-after-health-check", () => {
  const result = triage.classifyBlocked({
    title: "구직 Green: weekly report",
    resultSummary: "Claude worker failed exit=1. session limit resets later.",
  });
  assert.equal(result.bucket, "retry_after_health_check");
  assert.equal(result.closureRecommendation, "retry_only_after_ready_health");
});

test("classifies failed synthetic probes as evidence, not human approval work", () => {
  const result = triage.classifyBlocked({
    title: "Green E2E probe: Connect Chat to Codex worker read-only",
    prompt: "Do not touch protected paths.",
    resultSummary: "Codex worker reported blocked output; Windows read-only sandbox prevented local read commands. 실제 파일 수정 없음.",
  });
  assert.equal(result.bucket, "obsolete_probe_evidence");
  assert.equal(result.requiresHumanDecision, false);
});

test("transient failure summary wins over protected words in the prompt", () => {
  const result = triage.classifyBlocked({
    title: "주식 Green: 운영 리스크 평가",
    prompt: "Read-only stock/protected path review. Do not edit harness or baseline.",
    resultSummary: "Claude worker failed exit=1. Error: Reached max turns (8)",
  });
  assert.equal(result.bucket, "retry_after_health_check");
});

test("summarizes blocked buckets without mutating input", () => {
  const items = [
    { id: "a", status: "blocked", title: "Decision request: x", assignee: "hermes", priority: "P1" },
    { id: "b", status: "blocked", title: "Retry task", resultSummary: "ETIMEDOUT", assignee: "codex", priority: "P2" },
    { id: "c", status: "done", title: "Done task" },
  ];
  const report = triage.summarize(items);
  assert.equal(report.totalBlocked, 2);
  assert.equal(report.buckets.needs_human, 1);
  assert.equal(report.buckets.retry_after_health_check, 1);
  assert.equal(report.candidateCounts.retryCandidates, 1);
  assert.equal(report.candidateCounts.userDecisionRequired, 1);
  assert.equal(items[0].status, "blocked");
});

test("renders markdown report", () => {
  const md = triage.toMarkdown(triage.summarize([
    { id: "a", status: "blocked", title: "Decision request: x", assignee: "hermes", priority: "P1" },
  ]));
  assert.match(md, /Blocked Queue Triage/);
  assert.match(md, /needs_human/);
  assert.match(md, /Closure Candidates/);
});
