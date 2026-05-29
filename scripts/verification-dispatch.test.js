#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const test = require("node:test");

const dispatch = require("./verification-dispatch.js");
const queueCli = path.join(__dirname, "agent-queue.js");
const dispatchCli = path.join(__dirname, "verification-dispatch.js");
const packageJson = require("../package.json");

function runJson(script, args, env) {
  const output = execFileSync(process.execPath, [script, ...args], {
    env: { ...process.env, ...env },
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  return JSON.parse(output);
}

function runQueue(args, env) {
  return runJson(queueCli, args, env);
}

test("plans reviewer tasks for ready_for_verification items without mutating in dry-run", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-verify-"));
  const queueFile = path.join(tempDir, "agent-queue.json");
  const env = { CONNECT_AI_AGENT_QUEUE: queueFile };

  const task = runQueue([
    "add",
    "--assignee", "codex",
    "--priority", "P1",
    "--title", "Implement verified feature",
    "--prompt", "Modify scripts/example.js and run tests.",
    "--file", "scripts/example.js",
  ], env).item;
  runQueue([
    "update",
    "--id", task.id,
    "--status", "done",
    "--result-summary", "READY_FOR_VERIFICATION: Files changed: scripts/example.js. Commands run: node --test scripts/example.test.js. Current-run expected tests/evidence: tests claimed. Unresolved failures: none.",
  ], env);

  const dry = runJson(dispatchCli, [], env);
  assert.equal(dry.mode, "dry-run");
  assert.equal(dry.readyForVerificationCount, 1);
  assert.equal(dry.plannedCount, 1);
  assert.equal(dry.plans[0].sourceId, task.id);

  const queue = runQueue(["list"], env).items;
  assert.equal(queue.length, 1);
  assert.equal(queue[0].status, "ready_for_verification");
});

test("execute enqueues a read-only reviewer task and avoids duplicates", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-verify-"));
  const queueFile = path.join(tempDir, "agent-queue.json");
  const env = { CONNECT_AI_AGENT_QUEUE: queueFile };

  const task = runQueue([
    "add",
    "--assignee", "claude",
    "--priority", "P0",
    "--title", "Implement transport repair",
    "--prompt", "Modify transport code.",
    "--file", "src/extension.ts",
  ], env).item;
  runQueue([
    "update",
    "--id", task.id,
    "--status", "done",
    "--result-summary", "READY_FOR_VERIFICATION: Files changed: src/extension.ts. Commands run: npm run compile. Current-run expected tests/evidence: compile passed. Unresolved failures: none.",
  ], env);

  const first = runJson(dispatchCli, ["--execute", "--reviewer", "antigravity"], env);
  assert.equal(first.mode, "execute");
  assert.equal(first.enqueued.length, 1);
  assert.equal(first.enqueued[0].assignee, "antigravity");

  const second = runJson(dispatchCli, ["--execute", "--reviewer", "antigravity"], env);
  assert.equal(second.plannedCount, 0);
  assert.equal(second.enqueued.length, 0);

  const queue = runQueue(["list"], env).items;
  const reviewer = queue.find((item) => item.assignee === "antigravity");
  assert.ok(reviewer);
  assert.match(reviewer.prompt, new RegExp(dispatch.markerFor(task.id).replace(/[[\]]/g, "\\$&")));
  assert.match(reviewer.prompt, /read-only verifier/i);
  assert.equal(reviewer.role, "verifier");
  assert.match(reviewer.stopCondition, /one read-only verdict/i);
  assert.match(reviewer.approvalCondition, /before any write/i);
  assert.deepEqual(reviewer.evidenceRequired, [
    "검증 판정: accept|reject|needs_human",
    "근거",
    "누락 증거",
  ]);
  assert.equal(reviewer.workerClass, "reviewer");
  assert.equal(reviewer.canWrite, false);
  assert.equal(reviewer.riskClass, "Green");
  assert.equal(reviewer.executor, "none");
  assert.equal(reviewer.reviewer, "antigravity");
  assert.equal(reviewer.intent, "verification");
  assert.equal(reviewer.tokenBudget, "medium");
  assert.equal(reviewer.retryBudget, 0);
  assert.equal(reviewer.agentOsStatus, "QUEUED");
  assert.deepEqual(reviewer.writeScope, ["read-only"]);
  assert.ok(reviewer.forbiddenPaths.includes("C:\\Users\\mjb58\\connect-ai-vault"));
  assert.ok(reviewer.forbiddenPaths.includes("transport-audit"));
  assert.ok(reviewer.forbiddenPaths.includes("swarm-status"));
  assert.ok(reviewer.forbiddenPaths.includes("readiness"));
  assert.deepEqual(reviewer.expectedTests, ["reviewer returns explicit 검증 판정: accept|reject|needs_human"]);
  assert.equal(reviewer.rollbackPath, "delete verifier queue item before execution");
});

