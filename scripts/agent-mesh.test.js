#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const AgentMesh = require("./agent-mesh.js");

const sourcePath = path.join(__dirname, "agent-mesh.js");

function tempDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), name));
}

test("agent mesh stores coordination state under runtime root, not vault", () => {
  const runtimeRoot = tempDir("connect-ai-mesh-runtime-");
  const vaultRoot = tempDir("connect-ai-mesh-vault-");
  const queuePath = path.join(runtimeRoot, "agent-queue.json");
  fs.writeFileSync(queuePath, "[]\n", "utf8");

  const mesh = new AgentMesh({ meshRoot: path.join(runtimeRoot, "agent-mesh"), agentQueuePath: queuePath, vaultPath: vaultRoot });

  assert.equal(mesh.agentsDir.startsWith(runtimeRoot), true);
  assert.equal(mesh.coordinationDir.startsWith(runtimeRoot), true);
  assert.equal(mesh.stateDir.startsWith(runtimeRoot), true);
  assert.equal(fs.existsSync(path.join(vaultRoot, "agents")), false);
  assert.equal(fs.existsSync(path.join(vaultRoot, "coordination")), false);
  assert.equal(fs.existsSync(path.join(vaultRoot, "agent-state")), false);
});

test("agent mesh source has no Obsidian vault fallback path", () => {
  const source = fs.readFileSync(sourcePath, "utf8");
  assert.doesNotMatch(source, /defaultVaultPath/);
  assert.doesNotMatch(source, /connect-ai-vault/);
  assert.doesNotMatch(source, /this\.vaultPath/);
});

test("agent mesh completion advances queue work to ready_for_verification, not done", async () => {
  const runtimeRoot = tempDir("connect-ai-mesh-queue-");
  const queuePath = path.join(runtimeRoot, "agent-queue.json");
  fs.writeFileSync(queuePath, JSON.stringify([{
    id: "aq-mesh-1",
    assignee: "codex",
    status: "running",
    title: "Mesh queue transition smoke",
    resultSummary: "",
  }], null, 2), "utf8");

  const mesh = new AgentMesh({ meshRoot: path.join(runtimeRoot, "agent-mesh"), agentQueuePath: queuePath });
  const taskId = mesh.createTask("mesh", "codex", { description: "Connect AI implementation smoke", agentQueueId: "aq-mesh-1" });
  await mesh.executeTask(taskId);

  const queue = JSON.parse(fs.readFileSync(queuePath, "utf8"));
  assert.equal(queue[0].status, "ready_for_verification");
  assert.match(queue[0].resultSummary, /READY_FOR_VERIFICATION/);
  assert.equal(Object.hasOwn(queue[0], "completedAt"), false);
});
