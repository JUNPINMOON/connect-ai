#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "..");
const watcher = path.join(repoRoot, "scripts", "approval-watcher.ps1");

function runWatcher(args) {
  return spawnSync("powershell", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    watcher,
    "-NoToast",
    ...args,
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
    timeout: 60000,
  });
}

test("approval watcher detects root migration approval packets without approval queue", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-approval-watcher-"));
  const queuePath = path.join(root, "phase2", "approval-queue.jsonl");
  const packetDir = path.join(root, "phase2", "vault-writer", "approval-packets");
  const statePath = path.join(root, "phase2", "approval-watcher.state.json");
  fs.mkdirSync(packetDir, { recursive: true });
  fs.writeFileSync(path.join(packetDir, "root-migration-test.json"), `${JSON.stringify({
    batchId: "root-migration-test",
    readyForApproval: true,
    requiresExplicitHumanApproval: true,
    approved: false,
    counts: { plannedMoves: 35 },
  })}\n`, "utf8");

  const first = runWatcher([
    "-QueuePath", queuePath,
    "-ApprovalPacketDir", packetDir,
    "-StatePath", statePath,
  ]);

  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /approval queue missing/);
  assert.match(first.stdout, /pending approval packet: root-note-migration \/ plannedMoves=35 \/ root-migration-test/);
  const state = JSON.parse(fs.readFileSync(statePath, "utf8").replace(/^\uFEFF/, ""));
  assert.deepEqual(state.seenTokens, ["packet:root-migration-test"]);

  const second = runWatcher([
    "-QueuePath", queuePath,
    "-ApprovalPacketDir", packetDir,
    "-StatePath", statePath,
  ]);

  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /no pending approvals/);
  assert.doesNotMatch(second.stdout, /pending approval packet/);
});
