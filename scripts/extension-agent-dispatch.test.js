#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const envPaths = require("./env-paths.js");

const repoRoot = envPaths.repoRoot();
const extensionPath = path.join(repoRoot, "src", "extension.ts");

function source() {
  return fs.readFileSync(extensionPath, "utf8");
}

test("extension queue model preserves local LLM and READY_FOR_VERIFICATION items", () => {
  const text = source();

  assert.match(text, /type AgentQueueAssignee = [^;]*'local-llm'/);
  assert.match(text, /type AgentQueueAssignee = [^;]*'gemini'/);
  assert.match(text, /type AgentQueueStatus = [^;]*'ready_for_verification'/);
  assert.match(text, /\[[^\]]*'ready_for_verification'[^\]]*\]\.includes\(String\(value\)\)/);
});

test("command palette exposes a Connect AI Agent OS dispatch command", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const commands = pkg.contributes?.commands || [];

  assert.ok(
    commands.some((command) => command.command === "connectAiLab.agent.dispatchGoal"),
    "package.json should contribute connectAiLab.agent.dispatchGoal"
  );
  assert.match(source(), /registerCommand\('connectAiLab\.agent\.dispatchGoal'/);
});

test("command palette exposes Agent OS verifier dispatch for RFV items", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const commands = pkg.contributes?.commands || [];
  const text = source();

  assert.ok(
    commands.some((command) => command.command === "connectAiLab.agent.dispatchVerification"),
    "package.json should contribute connectAiLab.agent.dispatchVerification"
  );
  assert.match(text, /registerCommand\('connectAiLab\.agent\.dispatchVerification'/);
  assert.match(text, /function createAgentVerificationQueueItems/);
  assert.match(text, /ready_for_verification/);
  assert.match(text, /\[verify-source:\$\{source\.id\}\]/);
  assert.match(text, /role: 'verifier'/);
  assert.match(text, /intent: 'verification'/);
  assert.match(text, /assignee: reviewer/);
  assert.match(text, /Do not edit, create, delete, move, send, deploy, authenticate, approve, or mutate queue state/);
});

test("command palette exposes Agent OS verifier apply for accepted evidence", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const commands = pkg.contributes?.commands || [];
  const text = source();
  const readQueueStart = text.indexOf("function readAgentQueue");
  const writeQueueStart = text.indexOf("function writeAgentQueue");
  assert.notEqual(readQueueStart, -1);
  assert.notEqual(writeQueueStart, -1);
  const readQueueBody = text.slice(readQueueStart, writeQueueStart);

  assert.ok(
    commands.some((command) => command.command === "connectAiLab.agent.applyVerification"),
    "package.json should contribute connectAiLab.agent.applyVerification"
  );
  assert.match(text, /registerCommand\('connectAiLab\.agent\.applyVerification'/);
  assert.match(text, /function applyAgentVerificationEvidence/);
  assert.match(text, /role === 'verifier'/);
  assert.match(text, /intent === 'verification'/);
  assert.match(text, /검증\s*판정/);
  assert.match(text, /누락\s*증거/);
  assert.match(text, /VERIFIER_ACCEPT/);
  assert.match(text, /agentOsStatus = 'DONE'/);
  assert.match(readQueueBody, /verifiedAt:/, "readAgentQueue should preserve verifier evidence timestamps");
  assert.match(readQueueBody, /completedAt:/, "readAgentQueue should preserve closure timestamps");
});

test("extension dispatch command writes only runtime queue items, never direct vault notes", () => {
  const text = source();

  assert.match(text, /function createAgentDispatchQueueItem/);
  assert.match(text, /direct Obsidian vault writes are forbidden/);
  assert.match(text, /agentOsStatus: 'QUEUED'/);
  assert.match(text, /role: _roleForDispatch\(executor\)/);
  assert.match(text, /stopCondition: _stopConditionForDispatch\(executor\)/);
  assert.match(text, /approvalCondition: _approvalConditionForDispatch\(executor\)/);
  assert.match(text, /evidenceRequired: _evidenceRequiredForDispatch\(executor\)/);
  assert.match(text, /reviewer: 'pending-s7'/);
});

