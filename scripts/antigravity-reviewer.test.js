#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const reviewer = require("./antigravity-reviewer.js");

test("extracts the latest model response from Antigravity transcript JSONL", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-brain-"));
  const logDir = path.join(root, "conversation", ".system_generated", "logs");
  fs.mkdirSync(logDir, { recursive: true });
  const transcript = path.join(logDir, "transcript.jsonl");
  fs.writeFileSync(transcript, [
    JSON.stringify({ source: "USER_EXPLICIT", content: "hello" }),
    JSON.stringify({ source: "MODEL", type: "PLANNER_RESPONSE", content: "first" }),
    JSON.stringify({ source: "MODEL", type: "PLANNER_RESPONSE", content: "final answer" }),
    "",
  ].join("\n"), "utf8");

  const result = reviewer.extractLatestModelResponse(root);
  assert.equal(result.response, "final answer");
  assert.equal(result.transcript, transcript);
});

test("extracts transcript response only when marker matches", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-brain-marker-"));
  const logDir = path.join(root, "conversation", ".system_generated", "logs");
  fs.mkdirSync(logDir, { recursive: true });
  const transcript = path.join(logDir, "transcript.jsonl");
  fs.writeFileSync(transcript, [
    JSON.stringify({ source: "USER_EXPLICIT", content: "MARKER_A hello" }),
    JSON.stringify({ source: "MODEL", type: "PLANNER_RESPONSE", content: "marker answer" }),
    "",
  ].join("\n"), "utf8");

  assert.equal(reviewer.extractLatestModelResponse(root, Date.now() - 10000, "MARKER_A").response, "marker answer");
  assert.deepEqual(reviewer.extractLatestModelResponse(root, Date.now() - 10000, "MARKER_B"), { response: "", transcript: "" });
});

test("prefers substantive transcript response over a short trailing model event", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-brain-"));
  const logDir = path.join(root, "conversation", ".system_generated", "logs");
  fs.mkdirSync(logDir, { recursive: true });
  const transcript = path.join(logDir, "transcript.jsonl");
  const substantive = '{"brief":"dispatch","tasks":[{"agent":"developer","task":"read-only transport review"}]}';
  fs.writeFileSync(transcript, [
    JSON.stringify({ source: "MODEL", type: "PLANNER_RESPONSE", content: substantive }),
    JSON.stringify({ source: "MODEL", type: "PLANNER_RESPONSE", content: "완료했습니다." }),
    "",
  ].join("\n"), "utf8");

  const result = reviewer.extractLatestModelResponse(root);
  assert.equal(result.response, substantive);
});

test("ignores Antigravity tool output while extracting transcript response", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-brain-"));
  const logDir = path.join(root, "conversation", ".system_generated", "logs");
  fs.mkdirSync(logDir, { recursive: true });
  const transcript = path.join(logDir, "transcript.jsonl");
  fs.writeFileSync(transcript, [
    JSON.stringify({ source: "MODEL", type: "VIEW_FILE", content: "Created At: 2026-05-27\nFile Path: x" }),
    JSON.stringify({ source: "MODEL", type: "RUN_COMMAND", content: "Created At: 2026-05-27\nOutput: ok" }),
    JSON.stringify({ source: "MODEL", type: "GENERIC", content: "Your current permission grants are: ..." }),
    JSON.stringify({ source: "MODEL", type: "PLANNER_RESPONSE", content: "1. 핵심 판정\n리뷰 본문\n4. 권장 수정\n수정\n5. 검증 명령\nnode test" }),
    "",
  ].join("\n"), "utf8");

  const result = reviewer.extractLatestModelResponse(root);
  assert.match(result.response, /핵심 판정/);
  assert.doesNotMatch(result.response, /File Path:/);
});


test("redacts common secret patterns", () => {
  const text = reviewer.redact("api_key=abc123456789012345 Authorization: Bearer abcdefghijklmnop");
  assert.match(text, /api_key=<redacted>/);
  assert.match(text, /Authorization: <redacted>/);
});

test("strips Gemini CLI warning noise from fallback output", () => {
  const text = reviewer.stripCliNoise([
    "OK",
    "Warning: 256-color support not detected.",
    "Ripgrep is not available. Falling back to GrepTool.",
  ].join("\n"));
  assert.equal(text, "OK");
});

test("resolves a callable Gemini invocation", () => {
  const invocation = reviewer.geminiCliInvocation();
  assert.equal(typeof invocation.cmd, "string");
  assert.ok(invocation.cmd.length > 0);
  assert.equal(Array.isArray(invocation.argsPrefix), true);
});