test("dispatch retries one blocked verifier without verdict then circuit-breaks", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-verify-"));
  const queueFile = path.join(tempDir, "agent-queue.json");
  const env = { CONNECT_AI_AGENT_QUEUE: queueFile };

  const task = runQueue([
    "add",
    "--assignee", "codex",
    "--priority", "P1",
    "--title", "Implement verifier retry guard",
    "--prompt", "Modify scripts/verification-dispatch.js and run tests.",
    "--file", "scripts/verification-dispatch.js",
  ], env).item;
  runQueue([
    "update",
    "--id", task.id,
    "--status", "done",
    "--result-summary", "READY_FOR_VERIFICATION: Files changed: scripts/verification-dispatch.js. Commands run: node --test scripts/verification-dispatch.test.js. Current-run expected tests/evidence: tests claimed. Unresolved failures: none.",
  ], env);

  const first = runJson(dispatchCli, ["--execute", "--reviewer", "gemini"], env);
  assert.equal(first.enqueued.length, 1);
  runQueue([
    "update",
    "--id", first.enqueued[0].id,
    "--status", "blocked",
    "--result-summary", "BLOCKED: verifier output missing explicit verifier verdict.",
  ], env);

  const retry = runJson(dispatchCli, ["--execute", "--reviewer", "antigravity"], env);
  assert.equal(retry.plannedCount, 1);
  assert.equal(retry.enqueued.length, 1);
  assert.equal(retry.enqueued[0].assignee, "antigravity");
  runQueue([
    "update",
    "--id", retry.enqueued[0].id,
    "--status", "blocked",
    "--result-summary", "BLOCKED: verifier output missing explicit verifier verdict.",
  ], env);

  const circuitBroken = runJson(dispatchCli, ["--execute", "--reviewer", "gemini"], env);
  assert.equal(circuitBroken.plannedCount, 0);
  assert.equal(circuitBroken.enqueued.length, 0);
});

test("can plan legacy done tasks without verifier only when explicitly requested", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-verify-"));
  const queueFile = path.join(tempDir, "agent-queue.json");
  const env = { CONNECT_AI_AGENT_QUEUE: queueFile };

  const task = runQueue([
    "add",
    "--assignee", "codex",
    "--priority", "P1",
    "--title", "Legacy unverified completion",
    "--prompt", "Modify scripts/example.js and run tests.",
    "--file", "scripts/example.js",
  ], env).item;

  const queue = JSON.parse(fs.readFileSync(queueFile, "utf8"));
  queue[0] = {
    ...queue[0],
    status: "done",
    agentOsStatus: "DONE",
    resultSummary: "Legacy worker claimed success before verifier gate existed.",
    completedAt: queue[0].updatedAt,
  };
  fs.writeFileSync(queueFile, `${JSON.stringify(queue, null, 2)}\n`, "utf8");

  const defaultDry = runJson(dispatchCli, [], env);
  assert.equal(defaultDry.plannedCount, 0);

  const legacyDry = runJson(dispatchCli, ["--include-unverified-done"], env);
  assert.equal(legacyDry.plannedCount, 1);
  assert.equal(legacyDry.plans[0].sourceId, task.id);
  assert.equal(legacyDry.plans[0].sourceStatus, "done");

  const after = runQueue(["list"], env).items;
  assert.equal(after.length, 1);
  assert.equal(after[0].status, "done");
});

