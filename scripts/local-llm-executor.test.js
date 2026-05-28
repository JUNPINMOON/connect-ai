#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const localExecutor = require("./local-llm-executor.js");

test("local LLM executor blocks model output that claims a file write", () => {
  const result = localExecutor.buildLocalSmokeResult({
    model: "qwen2.5-coder:1.5b",
    latencyMs: 25,
    rawEvidence: "Added hello world comment to the file.",
  });

  assert.equal(result.success, false);
  assert.equal(result.status, "BLOCKED");
  assert.deepEqual(result.filesChanged, []);
  assert.match(result.evidence, /LOCAL_SMOKE_ONLY/);
  assert.match(result.evidence, /MODEL_WRITE_CLAIM_IGNORED/);
  assert.doesNotMatch(result.evidence, /Added hello world comment/);
  assert.ok(result.unresolvedFailures.includes("LOCAL_LLM_CLAIMED_WRITE_WITHOUT_WRITE_PERMISSION"));
});

test("local LLM executor can return read-only smoke evidence without file changes", () => {
  const result = localExecutor.buildLocalSmokeResult({
    model: "qwen2.5-coder:1.5b",
    latencyMs: 25,
    rawEvidence: "The task is low risk and should be routed to local smoke.",
  });

  assert.equal(result.success, true);
  assert.equal(result.status, "READY_FOR_VERIFICATION");
  assert.deepEqual(result.filesChanged, []);
  assert.match(result.evidence, /LOCAL_SMOKE_ONLY/);
  assert.match(result.evidence, /The task is low risk/);
});

test("local LLM executor blocks template echo evidence", () => {
  const result = localExecutor.buildLocalSmokeResult({
    model: "qwen2.5-coder:1.5b",
    latencyMs: 25,
    rawEvidence: JSON.stringify({
      status: "READY_FOR_VERIFICATION",
      executor: "local-llm",
      filesChanged: ["C:\\Users\\mjb58\\connect-ai-runtime\\company\\s5-dispatch\\local-llm-smoke-fixed-20260528-065541.txt"],
      commandsRun: [],
      unresolvedFailures: [],
      evidence: "short current-run evidence",
    }),
  });

  assert.equal(result.success, false);
  assert.equal(result.status, "BLOCKED");
  assert.deepEqual(result.filesChanged, []);
  assert.match(result.evidence, /LOCAL_SMOKE_ONLY/);
  assert.match(result.evidence, /TEMPLATE_ECHO_IGNORED/);
  assert.doesNotMatch(result.evidence, /short current-run evidence/);
  assert.ok(result.unresolvedFailures.includes("LOCAL_LLM_TEMPLATE_ECHO_EVIDENCE"));
});
