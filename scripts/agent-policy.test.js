#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const policy = require("./agent-policy.js");

test("codex and claude are equal executor workers", () => {
  assert.equal(policy.AGENT_ROLES.codex.workerClass, "executor");
  assert.equal(policy.AGENT_ROLES.claude.workerClass, "executor");
  assert.equal(policy.AGENT_ROLES.codex.canWrite, true);
  assert.equal(policy.AGENT_ROLES.claude.canWrite, true);
  assert.equal(policy.AGENT_ROLES.codex.canApprove, false);
  assert.equal(policy.AGENT_ROLES.claude.canApprove, false);
});

test("local LLM is a Green local-smoke worker without write authority", () => {
  assert.equal(policy.AGENT_ROLES["local-llm"].workerClass, "local-smoke");
  assert.equal(policy.AGENT_ROLES["local-llm"].canWrite, false);
  assert.equal(policy.defaultAllowedAssignees({ title: "Short comment classification", riskClass: "Green" }).includes("local-llm"), true);
  assert.equal(policy.canAssigneeRun({
    assignee: "local-llm",
    title: "Short comment classification",
    prompt: "Read-only classify this non-secret text.",
    riskClass: "Green",
  }).ok, true);
  assert.equal(policy.canAssigneeRun({
    assignee: "local-llm",
    title: "Implement code change",
    prompt: "Modify scripts/example.js.",
    riskClass: "Yellow",
  }).ok, false);
});

test("gemini and antigravity are reviewer-only", () => {
  assert.equal(policy.AGENT_ROLES.gemini.workerClass, "reviewer");
  assert.equal(policy.AGENT_ROLES.antigravity.workerClass, "reviewer");
  assert.equal(policy.canAssigneeRun({ title: "Implement feature", prompt: "Edit files" }, "gemini").ok, false);
  assert.equal(policy.canAssigneeRun({ title: "Read-only audit", prompt: "Read-only review" }, "gemini").ok, true);
});

test("queue items carry the AGENTS contract role separately from workerClass", () => {
  assert.equal(policy.normalizeQueueItem({ assignee: "codex", title: "Implement slice" }).role, "implementer");
  assert.equal(policy.normalizeQueueItem({ assignee: "claude", title: "Implement docs" }).role, "implementer");
  assert.equal(policy.normalizeQueueItem({ assignee: "gemini", title: "Read-only review", prompt: "Read-only review" }).role, "reviewer");
  assert.equal(policy.normalizeQueueItem({ assignee: "antigravity", title: "Read-only review", prompt: "Read-only review" }).role, "reviewer");
  assert.equal(policy.normalizeQueueItem({ assignee: "local-llm", title: "Read-only local smoke", prompt: "Read-only smoke" }).role, "local-smoke");
  assert.equal(policy.normalizeQueueItem({ assignee: "gemini", role: "verifier", title: "Verification request: source", prompt: "Read-only verifier" }).role, "verifier");
});

test("queue items carry stop, approval, and evidence contract fields", () => {
  const item = policy.normalizeQueueItem({
    assignee: "codex",
    title: "Implement guarded slice",
    prompt: "Modify one scoped file.",
    expectedTests: ["node --test scripts/example.test.js"],
  });

  assert.match(item.stopCondition, /retry budget|forbidden-path|required evidence/i);
  assert.match(item.approvalCondition, /credential|deploy|direct vault write|scope expansion/i);
  assert.deepEqual(item.evidenceRequired, [
    "files changed or no-write confirmation",
    "commands run",
    "current-run expected tests/evidence",
    "unresolved failures",
  ]);
});