test("package exposes capped dry-run legacy verifier dispatch command", () => {
  const script = packageJson.scripts["agent:verify-dispatch:legacy"];
  assert.ok(script);
  assert.match(script, /verification-dispatch\.js/);
  assert.match(script, /--include-unverified-done/);
  assert.match(script, /--max 3/);
  assert.doesNotMatch(script, /--execute/);
});

test("apply can verify accepted legacy done source tasks", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-verify-"));
  const queueFile = path.join(tempDir, "agent-queue.json");
  const env = { CONNECT_AI_AGENT_QUEUE: queueFile };

  const task = runQueue([
    "add",
    "--assignee", "codex",
    "--priority", "P1",
    "--title", "Legacy accepted completion",
    "--prompt", "Modify scripts/example.js and run tests.",
    "--file", "scripts/example.js",
  ], env).item;

  const queue = JSON.parse(fs.readFileSync(queueFile, "utf8"));
  queue[0] = {
    ...queue[0],
    status: "done",
    agentOsStatus: "DONE",
    resultSummary: "Legacy worker claimed success before verifier gate existed.",
    completedAt: queue[0].updatedAt,
  };
  fs.writeFileSync(queueFile, `${JSON.stringify(queue, null, 2)}\n`, "utf8");

  const dispatchResult = runJson(dispatchCli, ["--execute", "--include-unverified-done", "--reviewer", "gemini"], env);
  const verifier = dispatchResult.enqueued[0];
  runQueue([
    "update",
    "--id", verifier.id,
    "--status", "done",
    "--result-summary", "검증 판정: accept\n근거: legacy source evidence was manually checked.\n누락 증거: 없음.",
    "--verified",
  ], env);

  const applied = runJson(dispatchCli, ["--apply", "--execute"], env);
  assert.equal(applied.applied.length, 1);
  assert.equal(applied.applied[0].status, "done");
  assert.ok(applied.applied[0].verifiedAt);

  const source = runQueue(["get", "--id", task.id], env).item;
  assert.equal(source.status, "done");
  assert.match(source.resultSummary, /VERIFIER_ACCEPT/);
  const rawSource = JSON.parse(fs.readFileSync(queueFile, "utf8")).find((item) => item.id === task.id);
  assert.ok(rawSource.verifiedAt);
});

test("apply closes accepted source task only after reviewer evidence", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-verify-"));
  const queueFile = path.join(tempDir, "agent-queue.json");
  const env = { CONNECT_AI_AGENT_QUEUE: queueFile };

  const task = runQueue([
    "add",
    "--assignee", "codex",
    "--priority", "P1",
    "--title", "Implement single writer smoke",
    "--prompt", "Modify scripts/vault-writer.js and run tests.",
    "--file", "scripts/vault-writer.js",
  ], env).item;
  runQueue([
    "update",
    "--id", task.id,
    "--status", "done",
    "--result-summary", "Files changed: scripts/vault-writer.js. Commands run: node --test scripts/vault-writer.test.js. Tests passed. Unresolved failures: none.",
  ], env);

  const beforeEvidence = runJson(dispatchCli, ["--apply"], env);
  assert.equal(beforeEvidence.plannedCount, 0);

  const dispatchResult = runJson(dispatchCli, ["--execute", "--reviewer", "gemini"], env);
  const verifier = dispatchResult.enqueued[0];
  runQueue([
    "update",
    "--id", verifier.id,
    "--status", "done",
    "--result-summary", "검증 판정: accept\n근거: 현재 테스트 출력과 파일 범위가 일치합니다.\n누락 증거: 없음.",
    "--verified",
  ], env);

  const dryApply = runJson(dispatchCli, ["--apply"], env);
  assert.equal(dryApply.mode, "apply-dry-run");
  assert.equal(dryApply.plannedCount, 1);
  assert.equal(dryApply.plans[0].sourceId, task.id);
  assert.equal(dryApply.plans[0].verdict, "accept");
  assert.equal(dryApply.plans[0].targetStatus, "done");

  const applied = runJson(dispatchCli, ["--apply", "--execute"], env);
  assert.equal(applied.mode, "apply-execute");
  assert.equal(applied.applied.length, 1);
  assert.equal(applied.applied[0].status, "done");
  assert.ok(applied.applied[0].verifiedAt);

  const source = runQueue(["get", "--id", task.id], env).item;
  assert.equal(source.status, "done");
  assert.match(source.resultSummary, /VERIFIER_ACCEPT/);
});

