#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const smoke = require("./planner-cli-smoke.js");

test("extractJsonObjects handles prose and fenced JSON", () => {
  const found = smoke.extractJsonObjects([
    "prefix",
    "```json",
    '{"brief":"ok","tasks":[{"agent":"secretary","task":"요약"}]}',
    "```",
    "suffix",
  ].join("\n"));
  assert.equal(found.length, 1);
  assert.equal(found[0].tasks[0].agent, "secretary");
});

test("parsePlannerResponse accepts a valid planner object", () => {
  const parsed = smoke.parsePlannerResponse('{"brief":"Connect AI 운영 상태 확인","tasks":[{"agent":"secretary","task":"Connect AI 5줄 요약"}]}');
  assert.equal(parsed.ok, true);
  assert.equal(parsed.plan.tasks.length, 1);
});

test("extractJsonObjects rescues bare Windows paths inside JSON strings", () => {
  const found = smoke.extractJsonObjects(String.raw`{"brief":"Connect AI path C:\Users\mjb58\connect-ai-vault","tasks":[{"agent":"developer","task":"Connect AI queue C:\Users\mjb58\AppData"}]}`);
  assert.equal(found.length, 1);
  assert.equal(found[0].tasks[0].agent, "developer");
  assert.equal(found[0].brief, String.raw`Connect AI path C:\Users\mjb58\connect-ai-vault`);
  assert.equal(found[0].tasks[0].task, String.raw`Connect AI queue C:\Users\mjb58\AppData`);
});

test("parsePlannerResponse accepts recovered bare Windows paths", () => {
  const parsed = smoke.parsePlannerResponse(String.raw`{"brief":"Connect AI smoke C:\Users\mjb58\connect-ai-vault","tasks":[{"agent":"developer","task":"Connect AI 큐 경로 C:\Users\mjb58\AppData 확인"}]}`);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.plan.tasks[0].agent, "developer");
});

test("parsePlannerResponse accepts planner JSON with trailing commas", () => {
  const parsed = smoke.parsePlannerResponse([
    "planner output:",
    "```json",
    "{",
    '  "brief": "Connect AI transport smoke",',
    '  "tasks": [',
    '    {"agent": "developer", "task": "Connect AI queue handoff test"},',
    "  ],",
    "}",
    "```",
  ].join("\n"));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.plan.tasks.length, 1);
  assert.equal(parsed.plan.tasks[0].agent, "developer");
});

test("parsePlannerResponse rejects missing task fields", () => {
  assert.equal(smoke.parsePlannerResponse('{"brief":"x","tasks":[]}').ok, false);
  assert.equal(smoke.parsePlannerResponse('{"brief":"Connect AI","tasks":[{"agent":"secretary"}]}').reason, "TASK_MISSING_TEXT");
  assert.equal(smoke.parsePlannerResponse('{"brief":"일반 상태","tasks":[{"agent":"secretary","task":"일반 요약"}]}').reason, "MISSING_CONNECT_AI_CONTEXT");
});

test("buildPrompt includes read-only planner constraints", () => {
  const prompt = smoke.buildPrompt("테스트");
  assert.match(prompt, /Return exactly one JSON object/);
  assert.match(prompt, /Do not edit files or run commands/);
  assert.match(prompt, /explicitly mention Connect AI/);
  assert.match(prompt, /\[사용자 명령\]\n테스트/);
});