test("automation contract requires explicit queue guard fields before auto execution", () => {
  const missing = policy.missingAutomationContractFields({
    assignee: "codex",
    title: "Implement ambiguous task",
    prompt: "Modify whatever is needed.",
  });
  assert.deepEqual(missing, ["risk", "writeScope", "expectedTests", "rollbackPath", "executor", "reviewer"]);

  const complete = policy.missingAutomationContractFields({
    assignee: "codex",
    title: "Implement guarded task",
    prompt: "Modify only the scoped file.",
    risk: "Yellow",
    riskClass: "Yellow",
    writeScope: ["scripts/example.js"],
    expectedTests: ["node --test scripts/example.test.js"],
    rollbackPath: "revert scripts/example.js",
    executor: "codex",
    reviewer: "pending-s7",
  });
  assert.deepEqual(complete, []);
});

test("verification requests stay Green despite safety boundary words", () => {
  const item = policy.normalizeQueueItem({
    title: "Verification request: Nightly audit queue gate smoke",
    assignee: "gemini",
    prompt: [
      "[verify-source:aq-test]",
      "You are a Connect AI read-only verifier.",
      "Do not edit, create, delete, move, send, deploy, authenticate, approve, or mutate queue state.",
    ].join("\n"),
  });
  assert.equal(item.riskClass, "Green");
  assert.equal(item.requiresHumanApproval, false);
  assert.equal(policy.canAssigneeRun(item, "gemini").ok, true);
});

test("red risk requires human approval", () => {
  const item = policy.normalizeQueueItem({ title: "Decision request: harness approval", prompt: "approval needed" });
  assert.equal(item.riskClass, "Red");
  assert.equal(item.requiresHumanApproval, true);
  assert.equal(policy.canAssigneeRun(item, "codex").ok, false);
});

test("explicit approvalRequired tasks are not auto-runnable without human approval", () => {
  const item = policy.normalizeQueueItem({
    title: "Yellow task gated by human approval",
    assignee: "codex",
    prompt: "Modify a scoped file only after approval.",
    riskClass: "Yellow",
    approvalRequired: true,
  });
  assert.equal(item.requiresHumanApproval, true);
  assert.equal(policy.canAssigneeRun(item, "codex").ok, false);
  assert.equal(policy.canAssigneeRun(item, "codex").reason, "HUMAN_APPROVAL_REQUIRED");
});

test("retry budget blocks repeated automatic execution after allowed attempts", () => {
  const firstAttempt = policy.normalizeQueueItem({
    title: "Implement once",
    assignee: "codex",
    prompt: "Modify a scoped file.",
    riskClass: "Yellow",
    retryBudget: 0,
    runAttempts: 0,
  });
  assert.equal(policy.canAssigneeRun(firstAttempt, "codex").ok, true);

  const exhausted = policy.normalizeQueueItem({
    ...firstAttempt,
    runAttempts: 1,
  });
  assert.equal(policy.canAssigneeRun(exhausted, "codex").ok, false);
  assert.equal(policy.canAssigneeRun(exhausted, "codex").reason, "RETRY_BUDGET_EXHAUSTED");

  const oneRetryAllowed = policy.normalizeQueueItem({
    ...firstAttempt,
    retryBudget: 1,
    runAttempts: 1,
  });
  assert.equal(policy.canAssigneeRun(oneRetryAllowed, "codex").ok, true);
  assert.equal(policy.canAssigneeRun({ ...oneRetryAllowed, runAttempts: 2 }, "codex").reason, "RETRY_BUDGET_EXHAUSTED");
});

test("forbidden write scopes are not auto-runnable", () => {
  const item = policy.normalizeQueueItem({
    title: "Write durable note directly",
    assignee: "codex",
    prompt: "Modify a note directly in the vault.",
    riskClass: "Yellow",
    writeScope: ["C:\\Users\\mjb58\\connect-ai-vault\\notes\\bad.md"],
    forbiddenPaths: ["C:\\Users\\mjb58\\connect-ai-vault"],
  });
  assert.deepEqual(policy.forbiddenPathViolations(item), [{
    target: "C:\\Users\\mjb58\\connect-ai-vault\\notes\\bad.md",
    forbidden: "C:\\Users\\mjb58\\connect-ai-vault",
  }]);
  assert.equal(policy.canAssigneeRun(item, "codex").ok, false);
  assert.equal(policy.canAssigneeRun(item, "codex").reason, "FORBIDDEN_WRITE_SCOPE");
});