test("apply blocks rejected source task with verifier evidence", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-verify-"));
  const queueFile = path.join(tempDir, "agent-queue.json");
  const env = { CONNECT_AI_AGENT_QUEUE: queueFile };

  const task = runQueue([
    "add",
    "--assignee", "claude",
    "--priority", "P1",
    "--title", "Implement risky write",
    "--prompt", "Modify src/extension.ts.",
    "--file", "src/extension.ts",
  ], env).item;
  runQueue([
    "update",
    "--id", task.id,
    "--status", "done",
    "--result-summary", "Files changed: src/extension.ts. Commands run: npm run compile. Current-run expected tests/evidence: claimed compile evidence. Unresolved failures: none.",
  ], env);
  const dispatchResult = runJson(dispatchCli, ["--execute", "--reviewer", "antigravity"], env);
  const verifier = dispatchResult.enqueued[0];
  runQueue([
    "update",
    "--id", verifier.id,
    "--status", "done",
    "--result-summary", "검증 판정: reject\n근거: required tests are missing.\n누락 증거: required current-run test output.",
    "--verified",
  ], env);

  const applied = runJson(dispatchCli, ["--apply", "--execute"], env);
  assert.equal(applied.applied[0].status, "blocked");
  const source = runQueue(["get", "--id", task.id], env).item;
  assert.equal(source.status, "blocked");
  assert.match(source.resultSummary, /VERIFIER_REJECT/);
});

test("apply ignores verifier verdict evidence that was not itself verified", () => {
  const source = {
    id: "aq-source-unverified-verdict",
    status: "ready_for_verification",
    assignee: "codex",
    title: "Implement guarded queue close",
    priority: "P1",
    resultSummary: "READY_FOR_VERIFICATION: source evidence present.",
  };
  const unverifiedVerifier = {
    id: "aq-verifier-raw-done",
    status: "done",
    assignee: "gemini",
    role: "verifier",
    prompt: dispatch.markerFor(source.id),
    resultSummary: "검증 판정: accept\n근거: raw verdict text exists.\n누락 증거: 없음.",
    updatedAt: "2026-05-28T00:00:00.000Z",
  };

  assert.deepEqual(dispatch.verificationEvidence([source, unverifiedVerifier]), []);
  assert.deepEqual(dispatch.plannedClosures([source, unverifiedVerifier]), []);
  const retryPlans = dispatch.plannedDispatches([source, unverifiedVerifier]);
  assert.equal(retryPlans.length, 1);
  assert.equal(retryPlans[0].sourceId, source.id);
});

test("apply ignores verified reviewer verdicts that are not verifier tasks", () => {
  const source = {
    id: "aq-source-reviewer-verdict",
    status: "ready_for_verification",
    assignee: "codex",
    title: "Implement verifier lineage guard",
    priority: "P1",
    resultSummary: "READY_FOR_VERIFICATION: source evidence present.",
  };
  const normalReviewer = {
    id: "aq-reviewer-not-verifier",
    status: "done",
    assignee: "gemini",
    role: "reviewer",
    intent: "architecture-review",
    prompt: dispatch.markerFor(source.id),
    resultSummary: "검증 판정: accept\n근거: this was only a normal review task.\n누락 증거: 없음.",
    verifiedAt: "2026-05-28T00:00:00.000Z",
    updatedAt: "2026-05-28T00:00:00.000Z",
  };

  assert.deepEqual(dispatch.verificationEvidence([source, normalReviewer]), []);
  assert.deepEqual(dispatch.plannedClosures([source, normalReviewer]), []);
  const retryPlans = dispatch.plannedDispatches([source, normalReviewer]);
  assert.equal(retryPlans.length, 1);
  assert.equal(retryPlans[0].sourceId, source.id);
});