test("extension queue reader preserves Agent OS dispatch metadata on rewrite", () => {
  const text = source();
  const readQueueStart = text.indexOf("function readAgentQueue");
  const writeQueueStart = text.indexOf("function writeAgentQueue");
  assert.notEqual(readQueueStart, -1);
  assert.notEqual(writeQueueStart, -1);
  const readQueueBody = text.slice(readQueueStart, writeQueueStart);

  for (const field of [
    "risk",
    "role",
    "stopCondition",
    "approvalCondition",
    "evidenceRequired",
    "executor",
    "reviewer",
    "intent",
    "expectedTests",
    "rollbackPath",
    "tokenBudget",
    "retryBudget",
    "canWrite",
    "agentOsStatus",
  ]) {
    assert.match(readQueueBody, new RegExp(`${field}:`), `readAgentQueue should preserve ${field}`);
  }
});

test("extension queue writer uses atomic replace with backup", () => {
  const text = source();
  const writeQueueStart = text.indexOf("function writeAgentQueue");
  const nextFunction = text.indexOf("function updateAgentQueueStatus", writeQueueStart);
  assert.notEqual(writeQueueStart, -1);
  assert.notEqual(nextFunction, -1);
  const writeQueueBody = text.slice(writeQueueStart, nextFunction);

  assert.match(writeQueueBody, /const backup = `\$\{p\}\.bak`/);
  assert.match(writeQueueBody, /writeFileSync\(tmp/);
  assert.match(writeQueueBody, /renameSync\(tmp,\s*p\)/);
});

test("sidebar chat exposes an explicit Agent OS queue dispatch shortcut", () => {
  const text = source();
  const promptCase = (text.match(/case 'prompt':[\s\S]*?break;\n\s*}/) || [""])[0];
  const shortcutFunction = (text.match(/function parseAgentDispatchShortcut[\s\S]*?function _agentDispatchStamp/) || [""])[0];

  assert.match(shortcutFunction, /agentos\|agent\|dispatch\|queue/);
  assert.match(shortcutFunction, /_extractAgentDispatchOption\(body, 'executor'\)/);
  assert.match(shortcutFunction, /local-llm/);
  assert.match(shortcutFunction, /_extractAgentDispatchOption\(body, 'file'\)/);
  assert.match(promptCase, /parseAgentDispatchShortcut\(txt\)/);
  assert.match(promptCase, /createAgentDispatchQueueItem\(agentShortcut\)/);
  assert.match(text, /READY_FOR_VERIFICATION/);
});

test("sidebar chat recognizes natural Korean worker handoff prefixes as queue dispatch", () => {
  const text = source();
  const shortcutFunction = (text.match(/function parseAgentDispatchShortcut[\s\S]*?function _agentDispatchStamp/) || [""])[0];

  assert.match(shortcutFunction, /작업\\s\*\(\?:시켜\|하달\|맡겨\|등록\)/);
  assert.match(shortcutFunction, /\(\?:worker\|워커\)\\s\*\(\?:하달\|등록\|시켜\)/i);
  assert.match(shortcutFunction, /큐\\s\*\(\?:등록\|하달\|넣어\|추가\)/);
});

test("extension dispatch route accepts Gemini as an explicit executor", () => {
  const text = source();
  const dispatchType = text.match(/type AgentDispatchExecutor = [^;]+;/)?.[0] || "";
  const shortcutFunction = (text.match(/function parseAgentDispatchShortcut[\s\S]*?function _agentDispatchStamp/) || [""])[0];
  const selectFunction = (text.match(/function _selectAgentDispatchExecutor[\s\S]*?function _workerClassForDispatch/) || [""])[0];
  const pickerBlock = (text.match(/showQuickPick\(\[[\s\S]*?\], \{ placeHolder: 'Executor route'/) || [""])[0];

  assert.match(dispatchType, /'gemini'/);
  assert.match(shortcutFunction, /\['auto', 'codex', 'antigravity', 'gemini', 'local-llm'\]/);
  assert.match(selectFunction, /requested === 'gemini'/);
  assert.match(pickerBlock, /label: 'gemini'/);
});
