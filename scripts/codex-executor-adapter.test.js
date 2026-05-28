#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const adapter = require("./codex-executor-adapter.js");

test("codex adapter prompt keeps vault and DONE boundaries explicit", () => {
  const prompt = adapter.buildPrompt({
    id: "task-1",
    writeScope: ["scripts/example.js"],
  }, "Implement a tiny fix.");

  assert.match(prompt, /Do not mark this task DONE/);
  assert.match(prompt, /C:\\Users\\mjb58\\connect-ai-vault/);
  assert.match(prompt, /READY_FOR_VERIFICATION/);
});

test("codex adapter reports blocked status when codex execution fails", () => {
  const result = adapter.buildCodexResult({
    id: "task-1",
    writeScope: ["scripts/example.js"],
  }, {
    success: false,
    exitCode: 1,
    stderr: "codex failed",
    finalMessage: "",
  });

  assert.equal(result.success, false);
  assert.equal(result.status, "BLOCKED");
  assert.deepEqual(result.filesChanged, []);
  assert.ok(result.unresolvedFailures.includes("codex failed"));
});

test("codex adapter does not pretend allowed write scope is files changed", () => {
  const result = adapter.buildCodexResult({
    id: "task-1",
    writeScope: ["scripts/example.js"],
  }, {
    success: true,
    exitCode: 0,
    finalMessage: "No files changed.",
  });

  assert.equal(result.success, true);
  assert.equal(result.status, "READY_FOR_VERIFICATION");
  assert.deepEqual(result.filesChanged, []);
  assert.deepEqual(result.unresolvedFailures, []);
});
