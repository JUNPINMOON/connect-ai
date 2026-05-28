const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const executor = require("./gemini-executor.js");

test("rejects unsupported models", () => {
  const result = executor.runGeminiExecutor({ model: "gemini-3.5-flash", prompt: "Connect AI" });
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.reason, "UNSUPPORTED_MODEL");
  assert.deepEqual(result.unresolvedFailures, ["UNSUPPORTED_MODEL"]);
});

test("rejects stale Gemini 3.1 id outside the stable allowlist", () => {
  const result = executor.runGeminiExecutor({ model: "gemini-3.1-pro-preview", prompt: "Connect AI" });
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.reason, "UNSUPPORTED_MODEL");
});

test("rejects unstable Gemini 3 preview id outside the stable allowlist", () => {
  const result = executor.runGeminiExecutor({ model: "gemini-3-pro-preview", prompt: "" });
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.reason, "UNSUPPORTED_MODEL");
  assert.equal(executor.SUPPORTED_MODELS.has("gemini-3-pro-preview"), false);
});

test("rejects direct vault writes", () => {
  const result = executor.runGeminiExecutor({
    model: "gemini-2.5-flash",
    prompt: "Connect AI",
    writePath: "C:\\Users\\mjb58\\connect-ai-vault\\notes\\x.md",
  });
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.reason, "VAULT_WRITE_FORBIDDEN");
});

test("rejects evidence paths outside approved runtime/report roots", () => {
  const result = executor.runGeminiExecutor({
    model: "gemini-2.5-flash",
    prompt: "Connect AI",
    evidenceDir: "C:\\Users\\mjb58\\Desktop",
  });
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.reason, "EVIDENCE_PATH_FORBIDDEN");
});

test("accepts approved evidence roots", () => {
  assert.equal(executor.isApprovedEvidencePath("C:\\Users\\mjb58\\connect-ai-runtime\\company\\s5-dispatch\\probe.json"), true);
  assert.equal(executor.isApprovedEvidencePath("C:\\Users\\mjb58\\antigravity-projects\\connect-ai\\reports\\deep-debug-swarm\\probe.json"), true);
});

test("infers observed model from the executed Gemini CLI command", () => {
  const observed = executor.inferObservedModelFromCommand([
    "gemini --skip-trust --model gemini-3-pro-preview --prompt x",
  ], "gemini-2.5-flash");
  assert.equal(observed, "gemini-3-pro-preview");
});

test("classifies Gemini CLI quota exhaustion from stderr", () => {
  const failure = executor.classifyGeminiCliFailure("TerminalQuotaError: You have exhausted your capacity on this model. reason: 'QUOTA_EXHAUSTED'");
  assert.equal(failure, "QUOTA_EXHAUSTED");
});

test("extracts observed model from Gemini CLI session evidence", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-gemini-chat-"));
  const transcript = path.join(root, "session-test.jsonl");
  fs.writeFileSync(transcript, [
    JSON.stringify({ sessionId: "test" }),
    JSON.stringify({ type: "user", content: [{ text: "MARKER_A hello" }] }),
    JSON.stringify({ type: "gemini", content: "ok", model: "gemini-2.5-pro" }),
  ].join("\n"), "utf8");

  const observed = executor.latestGeminiCliObservedModel(root, Date.now() - 1000, "MARKER_A");
  assert.equal(observed.model, "gemini-2.5-pro");
  assert.equal(observed.transcript, transcript);
});

test("does not reuse a stale Gemini session when marker is absent", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-gemini-stale-"));
  const transcript = path.join(root, "session-test.jsonl");
  fs.writeFileSync(transcript, [
    JSON.stringify({ type: "user", content: [{ text: "OLD_MARKER" }] }),
    JSON.stringify({ type: "gemini", content: "ok", model: "gemini-2.5-pro" }),
  ].join("\n"), "utf8");

  const observed = executor.latestGeminiCliObservedModel(root, Date.now() - 1000, "NEW_MARKER");
  assert.equal(observed.model, "");
  assert.equal(observed.transcript, "");
});

test("returns ready only when observed model from session evidence matches requested model", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-gemini-run-"));
  const transcript = path.join(root, "session-test.jsonl");
  fs.writeFileSync(transcript, [
    JSON.stringify({ sessionId: "test" }),
    JSON.stringify({ type: "user", content: [{ text: "RUN_MARKER" }] }),
    JSON.stringify({ type: "gemini", content: "review body", model: "gemini-2.5-pro" }),
  ].join("\n"), "utf8");

  const result = executor.runGeminiExecutor({
    model: "gemini-2.5-pro",
    prompt: "Connect AI",
    chatRoot: root,
    sinceMs: Date.now() - 1000,
    marker: "RUN_MARKER",
    argv: ["--no-evidence"],
    spawnSync: () => ({ status: 0, stdout: "review body", stderr: "" }),
  });

  assert.equal(result.status, "READY_FOR_VERIFICATION");
  assert.equal(result.observedModel, "gemini-2.5-pro");
  assert.deepEqual(result.unresolvedFailures, []);
});

test("blocks model mismatch when CLI observes a different concrete model", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-gemini-alias-drift-"));
  const transcript = path.join(root, "session-test.jsonl");
  fs.writeFileSync(transcript, [
    JSON.stringify({ type: "user", content: [{ text: "ALIAS_MARKER" }] }),
    JSON.stringify({ type: "gemini", content: "review body", model: "gemini-2.5-flash" }),
  ].join("\n"), "utf8");

  const result = executor.runGeminiExecutor({
    model: "gemini-2.5-pro",
    prompt: "Connect AI",
    chatRoot: root,
    sinceMs: Date.now() - 1000,
    marker: "ALIAS_MARKER",
    argv: ["--no-evidence"],
    spawnSync: () => ({ status: 0, stdout: "review body", stderr: "" }),
  });

  assert.equal(result.status, "BLOCKED");
  assert.equal(result.reason, "MODEL_MISMATCH");
  assert.equal(result.requestedModel, "gemini-2.5-pro");
  assert.equal(result.observedModel, "gemini-2.5-flash");
  assert.deepEqual(result.unresolvedFailures, ["MODEL_MISMATCH"]);
});

test("blocks when observed model evidence is missing", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-gemini-missing-"));
  const result = executor.runGeminiExecutor({
    model: "gemini-2.5-flash",
    prompt: "Connect AI",
    chatRoot: root,
    sinceMs: Date.now() - 1000,
    argv: ["--no-evidence"],
    spawnSync: () => ({ status: 0, stdout: "review body", stderr: "" }),
  });

  assert.equal(result.status, "BLOCKED");
  assert.equal(result.reason, "MISSING_OBSERVED_MODEL");
  assert.ok(result.unresolvedFailures.includes("MISSING_OBSERVED_MODEL"));
  assert.equal(result.unresolvedFailures.includes("MODEL_MISMATCH"), false);
});
