#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const inventory = require("./source-control-inventory.js");

test("parsePorcelainZ classifies dirty and untracked files by feature area", () => {
  const output = [
    " M src/extension.ts",
    "?? scripts/gemini-executor.js",
    "?? scripts/vault-writer.test.js",
    "?? reports/deep-debug-swarm/run/report.json",
    "?? docs/agent-os/preflight/x/git-status.txt",
    "?? scripts/connect-ai-readiness.js",
    "?? scripts/blocked-triage.test.js",
    "?? docs/team-room-ui.md",
    "?? scripts/e2e-queue-probe.test.js",
    "?? scripts/no-write-monitor.js",
    "?? scripts/agent-os-dashboard.js",
    "?? docs/connect-ai-control-plane-handoff-2026-05-27.md",
    "",
  ].join("\0");
  const entries = inventory.parsePorcelainZ(output);

  assert.equal(entries.length, 12);
  assert.equal(entries[0].category, "extension-runtime");
  assert.equal(entries[1].category, "executor-adapters");
  assert.equal(entries[2].category, "vault-policy");
  assert.equal(entries[3].category, "reviewer-swarm");
  assert.equal(entries[4].category, "agent-os-docs");
  assert.equal(entries[5].category, "cli-health-and-routing");
  assert.equal(entries[6].category, "agent-os-control-plane");
  assert.equal(entries[7].category, "operating-docs");
  assert.equal(entries[8].category, "validation-and-smoke");
  assert.equal(entries[9].category, "queue-worker");
  assert.equal(entries[10].category, "agent-os-control-plane");
  assert.equal(entries[11].category, "operating-docs");
});

test("summarize separates tracked dirty files from untracked files", () => {
  const entries = inventory.parsePorcelainZ([
    " M package.json",
    "?? scripts/agent-queue.js",
    "?? scripts/agent-queue.test.js",
    "",
  ].join("\0"));
  const summary = inventory.summarize(entries);

  assert.equal(summary.total, 3);
  assert.equal(summary.tracked, 1);
  assert.equal(summary.untracked, 2);
  assert.equal(summary.categories["queue-worker"].total, 2);
  assert.equal(summary.categories["queue-worker"].recommendation.action, "review-then-track");
});

test("category recommendations separate generated reports from durable code", () => {
  assert.equal(inventory.recommendationForCategory("reports-artifacts").action, "archive-runtime-or-ignore");
  assert.equal(inventory.recommendationForCategory("reviewer-swarm").action, "track-code-archive-run-reports");
  assert.equal(inventory.recommendationForCategory("other").action, "manual-triage");
});

test("buildActionPlan splits track candidates from generated reports and domain review", () => {
  const entries = inventory.parsePorcelainZ([
    "?? scripts/gemini-executor.js",
    "?? docs/deep-debug-swarm.md",
    "?? reports/deep-debug-swarm/run/report.json",
    "?? reports/source-control-inventory/old/inventory.md",
    "?? pipelines/youtube-intelligence.pipeline.json",
    "?? scripts/session-search.js",
    "?? docs/agent-os/preflight/x/git-status.txt",
    "",
  ].join("\0"));
  const plan = inventory.buildActionPlan(entries);

  assert.equal(plan.counts.trackCandidate, 2);
  assert.equal(plan.counts.archiveRuntimeOrIgnore, 2);
  assert.equal(plan.counts.domainReview, 1);
  assert.equal(plan.counts.manualTriage, 1);
  assert.equal(plan.counts.ignoreCandidate, 1);
});

test("buildReviewBundles groups track candidates into verification-sized bundles", () => {
  const entries = inventory.parsePorcelainZ([
    "?? scripts/agent-queue.js",
    "?? scripts/agent-queue.test.js",
    "?? scripts/no-write-monitor.js",
    "?? scripts/gemini-executor.js",
    "?? scripts/deep-debug-swarm.js",
    "?? reports/deep-debug-swarm/run/report.json",
    "?? scripts/vault-writer.js",
    " M src/extension.ts",
    "?? scripts/session-search.js",
    "",
  ].join("\0"));
  const bundles = inventory.buildReviewBundles(entries);

  assert.equal(bundles.counts["queue-worker-core"], 3);
  assert.equal(bundles.counts["executor-adapters-and-swarm"], 2);
  assert.equal(bundles.counts["vault-policy-and-runtime-separation"], 1);
  assert.equal(bundles.counts["extension-ui-runtime"], 1);
  assert.equal(bundles.unbundledTrackCandidates.length, 0);
  assert.ok(bundles.bundles.find((bundle) => bundle.id === "queue-worker-core").verificationCommands.length > 0);
});