test("apply ignores stale verifier verdicts older than the source update", () => {
  const source = {
    id: "aq-source-newer-than-verifier",
    status: "ready_for_verification",
    assignee: "codex",
    title: "Implement stale verifier guard",
    priority: "P1",
    resultSummary: "READY_FOR_VERIFICATION: source was updated after verifier ran.",
    updatedAt: "2026-05-28T01:00:00.000Z",
  };
  const staleVerifier = {
    id: "aq-verifier-stale",
    status: "done",
    assignee: "gemini",
    role: "verifier",
    intent: "verification",
    prompt: dispatch.markerFor(source.id),
    resultSummary: "검증 판정: accept\n근거: this verdict predates the source update.\n누락 증거: 없음.",
    verifiedAt: "2026-05-28T00:30:00.000Z",
    updatedAt: "2026-05-28T00:30:00.000Z",
  };

  assert.deepEqual(dispatch.plannedClosures([source, staleVerifier]), []);
  const retryPlans = dispatch.plannedDispatches([source, staleVerifier]);
  assert.equal(retryPlans.length, 1);
  assert.equal(retryPlans[0].sourceId, source.id);
});

test("apply ignores verifier verdicts missing required evidence labels", () => {
  const source = {
    id: "aq-source-incomplete-verifier",
    status: "ready_for_verification",
    assignee: "codex",
    title: "Implement verifier evidence label guard",
    priority: "P1",
    resultSummary: "READY_FOR_VERIFICATION: source evidence present.",
    updatedAt: "2026-05-28T01:00:00.000Z",
  };
  const incompleteVerifier = {
    id: "aq-verifier-incomplete",
    status: "done",
    assignee: "gemini",
    role: "verifier",
    intent: "verification",
    prompt: dispatch.markerFor(source.id),
    resultSummary: "검증 판정: accept\n근거: verdict exists but missing-evidence section is absent.",
    verifiedAt: "2026-05-28T01:05:00.000Z",
    updatedAt: "2026-05-28T01:05:00.000Z",
  };

  assert.deepEqual(dispatch.verificationEvidence([source, incompleteVerifier]), []);
  assert.deepEqual(dispatch.plannedClosures([source, incompleteVerifier]), []);
  const retryPlans = dispatch.plannedDispatches([source, incompleteVerifier]);
  assert.equal(retryPlans.length, 1);
  assert.equal(retryPlans[0].sourceId, source.id);
});

test("apply ignores verifier verdicts with empty required evidence sections", () => {
  const source = {
    id: "aq-source-empty-verifier-sections",
    status: "ready_for_verification",
    assignee: "codex",
    title: "Implement verifier evidence content guard",
    priority: "P1",
    resultSummary: "READY_FOR_VERIFICATION: source evidence present.",
    updatedAt: "2026-05-28T01:00:00.000Z",
  };
  const emptySectionVerifier = {
    id: "aq-verifier-empty-sections",
    status: "done",
    assignee: "gemini",
    role: "verifier",
    intent: "verification",
    prompt: dispatch.markerFor(source.id),
    resultSummary: "검증 판정: accept\n근거:\n누락 증거:\n권장 다음 조치: none.",
    verifiedAt: "2026-05-28T01:05:00.000Z",
    updatedAt: "2026-05-28T01:05:00.000Z",
  };

  assert.deepEqual(dispatch.verificationEvidence([source, emptySectionVerifier]), []);
  assert.deepEqual(dispatch.plannedClosures([source, emptySectionVerifier]), []);
  const retryPlans = dispatch.plannedDispatches([source, emptySectionVerifier]);
  assert.equal(retryPlans.length, 1);
  assert.equal(retryPlans[0].sourceId, source.id);
});