test("explicit forbidden write scope is blocked even for no-write workers", () => {
  const item = policy.normalizeQueueItem({
    title: "Read-only local smoke with bad write scope",
    assignee: "local-llm",
    prompt: "Read-only summarize the target. Do not edit files.",
    riskClass: "Green",
    canWrite: false,
    writeScope: ["C:\\Users\\mjb58\\connect-ai-vault\\notes\\bad.md"],
    forbiddenPaths: ["C:\\Users\\mjb58\\connect-ai-vault"],
  });
  const result = policy.canAssigneeRun(item, "local-llm");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "FORBIDDEN_WRITE_SCOPE");
});

test("human-approved red risk can run only on executors", () => {
  const item = policy.normalizeQueueItem({
    title: "Red: approved implementation",
    prompt: "Human approved high risk implementation.",
    humanApprovedAt: "2026-05-27T00:00:00.000Z",
  });
  assert.equal(policy.canAssigneeRun(item, "codex").reason, "HUMAN_APPROVED_RED_OK");
  assert.equal(policy.canAssigneeRun(item, "claude").reason, "HUMAN_APPROVED_RED_OK");
  assert.equal(policy.canAssigneeRun(item, "gemini").reason, "HUMAN_APPROVED_RED_REQUIRES_EXECUTOR");
  assert.equal(policy.canAssigneeRun(item, "hermes").reason, "HUMAN_APPROVED_RED_REQUIRES_EXECUTOR");
});

test("explicit Green queue label survives safety-boundary wording", () => {
  const item = policy.normalizeQueueItem({
    title: "주식 Green: read-only risk audit",
    assignee: "claude",
    prompt: "Read-only audit. Do not touch broker, token, approval, protected paths, or live orders.",
  });
  assert.equal(item.riskClass, "Green");
  assert.equal(policy.canAssigneeRun(item, "claude").ok, true);
});

test("plain review tasks that forbid editing stay Green despite the word edit", () => {
  const item = policy.normalizeQueueItem({
    title: "Read-only review",
    assignee: "claude",
    prompt: "Review this task without editing files.",
  });
  assert.equal(item.riskClass, "Green");
  assert.equal(item.writeScope[0], "read-only");
  assert.equal(policy.canAssigneeRun(item, "claude").ok, true);
});

test("unlabelled unknown tasks do not fail open to Green", () => {
  const item = policy.normalizeQueueItem({ title: "Handle next project slice", assignee: "codex" });
  assert.equal(item.riskClass, "Yellow");
  assert.equal(policy.canAssigneeRun(item, "codex").ok, true);
  assert.equal(policy.canAssigneeRun(item, "gemini").ok, false);
});

test("write scopes conflict when paths overlap", () => {
  assert.equal(policy.scopesConflict({ writeScope: ["scripts"] }, { writeScope: ["scripts/agent-queue.js"] }), true);
  assert.equal(policy.scopesConflict({ writeScope: ["docs"] }, { writeScope: ["scripts"] }), false);
  assert.equal(policy.scopesConflict({ title: "Implement broad change" }, { writeScope: ["scripts"] }), true);
  assert.equal(policy.scopesConflict({ title: "Read-only review" }, { writeScope: ["scripts"] }), false);
});

test("write scopes conflict for sibling files inside the same monitor boundary", () => {
  assert.equal(policy.scopesConflict(
    { writeScope: ["scripts/a.js"], canWrite: true },
    { writeScope: ["scripts/b.js"], canWrite: true }
  ), true);
  assert.equal(policy.scopesConflict(
    { writeScope: ["scripts/a.js"], canWrite: true },
    { writeScope: ["docs/a.js"], canWrite: true }
  ), false);
});
