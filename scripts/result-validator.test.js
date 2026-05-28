#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { validateItem } = require("./result-validator.js");

test("rejects non-final done output and approval claims", () => {
  assert.equal(validateItem({ status: "done", resultSummary: "I'll start by reading.", title: "Audit", assignee: "claude" }).valid, false);
  assert.equal(validateItem({ status: "done", resultSummary: "사용자 승인 완료", title: "Decision request: approval", assignee: "hermes" }).valid, false);
});

test("accepts evidence-bearing done output", () => {
  const result = validateItem({
    id: "aq-ok",
    title: "Read-only audit",
    assignee: "antigravity",
    status: "done",
    resultSummary: "Evidence: files inspected. Commands run: agy run read-only audit. Expected tests/evidence: transcript inspected. Unresolved failures: none.",
  });
  assert.equal(result.valid, true);
});

test("rejects ready-for-verification when required evidence is missing", () => {
  const result = validateItem({
    id: "aq-missing-evidence",
    title: "Implement scoped change",
    assignee: "codex",
    status: "ready_for_verification",
    resultSummary: "READY_FOR_VERIFICATION: work complete.",
    evidenceRequired: ["files changed", "commands run"],
  });
  assert.equal(result.valid, false);
  assert.ok(result.findings.includes("MISSING_REQUIRED_EVIDENCE"));
  assert.deepEqual(result.missingEvidence, ["files changed", "commands run"]);
});

test("accepts ready-for-verification with required evidence labels", () => {
  const result = validateItem({
    id: "aq-evidence",
    title: "Implement scoped change",
    assignee: "codex",
    status: "ready_for_verification",
    resultSummary: "READY_FOR_VERIFICATION: Files changed: scripts/example.js. Commands run: node --test scripts/example.test.js. Unresolved failures: none.",
    evidenceRequired: ["files changed", "commands run", "unresolved failures"],
  });
  assert.equal(result.valid, true);
});

test("rejects unresolved failure evidence when failures remain", () => {
  const result = validateItem({
    id: "aq-open-failure",
    title: "Implement scoped change",
    assignee: "codex",
    status: "ready_for_verification",
    resultSummary: "READY_FOR_VERIFICATION: Files changed: scripts/example.js. Commands run: node --test scripts/example.test.js. Unresolved failures: transport smoke still failing.",
    evidenceRequired: ["files changed", "commands run", "unresolved failures"],
  });
  assert.equal(result.valid, false);
  assert.ok(result.findings.includes("MISSING_REQUIRED_EVIDENCE"));
  assert.deepEqual(result.missingEvidence, ["unresolved failures"]);
});

test("rejects commands-run evidence when commands were not run", () => {
  const result = validateItem({
    id: "aq-no-commands",
    title: "Implement scoped change",
    assignee: "codex",
    status: "ready_for_verification",
    resultSummary: "READY_FOR_VERIFICATION: Files changed: scripts/example.js. Commands run: not run. Unresolved failures: none.",
    evidenceRequired: ["files changed", "commands run", "unresolved failures"],
  });
  assert.equal(result.valid, false);
  assert.ok(result.findings.includes("MISSING_REQUIRED_EVIDENCE"));
  assert.deepEqual(result.missingEvidence, ["commands run"]);
});

test("rejects current-run evidence when tests are failed or missing", () => {
  const result = validateItem({
    id: "aq-missing-current-run",
    title: "Implement scoped change",
    assignee: "codex",
    status: "ready_for_verification",
    resultSummary: "READY_FOR_VERIFICATION: Files changed: scripts/example.js. Commands run: npm run compile. Current-run expected tests/evidence: required tests failed and evidence is missing. Unresolved failures: none.",
    evidenceRequired: ["files changed", "commands run", "current-run expected tests/evidence", "unresolved failures"],
  });
  assert.equal(result.valid, false);
  assert.ok(result.findings.includes("MISSING_REQUIRED_EVIDENCE"));
  assert.deepEqual(result.missingEvidence, ["current-run expected tests/evidence"]);
});
