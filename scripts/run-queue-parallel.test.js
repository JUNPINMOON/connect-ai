#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { selectParallel, normalizeMaxWorkers, summarizeExecutionResults } = require("./run-queue-parallel.js");

function withAutomationContract(item) {
  const risk = item.risk || item.riskClass || (item.assignee === "gemini" || item.assignee === "antigravity" || item.assignee === "local-llm" ? "Green" : "Yellow");
  return {
    risk,
    riskClass: risk,
    writeScope: [`readonly/${item.id}`],
    expectedTests: ["current-run evidence"],
    rollbackPath: "not-applicable",
    executor: item.assignee,
    reviewer: "pending-s7",
    ...item,
  };
}

test("parallel selector chooses safe disjoint workers", () => {
  const selected = selectParallel([
    withAutomationContract({ id: "1", status: "queued", assignee: "codex", title: "Implement A", prompt: "implement", priority: "P1", writeScope: ["scripts/a.js"] }),
    withAutomationContract({ id: "2", status: "queued", assignee: "claude", title: "Implement B", prompt: "implement", priority: "P1", writeScope: ["docs/b.md"] }),
    withAutomationContract({ id: "3", status: "queued", assignee: "gemini", title: "Read-only review", prompt: "read-only review", priority: "P2" }),
  ], 3);
  assert.equal(selected.length, 3);
});

test("parallel selector avoids same write scope and red tasks", () => {
  const selected = selectParallel([
    withAutomationContract({ id: "1", status: "queued", assignee: "codex", title: "Implement A", prompt: "implement", priority: "P1", writeScope: ["scripts"] }),
    withAutomationContract({ id: "2", status: "queued", assignee: "claude", title: "Implement same", prompt: "implement", priority: "P1", writeScope: ["scripts/a.js"] }),
    { id: "3", status: "queued", assignee: "codex", title: "Decision request: approve", prompt: "approval", priority: "P0" },
  ], 3);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].id, "1");
});

test("parallel selector avoids sibling file write scopes in the same directory", () => {
  const selected = selectParallel([
    withAutomationContract({ id: "1", status: "queued", assignee: "codex", title: "Implement A", prompt: "implement", priority: "P1", writeScope: ["scripts/a.js"], canWrite: true }),
    withAutomationContract({ id: "2", status: "queued", assignee: "claude", title: "Implement B", prompt: "implement", priority: "P1", writeScope: ["scripts/b.js"], canWrite: true }),
    withAutomationContract({ id: "3", status: "queued", assignee: "gemini", title: "Read-only review", prompt: "read-only review", priority: "P2" }),
  ], 3);
  assert.deepEqual(selected.map((item) => item.id), ["1", "3"]);
});

test("parallel selector skips tasks with exhausted retry budget", () => {
  const selected = selectParallel([
    withAutomationContract({ id: "1", status: "queued", assignee: "codex", title: "Implement exhausted", prompt: "implement", priority: "P0", retryBudget: 0, runAttempts: 1, writeScope: ["scripts/a.js"] }),
    withAutomationContract({ id: "2", status: "queued", assignee: "claude", title: "Implement available", prompt: "implement", priority: "P1", retryBudget: 0, runAttempts: 0, writeScope: ["docs/b.md"] }),
  ], 2);
  assert.deepEqual(selected.map((item) => item.id), ["2"]);
});

test("parallel selector skips tasks missing required automation contract fields", () => {
  const selected = selectParallel([
    {
      id: "1",
      status: "queued",
      assignee: "codex",
      title: "Ambiguous implementation",
      prompt: "Modify whatever is needed.",
      priority: "P1",
      riskClass: "Yellow",
    },
    {
      id: "2",
      status: "queued",
      assignee: "claude",
      title: "Guarded implementation",
      prompt: "Modify the scoped docs file.",
      priority: "P1",
      risk: "Yellow",
      riskClass: "Yellow",
      writeScope: ["docs/guarded.md"],
      expectedTests: ["docs review evidence"],
      rollbackPath: "revert docs/guarded.md",
      executor: "claude",
      reviewer: "pending-s7",
    },
  ], 2);
  assert.deepEqual(selected.map((item) => item.id), ["2"]);
});

test("parallel runner caps max workers at the Phase C guardrail", () => {
  assert.equal(typeof normalizeMaxWorkers, "function");
  assert.equal(normalizeMaxWorkers(undefined), 2);
  assert.equal(normalizeMaxWorkers("not-a-number"), 2);
  assert.equal(normalizeMaxWorkers("1"), 1);
  assert.equal(normalizeMaxWorkers("2"), 2);
  assert.equal(normalizeMaxWorkers("3"), 3);
  assert.equal(normalizeMaxWorkers("4"), 3);
  assert.equal(normalizeMaxWorkers("99"), 3);
});

test("parallel execution summary fails when any worker fails", () => {
  assert.equal(typeof summarizeExecutionResults, "function");
  const summary = summarizeExecutionResults([
    { id: "1", assignee: "codex", success: true, exitCode: 0 },
    { id: "2", assignee: "claude", success: false, exitCode: 1 },
  ]);
  assert.equal(summary.success, false);
  assert.equal(summary.exitCode, 1);
  assert.deepEqual(summary.failed.map((item) => item.id), ["2"]);
});

test("parallel execution summary fails when nested worker result is blocked", () => {
  const summary = summarizeExecutionResults([
    {
      id: "1",
      assignee: "local-llm",
      success: true,
      exitCode: 0,
      result: {
        mode: "execute",
        processed: 1,
        results: [
          { status: "blocked", success: false, reason: "NO_WRITE_WORKER_MODIFIED_FILES" },
        ],
      },
    },
  ]);
  assert.equal(summary.success, false);
  assert.equal(summary.exitCode, 1);
  assert.deepEqual(summary.failed.map((item) => item.id), ["1"]);
});

test("parallel executor pins selected task ids when spawning run-queue", () => {
  const source = require("node:fs").readFileSync(require("node:path").join(__dirname, "run-queue-parallel.js"), "utf8");
  assert.match(source, /"--id",\s*item\.id/);
  assert.match(source, /id:\s*item\.id/);
  assert.match(source, /process\.exitCode\s*=\s*summary\.exitCode/);
});

test("serial runner makes Claude max turns configurable", () => {
  const source = require("node:fs").readFileSync(require("node:path").join(__dirname, "run-queue.js"), "utf8");
  assert.match(source, /claude-max-turns/);
  assert.doesNotMatch(source, /"--max-turns",\s*"8"/);
});

test("serial runner includes local LLM smoke worker path", () => {
  const source = require("node:fs").readFileSync(require("node:path").join(__dirname, "run-queue.js"), "utf8");
  assert.match(source, /local-llm/);
  assert.match(source, /localLlmWorker/);
  assert.match(source, /local-llm-run-queue/);
});

test("serial runner sends Gemini tasks to the Gemini executor worker, not the old reviewer worker", () => {
  const path = require("node:path");
  const runner = require("./run-queue.js");
  assert.equal(path.basename(runner.workerScriptFor({ assignee: "gemini", role: "reviewer", intent: "queue-dispatch-gemini" })), "gemini-worker.js");
  assert.equal(path.basename(runner.workerScriptFor({ assignee: "gemini", role: "verifier", intent: "verification" })), "google-reviewer-worker.js");
});
