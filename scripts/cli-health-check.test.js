#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { classify, quoteCmdArg } = require("./cli-health-check.js");

test("classifies common CLI health states", () => {
  assert.equal(classify({ exitCode: 0, stdout: "1.0.0", stderr: "" }, /\d/), "READY");
  assert.equal(classify({ exitCode: 1, stdout: "", stderr: "not logged in" }), "AUTH_EXPIRED");
  assert.equal(classify({ exitCode: 1, stdout: "", stderr: "rate limit exceeded" }), "RATE_LIMITED");
  assert.equal(classify({ exitCode: 1, stdout: "", stderr: "command not found" }), "CLI_MISSING");
  assert.equal(classify({ exitCode: 0, stdout: "", stderr: "" }, /OK/), "BROKEN_OUTPUT");
});

test("quotes Windows command arguments without requiring spawn shell mode", () => {
  assert.equal(quoteCmdArg("codex"), "codex");
  assert.equal(quoteCmdArg("hello world"), '"hello world"');
  assert.equal(quoteCmdArg("a&b"), '"a&b"');
});