test("dispatch circuit breaker counts only blocked verifiers without parseable verdict evidence", () => {
  const source = {
    id: "aq-source-mixed-blocked-verifiers",
    status: "ready_for_verification",
    assignee: "codex",
    title: "Implement verifier retry after parser fix",
    priority: "P2",
    updatedAt: "2026-05-28T03:00:00.000Z",
  };
  const parseableBlockedVerifier = {
    id: "aq-parseable-blocked-verifier",
    status: "blocked",
    assignee: "gemini",
    role: "verifier",
    intent: "verification",
    prompt: dispatch.markerFor(source.id),
    resultSummary: [
      "BLOCKED: verifier output missing explicit verifier verdict. Output: 1. 검증결과: needs_human",
      "2. 증거: 외부 파일 접근이 필요합니다.",
      "3. 잔여 위험: 사람이 확인해야 합니다.",
    ].join("\n"),
    updatedAt: "2026-05-28T03:10:00.000Z",
  };
  const missingVerdictBlockedVerifier = {
    id: "aq-missing-verdict-blocked-verifier",
    status: "blocked",
    assignee: "gemini",
    role: "verifier",
    intent: "verification",
    prompt: dispatch.markerFor(source.id),
    resultSummary: "BLOCKED: verifier output missing explicit verifier verdict. Output: ???????: accept\n???: unreadable",
    updatedAt: "2026-05-28T03:20:00.000Z",
  };

  const state = dispatch.verifierDispatchState([source, parseableBlockedVerifier, missingVerdictBlockedVerifier], source);
  assert.equal(state.skip, false);
  assert.equal(state.blockedWithoutVerdict, 1);
});

test("verification prompt includes evidence boundaries", () => {
  const prompt = dispatch.buildVerificationPrompt({
    id: "aq-test",
    assignee: "codex",
    title: "Implement parser",
    priority: "P1",
    files: ["src/extension.ts"],
    resultSummary: "Files changed. npm run compile passed.",
  });
  assert.match(prompt, /Do not edit/);
  assert.match(prompt, /accept \/ reject \/ needs_human/);
  assert.match(prompt, /src\/extension\.ts/);
});

test("verification prompt includes source queue contract fields", () => {
  const prompt = dispatch.buildVerificationPrompt({
    id: "aq-contract",
    assignee: "codex",
    title: "Implement guarded writer",
    priority: "P1",
    status: "ready_for_verification",
    riskClass: "Amber",
    executor: "codex",
    reviewer: "gemini",
    writeScope: ["scripts/vault-writer.js"],
    expectedTests: ["node --test scripts/vault-writer.test.js"],
    rollbackPath: "revert scripts/vault-writer.js",
    files: ["scripts/vault-writer.js"],
    resultSummary: "READY_FOR_VERIFICATION: evidence present.",
  });
  assert.match(prompt, /riskClass: Amber/);
  assert.match(prompt, /executor: codex/);
  assert.match(prompt, /reviewer: gemini/);
  assert.match(prompt, /writeScope:/);
  assert.match(prompt, /scripts\/vault-writer\.js/);
  assert.match(prompt, /expectedTests:/);
  assert.match(prompt, /node --test scripts\/vault-writer\.test\.js/);
  assert.match(prompt, /rollbackPath: revert scripts\/vault-writer\.js/);
});

test("verification prompt embeds bounded snippets from approved evidence roots", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-verifier-evidence-"));
  const targetFile = path.join(tempDir, "hello-world-target.js");
  const evidenceLog = path.join(tempDir, "queue-dispatch-log.json");
  fs.writeFileSync(targetFile, "// hello world\nconsole.log('ok');\n", "utf8");
  fs.writeFileSync(evidenceLog, JSON.stringify({ status: "READY_FOR_VERIFICATION", evidence: "dispatch ok" }, null, 2), "utf8");

  const prompt = dispatch.buildVerificationPrompt({
    id: "aq-evidence-pack",
    assignee: "codex",
    title: "Implement evidence pack",
    priority: "P1",
    status: "ready_for_verification",
    files: [targetFile],
    resultSummary: `READY_FOR_VERIFICATION: Evidence log: ${evidenceLog}`,
  }, { evidenceRoots: [tempDir], maxEvidenceBytes: 200 });

  assert.match(prompt, /Verifier evidence pack/);
  assert.match(prompt, /hello world/);
  assert.match(prompt, /dispatch ok/);
  assert.match(prompt, /Use these exact heading labels/);
});