test("detects Antigravity quota exhaustion from recent CLI logs", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-log-"));
  const log = path.join(root, "cli-20260528_033829.log");
  fs.writeFileSync(log, [
    "I0528 print mode started",
    "E0528 agent executor error: RESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 141h44m42s.",
  ].join("\n"), "utf8");

  const diagnostic = reviewer.latestAgyDiagnostic(root, Date.now() - 10000);
  assert.equal(diagnostic.status, "RATE_LIMITED");
  assert.match(diagnostic.message, /RESOURCE_EXHAUSTED|quota|429/i);
});

test("does not classify process ids containing 429 as quota exhaustion", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-log-"));
  const log = path.join(root, "cli-20260528_062831.log");
  fs.writeFileSync(log, [
    "I0528 06:28:32.266328 42960 server_oauth.go:217] OAuth: authenticated successfully as user@example.com",
    "I0528 06:28:38.150647 42960 http_helpers.go:182] URL: https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",
    "I0528 06:28:40.633690 42960 server.go:2183] Language server shutting down",
  ].join("\n"), "utf8");

  const diagnostic = reviewer.latestAgyDiagnostic(root, Date.now() - 10000);
  assert.equal(diagnostic.status, "");
});

test("extracts latest observed Antigravity model label from CLI logs", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-log-"));
  const log = path.join(root, "cli-20260528_063710.log");
  fs.writeFileSync(log, [
    "I0528 06:37:13.062326 5084 model_config_manager.go:157] Propagating selected model override to backend: label=\"Gemini 3.5 Flash (Medium)\"",
    "I0528 06:37:17.538127 5084 model_config_manager.go:157] Propagating selected model override to backend: label=\"Claude Opus 4.6 (Thinking)\"",
  ].join("\n"), "utf8");

  const observed = reviewer.latestObservedModelLabel(root, Date.now() - 10000);
  assert.equal(observed.label, "Claude Opus 4.6 (Thinking)");
  assert.equal(observed.log, log);
});

test("returns empty observed model when no model override is logged", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-log-"));
  fs.writeFileSync(path.join(root, "cli-20260528_063710.log"), "OAuth: authenticated successfully as user@example.com", "utf8");

  const observed = reviewer.latestObservedModelLabel(root, Date.now() - 10000);
  assert.deepEqual(observed, { label: "", log: "" });
});

test("classifies non-empty CLI failure text as unusable output", () => {
  assert.equal(reviewer.looksLikeCliFailureResponse("CEO 호출 실패: Antigravity CLI failed exit=0"), true);
  assert.equal(reviewer.looksLikeCliFailureResponse("모든 에이전트의 LLM 호출이 실패했습니다."), true);
  assert.equal(reviewer.looksLikeCliFailureResponse("RESOURCE_EXHAUSTED: quota reached"), true);
  assert.equal(reviewer.looksLikeCliFailureResponse("Connect AI 운영 구조는 Codex와 Claude executor를 중심으로 구성됩니다."), false);
});

test("does not classify valid review findings as CLI failure just because they mention errors", () => {
  const review = [
    "## 1. 핵심 판정",
    "전송 계층에 SyntaxError 및 JSON parsing 실패 위험이 있습니다.",
    "## 2. 발견한 문제",
    "error: 문자열은 분석 대상 로그에서 나온 증거입니다.",
    "## 5. 검증 명령",
    "node scripts/planner-cli-smoke.test.js",
  ].join("\n");
  assert.equal(reviewer.looksLikeCliFailureResponse(review), false);
});

test("recognizes only agy/stdout/transcript as direct Antigravity sources", () => {
  assert.equal(reviewer.isDirectSource("stdout"), true);
  assert.equal(reviewer.isDirectSource("transcript"), true);
  assert.equal(reviewer.isDirectSource("agy"), true);
  assert.equal(reviewer.isDirectSource("antigravity"), true);
  assert.equal(reviewer.isDirectSource("gemini-fallback"), false);
  assert.equal(reviewer.isDirectSource(""), false);
});

test("documents that requested model labels must match observed model labels", () => {
  assert.equal(reviewer.modelSelectionState("", "Gemini 3.5 Flash (Medium)"), null);
  assert.equal(reviewer.modelSelectionState("Claude Opus 4.6 (Thinking)", "Claude Opus 4.6 (Thinking)"), true);
  assert.equal(reviewer.modelSelectionState("Claude Opus 4.6 (Thinking)", "Gemini 3.5 Flash (Medium)"), false);
});