test("integrity gate flags critical untracked Agent OS files without treating reports as blockers", () => {
  const entries = inventory.parsePorcelainZ([
    "?? scripts/agent-queue.js",
    "?? scripts/deep-debug-swarm.js",
    "?? reports/deep-debug-swarm/run/report.json",
    " M src/extension.ts",
    "",
  ].join("\0"));
  const gate = inventory.buildIntegrityGate(entries);

  assert.equal(gate.ok, false);
  assert.equal(gate.criticalUntrackedCount, 2);
  assert.deepEqual(gate.criticalUntracked.map((entry) => entry.path), [
    "scripts/agent-queue.js",
    "scripts/deep-debug-swarm.js",
  ]);
  assert.equal(gate.trackedDirtyCount, 1);
  assert.equal(gate.ignoredArtifactCount, 1);
});

test("executor adapter bundle respects CEILING and avoids live swarm variations", () => {
  const entries = inventory.parsePorcelainZ([
    "?? scripts/gemini-executor.js",
    "?? scripts/antigravity-reviewer.js",
    "?? scripts/deep-debug-swarm.js",
    "",
  ].join("\0"));
  const bundles = inventory.buildReviewBundles(entries);
  const bundle = bundles.bundles.find((item) => item.id === "executor-adapters-and-swarm");

  assert.ok(bundle);
  assert.ok(bundle.verificationCommands.includes("Get-Content docs/agent-os/CEILING.md"));
  assert.ok(bundle.verificationCommands.every((command) => !/^node scripts\/deep-debug-swarm\.js/.test(command)));
});

test("buildCriticalBundleSummary ranks blocked bundles by critical untracked count", () => {
  const entries = inventory.parsePorcelainZ([
    "?? scripts/agent-queue.js",
    "?? scripts/run-queue.js",
    "?? scripts/gemini-executor.js",
    "?? scripts/deep-debug-swarm.js",
    "?? reports/deep-debug-swarm/run/report.json",
    " M src/extension.ts",
    "",
  ].join("\0"));
  const summary = inventory.buildCriticalBundleSummary(entries, { limit: 2 });

  assert.equal(summary.length, 2);
  assert.equal(summary[0].id, "queue-worker-core");
  assert.equal(summary[0].criticalUntrackedCount, 2);
  assert.equal(summary[1].id, "executor-adapters-and-swarm");
  assert.equal(summary[1].criticalUntrackedCount, 2);
  assert.ok(summary[0].nextCommand.includes("node --test"));
});

test("writeInventoryReport writes only under the requested report root", () => {
  const reportRoot = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-source-inventory-"));
  const result = inventory.writeInventoryReport({
    ok: true,
    generatedAt: "2026-05-28T00:00:00.000Z",
    summary: inventory.summarize(inventory.parsePorcelainZ("?? scripts/deep-debug-swarm.js\0")),
    entries: [],
  }, { reportRoot, stamp: "test-run" });

  assert.equal(result.outDir.startsWith(reportRoot), true);
  assert.equal(fs.existsSync(result.jsonPath), true);
  assert.equal(fs.existsSync(result.mdPath), true);
  assert.match(fs.readFileSync(result.mdPath, "utf8"), /Do not run git clean\/reset\/checkout/);
  assert.match(fs.readFileSync(result.mdPath, "utf8"), /recommended action:/);
  assert.match(fs.readFileSync(result.mdPath, "utf8"), /## Action Plan/);
  assert.match(fs.readFileSync(result.mdPath, "utf8"), /## Review Bundles/);
});

test("writeInventoryReport defaults to runtime companyDir, not repo reports", () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-runtime-company-"));
  const previous = process.env.CONNECT_AI_COMPANY_DIR;
  process.env.CONNECT_AI_COMPANY_DIR = runtimeRoot;
  try {
    const result = inventory.writeInventoryReport({
      ok: true,
      generatedAt: "2026-05-28T00:00:00.000Z",
      summary: inventory.summarize([]),
      entries: [],
    }, { stamp: "runtime-default" });

    assert.equal(result.outDir.startsWith(runtimeRoot), true);
    assert.doesNotMatch(result.outDir.replace(/\\/g, "/"), /\/reports\/source-control-inventory\//);
  } finally {
    if (previous === undefined) delete process.env.CONNECT_AI_COMPANY_DIR;
    else process.env.CONNECT_AI_COMPANY_DIR = previous;
  }
});