test("verdict parser requires explicit reviewer verdict", () => {
  assert.equal(dispatch.verdictFromSummary("검증 판정: accept\n근거 있음"), "accept");
  assert.equal(dispatch.verdictFromSummary("### 검증 판정: reject\n근거 있음"), "reject");
  assert.equal(dispatch.verdictFromSummary("verdict: reject\nmissing tests"), "reject");
  assert.equal(dispatch.verdictFromSummary("검증 판정: needs_human\n승인 필요"), "needs_human");
  assert.equal(dispatch.verdictFromSummary("accept / reject / needs_human are options"), "");
  assert.equal(dispatch.verdictFromSummary("검증 판정: accept / reject / needs_human\n근거: template left unchanged."), "");
  assert.equal(dispatch.verdictFromSummary("검증 판정: accepted\n근거: loose synonym should not close verifier gate."), "");
});

test("verdict parser accepts exact token on next line after option heading", () => {
  const summary = [
    "### 검증 판정: accept|reject|needs_human",
    "reject",
    "",
    "### 근거:",
    "실제 증거를 확인했고 요구사항이 충족되지 않았습니다.",
    "",
    "### 누락 증거:",
    "분류 결과가 없습니다.",
  ].join("\n");

  assert.equal(dispatch.verdictFromSummary(summary), "reject");
  assert.equal(dispatch.hasVerifierRequiredEvidence({ resultSummary: summary }), true);
});

test("verdict parser accepts markdown-emphasized exact token after option heading", () => {
  const summary = [
    "### 검증 판정: accept|reject|needs_human",
    "**accept**",
    "",
    "### 근거:",
    "현재 evidence pack과 테스트 요약을 확인했습니다.",
    "",
    "### 누락 증거:",
    "없음.",
  ].join("\n");

  assert.equal(dispatch.verdictFromSummary(summary), "accept");
  assert.equal(dispatch.hasVerifierRequiredEvidence({ resultSummary: summary }), true);
});

test("verdict parser accepts wrapped worker output with numbered verdict label", () => {
  const summary = [
    "BLOCKED: verifier output missing explicit verifier verdict. Output: 1. 검증결과: needs_human",
    "2. 증거: 대상 파일을 읽을 수 없어 검증할 수 없습니다.",
    "3. 잔여 위험: 요구사항 미충족 상태에서 승인될 위험이 있습니다.",
    "4. 다음 안전한 조치: 파일 접근 권한이 있는 환경에서 재검증합니다.",
  ].join("\n");

  assert.equal(dispatch.verdictFromSummary(summary), "needs_human");
  assert.equal(dispatch.hasVerifierRequiredEvidence({ resultSummary: summary }), true);
});

test("verifier parser accepts Korean result label variants but still requires exact verdict tokens", () => {
  const summary = [
    "심사결과: accept",
    "근거: 대상 파일에 요구된 주석이 있습니다.",
    "잔여 위험 평가: 없음.",
    "다음 권장 안전 조치: source task를 verifier evidence로 닫습니다.",
  ].join("\n");

  assert.equal(dispatch.verdictFromSummary(summary), "accept");
  assert.equal(dispatch.hasVerifierRequiredEvidence({ resultSummary: summary }), true);
  const reversedResultLabel = "판정결과: accept\n증거: 로그와 대상 파일 확인.\n잔여 위험: 없음.";
  assert.equal(dispatch.verdictFromSummary(reversedResultLabel), "accept");
  assert.equal(dispatch.hasVerifierRequiredEvidence({ resultSummary: reversedResultLabel }), true);
  const classifiedResultLabel = "결과분류: accept\n증거: 로그와 대상 파일 확인.\n잔여 위험: 없음.";
  assert.equal(dispatch.verdictFromSummary(classifiedResultLabel), "accept");
  assert.equal(dispatch.hasVerifierRequiredEvidence({ resultSummary: classifiedResultLabel }), true);
  assert.equal(dispatch.verdictFromSummary("심사결과: accepted\n근거: loose synonym"), "");
});
