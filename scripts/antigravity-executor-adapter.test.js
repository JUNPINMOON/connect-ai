#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const adapter = require("./antigravity-executor-adapter.js");

test("antigravity adapter blocks missing or mismatched observed models", () => {
  const missing = adapter.validateAntigravityExecutorResult({
    requestedModelLabel: "Claude Opus 4.6 (Thinking)",
  });
  assert.equal(missing.status, "BLOCKED");
  assert.equal(missing.reason, "MISSING_OBSERVED_MODEL");

  const mismatch = adapter.validateAntigravityExecutorResult({
    requestedModelLabel: "Claude Opus 4.6 (Thinking)",
    observedModelLabel: "Gemini 3.5 Flash (Medium)",
  });
  assert.equal(mismatch.status, "BLOCKED");
  assert.equal(mismatch.reason, "MODEL_MISMATCH");
});
