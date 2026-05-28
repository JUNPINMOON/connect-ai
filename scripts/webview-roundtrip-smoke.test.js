#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { analyzeSources } = require("./webview-roundtrip-smoke.js");

test("Connect AI sidebar prompt roundtrip contract is intact", () => {
  const result = analyzeSources();
  assert.equal(result.success, true, result.checks.filter((check) => !check.ok).map((check) => check.id).join(", "));
  assert.equal(result.checks.length >= 8, true);
});

test("Connect AI sidebar natural worker handoff is covered by roundtrip smoke", () => {
  const result = analyzeSources();
  assert.ok(
    result.checks.some((check) => check.id === "extension_prompt_recognizes_natural_queue_dispatch"),
    "webview smoke should expose the natural Korean queue-dispatch shortcut check"
  );
});
