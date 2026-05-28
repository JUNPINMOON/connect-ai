#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const worker = require("./google-reviewer-worker.js");
const dispatch = require("./verification-dispatch.js");

test("google reviewer only accepts explicit read-only or review tasks", () => {
  assert.equal(worker.isReadOnlyTask({ title: "주식 Green: 운영 리스크 평가", prompt: "Read-only inspection only." }), true);
  assert.equal(worker.isReadOnlyTask({ title: "Implement router", prompt: "Edit files and implement." }), false);
});

test("google reviewer prompt includes approval and protected-path boundaries", () => {
  const prompt = worker.buildPrompt({
    id: "aq-test",
    title: "Read-only audit",
    priority: "P1",
    files: ["C:\\example"],
    prompt: "Audit only.",
  });
  assert.match(prompt, /read-only/i);
  assert.match(prompt, /Do not claim user approval/);
  assert.match(prompt, /broker\/live\/order\/token\/balance\/harness\/baseline\/protected-path/);
});

test("verifier prompt rebuilds from current source task evidence", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-google-reviewer-evidence-"));
  const targetFile = path.join(tempDir, "target.js");
  fs.writeFileSync(targetFile, "// hello world\n", "utf8");

  const prompt = worker.buildPrompt(
    {
      id: "aq-verifier",
      title: "Verification request: old prompt",
      priority: "P2",
      role: "verifier",
      intent: "verification",
      prompt: `${dispatch.markerFor("aq-source")}\nold verifier prompt without evidence pack`,
    },
    {
      id: "aq-source",
      assignee: "codex",
      title: "Source task",
      priority: "P2",
      status: "ready_for_verification",
      files: [targetFile],
      resultSummary: "READY_FOR_VERIFICATION: source evidence present.",
    },
    { evidenceRoots: [tempDir], maxEvidenceBytes: 200 }
  );

  assert.match(prompt, /Task prompt:/);
  assert.match(prompt, /Source task id: aq-source/);
  assert.match(prompt, /Verifier evidence pack/);
  assert.match(prompt, /hello world/);
  assert.match(prompt, /Use these exact heading labels/);
});

test("parses antigravity reviewer JSON output", () => {
  const parsed = worker.parseAntigravityOutput(JSON.stringify({ success: true, response: "OK" }));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.text, "OK");
});

test("source uses Gemini skip-trust for headless automation", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(path.join(__dirname, "google-reviewer-worker.js"), "utf8");
  assert.match(source, /"--skip-trust"/);
  assert.match(source, /"--approval-mode", "plan"/);
  assert.match(source, /"--output-format", "json"/);
  assert.match(source, /GEMINI_WORKER_PROMPT_FILE/);
  assert.match(source, /\$OutputEncoding\s*=/);
  assert.match(source, /Get-Content -Raw -Encoding UTF8/);
});

test("google reviewer reports queue-enforced status instead of local desired status", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(path.join(__dirname, "google-reviewer-worker.js"), "utf8");
  assert.match(source, /const finalized = finalizeReviewerResult\(task, result, assignee\)/);
  assert.match(source, /const updated = updateTask\(task, status, summary\)/);
  assert.match(source, /const queueStatus = updated\.item\?\.status \|\| status/);
  assert.match(source, /status: queueStatus/);
});

test("verifier tasks with explicit verdict are updated with verified flag", () => {
  const args = worker.updateArgsForTask(
    { id: "aq-verifier", role: "verifier", intent: "verification" },
    "done",
    "검증 판정: accept\n근거: evidence checked.\n누락 증거: 없음."
  );
  assert.deepEqual(args.slice(0, 6), ["update", "--id", "aq-verifier", "--status", "done", "--result-summary"]);
  assert.equal(args.includes("--verified"), true);
});

test("verifier tasks with empty evidence sections are not updated with verified flag", () => {
  const args = worker.updateArgsForTask(
    { id: "aq-verifier-empty", role: "verifier", intent: "verification" },
    "done",
    "검증 판정: accept\n근거:\n누락 증거:\n권장 다음 조치: none."
  );
  assert.equal(args.includes("--verified"), false);
});

test("ordinary reviewer tasks do not self-verify", () => {
  const args = worker.updateArgsForTask(
    { id: "aq-review", role: "reviewer", intent: "queue-dispatch-gemini" },
    "done",
    "검증 판정: accept\n근거: evidence checked.\n누락 증거: 없음."
  );
  assert.equal(args.includes("--verified"), false);
});

test("verifier output without explicit verdict is blocked", () => {
  const finalized = worker.finalizeReviewerResult(
    { id: "aq-verifier", role: "verifier", intent: "verification" },
    { ok: true, exitCode: 0, text: "Looks reasonable, but no verdict line." },
    "gemini"
  );
  assert.equal(finalized.status, "blocked");
  assert.match(finalized.summary, /missing explicit verifier verdict/i);
});

test("verifier output with empty evidence sections is blocked", () => {
  const finalized = worker.finalizeReviewerResult(
    { id: "aq-verifier-empty", role: "verifier", intent: "verification" },
    { ok: true, exitCode: 0, text: "검증 판정: accept\n근거:\n누락 증거:\n권장 다음 조치: none." },
    "gemini"
  );
  assert.equal(finalized.status, "blocked");
  assert.match(finalized.summary, /missing required verifier evidence/i);
});

test("reviewer output is blocked when no-write task files were modified", () => {
  const finalized = worker.finalizeReviewerResult(
    { id: "aq-verifier", role: "verifier", intent: "verification" },
    {
      ok: true,
      exitCode: 0,
      text: "검증 판정: accept\n근거: evidence checked.\n누락 증거: 없음.",
      noWriteTaskViolations: [{ path: "C:\\temp\\target.js" }],
    },
    "gemini"
  );
  assert.equal(finalized.status, "blocked");
  assert.match(finalized.summary, /NO_WRITE_REVIEWER_MODIFIED_FILES/);
});
