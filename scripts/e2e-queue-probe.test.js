#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const test = require("node:test");

const probeCli = path.join(__dirname, "e2e-queue-probe.js");
const {
  buildAddArgs,
  buildProbePrompt,
  buildRunArgs,
  parseLastJson,
  summarizeQueue,
} = require("./e2e-queue-probe.js");

function runProbe(args, env) {
  const output = execFileSync(process.execPath, [probeCli, ...args], {
    cwd: path.resolve(__dirname, ".."),
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  return JSON.parse(output);
}

test("dry-run reports planned Codex probe without creating the queue", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-probe-"));
  const queueFile = path.join(tempDir, "agent-queue.json");

  const result = runProbe([], { CONNECT_AI_AGENT_QUEUE: queueFile });

  assert.equal(result.success, true);
  assert.equal(result.mode, "dry-run");
  assert.equal(result.mutatesQueue, false);
  assert.equal(result.selectedExecutor, "codex");
  assert.equal(result.queueBefore.total, 0);
  assert.match(result.expectedRunCommand, /--only codex/);
  assert.match(result.expectedRunCommand, /--id aq-probe-/);
  assert.equal(fs.existsSync(queueFile), false);
});

test("probe prompt is strictly read-only and asks for concrete evidence", () => {
  const prompt = buildProbePrompt();

  assert.match(prompt, /read-only diagnostic task/i);
  assert.match(prompt, /Do not edit, create, delete/i);
  assert.match(prompt, /Do not touch protected paths/i);
  assert.match(prompt, /실제 파일 수정 없음/);
  assert.match(prompt, /List files inspected/i);
  assert.doesNotMatch(prompt, /write\s+(a|the|new)\s+file/i);
});

test("add and run arguments pin one Codex task by id", () => {
  const promptFile = path.join(os.tmpdir(), "probe-prompt.txt");
  const addArgs = buildAddArgs(promptFile, "aq-probe-test");
  const runArgs = buildRunArgs("aq-probe-test", 12345);

  assert.deepEqual(addArgs.slice(0, 5), ["add", "--id", "aq-probe-test", "--assignee", "codex"]);
  assert.ok(addArgs.includes("--prompt-file"));
  assert.ok(addArgs.includes(promptFile));
  assert.ok(addArgs.includes(path.join(path.resolve(__dirname, ".."), "scripts", "codex-worker.js")));
  assert.deepEqual(runArgs, ["--execute", "--only", "codex", "--id", "aq-probe-test", "--max", "1", "--codex-timeout-ms", "12345"]);
});

test("parseLastJson accepts logs before final JSON", () => {
  assert.deepEqual(parseLastJson("log line\n{\"success\":true,\"n\":1}\n"), { success: true, n: 1 });
});

test("summarizeQueue counts known statuses", () => {
  const summary = summarizeQueue({
    path: "queue.json",
    count: 3,
    items: [
      { status: "queued" },
      { status: "blocked" },
      { status: "done" },
    ],
  });

  assert.equal(summary.total, 3);
  assert.equal(summary.queued, 1);
  assert.equal(summary.blocked, 1);
  assert.equal(summary.done, 1);
  assert.equal(summary.running, 0);
});

test("probe source treats ready_for_verification as successful executor handoff evidence", () => {
  const source = fs.readFileSync(probeCli, "utf8");
  assert.match(source, /item\.status === "ready_for_verification"/);
  assert.doesNotMatch(source, /item\.status === "done"/);
  assert.match(source, /verifier acceptance is separate Agent OS scope/);
});
