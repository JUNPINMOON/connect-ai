#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  auditGraph,
  approvalArtifactPath,
  classify,
  createHumanApprovalTemplate,
  createRootMigrationApprovalPacket,
  isGraphIgnored,
  manualMoveSuggestion,
  migrateRootNotes,
  repairGraph,
  rollbackRootMoves,
  verifyRootMigrationApprovalPacket,
  writeApprovalPacket,
} = require("./obsidian-graph-audit.js");

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function writeHumanApproval(store, batchId, packetPath, approvedActions = ["migrate", "rollback"]) {
  const packet = JSON.parse(fs.readFileSync(packetPath, "utf8"));
  const approvedAt = new Date(Date.parse(packet.generatedAt) + 1000).toISOString();
  const approvalPath = approvalArtifactPath(store, batchId);
  write(approvalPath, `${JSON.stringify({
    kind: "root-migration-human-approval",
    actorType: "human",
    approved: true,
    batchId,
    approvedActions,
    approvalText: `APPROVE ${batchId}`,
    approvedBy: "test-human",
    approvedAt,
    packetSha256: sha256(packetPath),
  }, null, 2)}\n`);
  return approvalPath;
}

test("graph audit suggests MOC and frontmatter repairs without writing", () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-graph-audit-"));
  write(path.join(vault, "00_MOC", "AI Agent OS.md"), [
    "---",
    "type: moc",
    "status: active",
    "project: \"Connect AI\"",
    "owner: \"codex\"",
    "source: \"test\"",
    "created: \"2026-05-27T00:00:00.000Z\"",
    "updated: \"2026-05-27T00:00:00.000Z\"",
    "links:",
    "  - \"[[00_MOC/AI Agent OS]]\"",
    "---",
    "# AI Agent OS",
  ].join("\n"));
  write(path.join(vault, "decisions", "legacy.md"), "# Legacy decision\nNo links yet.\n");
  write(path.join(vault, "wiki", "tools", "Tool.md"), [
    "---",
    "type: tool",
    "status: active",
    "project: \"Connect AI\"",
    "owner: \"codex\"",
    "source: \"test\"",
    "created: \"2026-05-27T00:00:00.000Z\"",
    "updated: \"2026-05-27T00:00:00.000Z\"",
    "links:",
    "  - \"[[00_MOC/Tools]]\"",
    "---",
    "# Tool",
    "[[00_MOC/Tools]]",
  ].join("\n"));
  write(path.join(vault, "_company", "runtime.md"), "# Runtime should be ignored\n");
  write(path.join(vault, ".obsidian", "workspace.md"), "# Internal should be ignored\n");
  write(path.join(vault, "decisions", "_pre-reorg-backup-20260527", "old.md"), "# Backup should be ignored\n");
  write(path.join(vault, "40_템플릿", "developer", "README.md"), "# Template should be ignored\n");

  const report = auditGraph({ vaultRoot: vault, maxItems: 10 });

  assert.equal(report.mode, "read-only");
  assert.equal(report.noteCount, 3);
  assert.equal(report.counts.totalMarkdownNotes, 5);
  assert.equal(report.counts.ignoredByPolicy, 2);
  assert.equal(report.counts.missingFrontmatter, 1);
  assert.equal(report.counts.linkless, 1);
  assert.equal(report.counts.applyEligibleRepairs, 1);
  assert.ok(report.repairPlan.some((item) => item.path === "decisions/legacy.md" && item.suggestedLink === "[[00_MOC/Decisions]]"));
  assert.equal(fs.readFileSync(path.join(vault, "decisions", "legacy.md"), "utf8"), "# Legacy decision\nNo links yet.\n");
});

test("graph audit ignore policy keeps backups and templates out of repair", () => {
  assert.equal(isGraphIgnored("decisions/_pre-reorg-backup-20260527/old.md"), true);
  assert.equal(isGraphIgnored("decisions/_hermes-unauthorized-backup-20260527/old.md"), true);
  assert.equal(isGraphIgnored("40_템플릿/developer/README.md"), true);
  assert.equal(isGraphIgnored("decisions/2026-05/current.md"), false);
});

test("graph audit classifier maps core folders to graph hubs", () => {
  assert.equal(classify("decisions/2026-05/item.md").moc, "[[00_MOC/Decisions]]");
  assert.equal(classify("runbooks/foo.md").moc, "[[00_MOC/Runbooks]]");
  assert.equal(classify("agent-guides/codex.md").moc, "[[00_MOC/Agents]]");
  assert.equal(classify("wiki/tools/GitHub.md").moc, "[[00_MOC/Tools]]");
  assert.equal(classify("wiki/projects/Connect-AI.md").moc, "[[00_MOC/Projects]]");
  assert.equal(classify("some-project.md").moc, "[[00_MOC/Projects]]");
});

test("graph audit reports manual move suggestions for root notes", () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-graph-manual-vault-"));
  write(path.join(vault, "Claude.md"), "# Claude\nRoot tool note.\n");
  write(path.join(vault, "구직.md"), "# 구직\nRoot project note.\n");
  write(path.join(vault, "검토 에이전트.md"), "# 검토 에이전트\nRoot agent note.\n");
  write(path.join(vault, "_log.md"), "# Log\nRoot runbook note.\n");

  const report = auditGraph({ vaultRoot: vault, maxItems: 10 });

  assert.equal(report.counts.applyEligibleRepairs, 0);
  assert.equal(report.counts.needsManualMoveOrPolicy, 4);
  assert.equal(report.counts.plannedManualMoves, 4);
  assert.ok(report.manualPlan.some((item) => item.path === "Claude.md" && item.suggestedMove.targetPath === "wiki/tools/Claude.md"));
  assert.ok(report.manualPlan.some((item) => item.path === "구직.md" && item.suggestedMove.targetPath === "wiki/projects/구직.md"));
  assert.ok(report.manualPlan.some((item) => item.path === "검토 에이전트.md" && item.suggestedMove.targetPath === "agent-guides/검토 에이전트.md"));
  assert.ok(report.manualPlan.every((item) => item.approvalRequired));
  assert.equal(fs.existsSync(path.join(vault, "wiki")), false);
});

test("graph audit debt summary separates safe repairs, approval gates, and ignored debt", () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-graph-debt-vault-"));
  write(path.join(vault, "decisions", "legacy.md"), "# Legacy decision\nNo links yet.\n");
  write(path.join(vault, "Claude.md"), "# Claude\nRoot tool note.\n");
  write(path.join(vault, "40_템플릿", "developer", "README.md"), "# Template\nNo graph contract.\n");
  write(path.join(vault, "_templates", "decision-template.md"), "---\ntype: decision\n---\n# Template with frontmatter\n[[Example Target]]\n");

  const report = auditGraph({ vaultRoot: vault, maxItems: 10 });

  assert.equal(report.debtSummary.safeAutoRepair.count, 1);
  assert.deepEqual(report.debtSummary.safeAutoRepair.sample, ["decisions/legacy.md"]);
  assert.equal(report.debtSummary.approvalRequiredRootMoves.count, 1);
  assert.equal(report.debtSummary.approvalRequiredRootMoves.sample[0].path, "Claude.md");
  assert.equal(report.debtSummary.ignoredByPolicyDebt.count, 1);
  assert.equal(report.debtSummary.ignoredByPolicyDebt.sample[0].path, "40_템플릿/developer/README.md");
  assert.ok(!report.debtSummary.ignoredByPolicyDebt.sample.some((item) => item.path === "_templates/decision-template.md"));
  assert.equal(report.debtSummary.nextSafeAction, "run_graph_repair");
});

test("manual move suggestion classifies root notes", () => {
  assert.equal(manualMoveSuggestion("Hermes.md").requiredLink, "[[00_MOC/Tools]]");
  assert.equal(manualMoveSuggestion("Secretary.md").targetPath, "agent-guides/Secretary.md");
  assert.equal(manualMoveSuggestion("_메모리 규칙.md").targetPath, "runbooks/_메모리 규칙.md");
  assert.equal(manualMoveSuggestion("디지털노마드.md").targetPath, "wiki/projects/디지털노마드.md");
  assert.equal(manualMoveSuggestion("wiki/tools/Hermes.md"), null);
});

test("graph repair uses vault-writer dry-run by default and skips ineligible roots", () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-graph-repair-vault-"));
  const store = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-graph-repair-store-"));
  write(path.join(vault, "decisions", "legacy.md"), "# Legacy decision\nNo links yet.\n");
  write(path.join(vault, "Root.md"), "# Root note\nNo links yet.\n");

  const report = repairGraph({ vaultRoot: vault, storageRoot: store, maxItems: 5 });

  assert.equal(report.mode, "dry-run");
  assert.equal(report.counts.attempted, 1);
  assert.equal(report.results[0].wrote, false);
  assert.equal(report.results[0].relPath, "decisions/legacy.md");
  assert.match(report.results[0].previewContent, /^---\ntype: decision/m);
  assert.equal(fs.readFileSync(path.join(vault, "decisions", "legacy.md"), "utf8"), "# Legacy decision\nNo links yet.\n");
  assert.ok(report.skippedIneligible.some((item) => item.path === "Root.md"));
});

test("graph repair execute updates eligible notes with backups", () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-graph-repair-vault-"));
  const store = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-graph-repair-store-"));
  write(path.join(vault, "agent-guides", "codex.md"), "# Codex guide\nNo hub yet.\n");

  const report = repairGraph({
    vaultRoot: vault,
    storageRoot: store,
    maxItems: 1,
    batchId: "repair-batch",
    execute: true,
  });

  assert.equal(report.mode, "live");
  assert.equal(report.counts.wrote, 1);
  const repaired = fs.readFileSync(path.join(vault, "agent-guides", "codex.md"), "utf8");
  assert.match(repaired, /^---\ntype: agent/m);
  assert.match(repaired, /\[\[00_MOC\/Agents\]\]/);
  assert.equal(fs.readFileSync(report.results[0].backupPath, "utf8"), "# Codex guide\nNo hub yet.\n");
  assert.equal(fs.existsSync(path.join(store, "vault-writer", "repair-manifests", "repair-batch.jsonl")), true);
});

test("root migration dry-run preserves basename and requires approval for live run", () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-root-migrate-vault-"));
  const store = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-root-migrate-store-"));
  write(path.join(vault, "Claude.md"), "# Claude\nRoot tool note.\n");

  const dryRun = migrateRootNotes({
    vaultRoot: vault,
    storageRoot: store,
    maxItems: 1,
    batchId: "root-batch",
  });

  assert.equal(dryRun.mode, "dry-run");
  assert.equal(dryRun.counts.attempted, 1);
  assert.equal(dryRun.results[0].targetRelPath, "wiki/tools/Claude.md");
  assert.match(dryRun.results[0].previewContent, /^---\ntype: tool/m);
  assert.equal(fs.existsSync(path.join(vault, "wiki", "tools", "Claude.md")), false);

  const rejected = migrateRootNotes({
    vaultRoot: vault,
    storageRoot: store,
    maxItems: 1,
    batchId: "root-batch-rejected",
    execute: true,
  });

  assert.equal(rejected.mode, "live");
  assert.equal(rejected.counts.rejected, 1);
  assert.match(rejected.results[0].reason, /approval/);
  assert.equal(fs.existsSync(path.join(vault, "Claude.md")), true);

  const approvedWithoutArtifact = migrateRootNotes({
    vaultRoot: vault,
    storageRoot: store,
    maxItems: 1,
    batchId: "root-batch-rejected",
    execute: true,
    approved: true,
  });

  assert.equal(approvedWithoutArtifact.counts.rejected, 1);
  assert.match(approvedWithoutArtifact.results[0].reason, /human_approval_artifact_required|approval_packet_required/);
  assert.equal(fs.existsSync(path.join(vault, "Claude.md")), true);
});

test("root migration approval packet is read-only and includes rollback gates", () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-root-approval-vault-"));
  const store = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-root-approval-store-"));
  write(path.join(vault, "Claude.md"), "# Claude\nRoot tool note.\n");
  write(path.join(vault, "구직.md"), "# 구직\nRoot project note.\n");

  const packet = createRootMigrationApprovalPacket({
    vaultRoot: vault,
    storageRoot: store,
    maxItems: 2,
    batchId: "root-approval-batch",
  });

  assert.equal(packet.mode, "approval-packet");
  assert.equal(packet.readyForApproval, true);
  assert.equal(packet.requiresExplicitHumanApproval, true);
  assert.equal(packet.counts.plannedMoves, 2);
  assert.match(packet.commands.live, /--execute --approved/);
  assert.match(packet.commands.rollback, /--rollback-roots --batch-id root-approval-batch --execute --approved/);
  assert.ok(packet.mandatoryPostRunGates.some((command) => command.includes("$env:USERPROFILE")));
  if (process.env.USERPROFILE) assert.doesNotMatch(JSON.stringify(packet), new RegExp(process.env.USERPROFILE.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")));
  assert.ok(packet.moves.every((move) => move.riskClass === "Red"));
  assert.ok(packet.moves.every((move) => move.basenamePreserved));
  assert.equal(packet.safetyPolicy.directVaultWritesAllowed, false);
  assert.equal(packet.safetyPolicy.writesRequireExecuteApprovedAndHumanArtifact, true);
  assert.equal(packet.safetyPolicy.rollbackRequiresExecuteApprovedAndHumanArtifact, true);
  assert.equal(packet.humanApprovalArtifact.requiredJson.approvalText, "APPROVE root-approval-batch");
  assert.equal(fs.existsSync(path.join(vault, "wiki")), false);

  const written = writeApprovalPacket(packet, store);
  assert.equal(fs.existsSync(written.jsonPath), true);
  assert.equal(fs.existsSync(written.markdownPath), true);
  assert.match(fs.readFileSync(written.markdownPath, "utf8"), /READY_FOR_HUMAN_APPROVAL/);
  assert.match(fs.readFileSync(written.markdownPath, "utf8"), /Human Approval Artifact/);
  assert.match(fs.readFileSync(written.markdownPath, "utf8"), /root-migration-human-approval/);
});

test("root migration approval packet verifier confirms current fresh plan", () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-root-verify-vault-"));
  const store = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-root-verify-store-"));
  write(path.join(vault, "Claude.md"), "# Claude\nRoot tool note.\n");
  write(path.join(vault, "구직.md"), "# 구직\nRoot project note.\n");
  const packet = createRootMigrationApprovalPacket({
    vaultRoot: vault,
    storageRoot: store,
    maxItems: 2,
    batchId: "root-verify-batch",
  });
  const written = writeApprovalPacket(packet, store);

  const verified = verifyRootMigrationApprovalPacket({
    vaultRoot: vault,
    storageRoot: store,
    packetPath: written.jsonPath,
  });

  assert.equal(verified.ok, true);
  assert.equal(verified.fresh, true);
  assert.equal(verified.pending, true);
  assert.equal(verified.counts.packetPlannedMoves, 2);
  assert.equal(verified.counts.currentPlannedMoves, 2);
  assert.equal(verified.humanApprovalArtifact.exists, false);
  assert.deepEqual(verified.staleReasons, []);
});

test("human approval template computes packet hash without writing artifact", () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-root-template-vault-"));
  const store = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-root-template-store-"));
  write(path.join(vault, "Claude.md"), "# Claude\nRoot tool note.\n");
  const packet = createRootMigrationApprovalPacket({
    vaultRoot: vault,
    storageRoot: store,
    maxItems: 1,
    batchId: "root-template-batch",
  });
  const written = writeApprovalPacket(packet, store);

  const template = createHumanApprovalTemplate({
    vaultRoot: vault,
    storageRoot: store,
    packetPath: written.jsonPath,
  });

  assert.equal(template.ok, true);
  assert.equal(template.wrote, false);
  assert.equal(template.writeForbidden, true);
  assert.equal(template.createManually, true);
  assert.equal(template.template.packetSha256, sha256(written.jsonPath));
  assert.equal(template.template.approvalText, "APPROVE root-template-batch");
  assert.equal(template.freshness.currentPlannedMoves, 1);
  assert.equal(fs.existsSync(template.approvalFile), false);
});

test("root migration approval packet verifier rejects stale plan", () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-root-verify-stale-vault-"));
  const store = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-root-verify-stale-store-"));
  write(path.join(vault, "Claude.md"), "# Claude\nRoot tool note.\n");
  const packet = createRootMigrationApprovalPacket({
    vaultRoot: vault,
    storageRoot: store,
    maxItems: 1,
    batchId: "root-verify-stale",
  });
  const written = writeApprovalPacket(packet, store);
  write(path.join(vault, "wiki", "tools", "Claude.md"), "# Existing target\n");

  const verified = verifyRootMigrationApprovalPacket({
    vaultRoot: vault,
    storageRoot: store,
    packetPath: written.jsonPath,
  });

  assert.equal(verified.ok, false);
  assert.equal(verified.fresh, false);
  assert.ok(verified.staleReasons.includes("move_plan_changed"));
  assert.ok(verified.staleReasons.includes("safety_problems_changed"));
  assert.equal(verified.counts.currentSafetyProblems, 1);
});

test("root migration live run rejects tampered human approval artifact", () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-root-approval-tamper-vault-"));
  const store = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-root-approval-tamper-store-"));
  const batchId = "root-approval-tamper";
  write(path.join(vault, "Claude.md"), "# Claude\nRoot tool note.\n");
  const packet = createRootMigrationApprovalPacket({
    vaultRoot: vault,
    storageRoot: store,
    maxItems: 1,
    batchId,
  });
  const written = writeApprovalPacket(packet, store);
  const approvalFile = approvalArtifactPath(store, batchId);
  write(approvalFile, `${JSON.stringify({
    kind: "root-migration-human-approval",
    actorType: "human",
    approved: true,
    batchId,
    approvedActions: ["migrate"],
    approvalText: `APPROVE ${batchId}`,
    approvedBy: "test-human",
    approvedAt: new Date(Date.parse(packet.generatedAt) + 1000).toISOString(),
    packetSha256: "not-the-packet-hash",
  })}\n`);

  const report = migrateRootNotes({
    vaultRoot: vault,
    storageRoot: store,
    maxItems: 1,
    batchId,
    execute: true,
    approved: true,
    approvalFile,
    packetPath: written.jsonPath,
  });

  assert.equal(report.counts.wrote, 0);
  assert.equal(report.counts.rejected, 1);
  assert.match(report.results[0].reason, /packet_hash_mismatch/);
  assert.equal(fs.existsSync(path.join(vault, "wiki", "tools", "Claude.md")), false);
});

test("root migration live run moves note with backup manifest after approval", () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-root-migrate-vault-"));
  const store = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-root-migrate-store-"));
  const batchId = "root-batch-approved";
  write(path.join(vault, "구직.md"), "# 구직\nRoot project note.\n");
  const packet = createRootMigrationApprovalPacket({
    vaultRoot: vault,
    storageRoot: store,
    maxItems: 1,
    batchId,
  });
  const written = writeApprovalPacket(packet, store);
  const approvalFile = writeHumanApproval(store, batchId, written.jsonPath);

  const report = migrateRootNotes({
    vaultRoot: vault,
    storageRoot: store,
    maxItems: 1,
    batchId,
    execute: true,
    approved: true,
    approvalFile,
  });

  assert.equal(report.mode, "live");
  assert.equal(report.approval.ok, true);
  assert.equal(report.counts.wrote, 1);
  assert.equal(fs.existsSync(path.join(vault, "구직.md")), false);
  const moved = path.join(vault, "wiki", "projects", "구직.md");
  assert.equal(fs.existsSync(moved), true);
  assert.match(fs.readFileSync(moved, "utf8"), /^---\ntype: project/m);
  assert.equal(fs.readFileSync(report.results[0].backupPath, "utf8"), "# 구직\nRoot project note.\n");
  const manifest = path.join(store, "vault-writer", "repair-manifests", "root-batch-approved.jsonl");
  assert.match(fs.readFileSync(manifest, "utf8"), /move-root-note/);
  assert.match(fs.readFileSync(manifest, "utf8"), /basename preserved/);
});

test("root migration rollback dry-run and live run use the migration manifest", () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-root-rollback-vault-"));
  const store = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-root-rollback-store-"));
  const batchId = "root-batch-rollback";
  write(path.join(vault, "Claude.md"), "# Claude\nRoot tool note.\n");
  const packet = createRootMigrationApprovalPacket({
    vaultRoot: vault,
    storageRoot: store,
    maxItems: 1,
    batchId,
  });
  const written = writeApprovalPacket(packet, store);
  const approvalFile = writeHumanApproval(store, batchId, written.jsonPath);

  const moved = migrateRootNotes({
    vaultRoot: vault,
    storageRoot: store,
    maxItems: 1,
    batchId,
    execute: true,
    approved: true,
    approvalFile,
  });

  assert.equal(moved.counts.wrote, 1);

  const dryRun = rollbackRootMoves({
    memoryRoot: vault,
    storageRoot: store,
    batchId,
    dryRun: true,
  });

  assert.equal(dryRun.ok, true);
  assert.equal(dryRun.count, 1);
  assert.equal(fs.existsSync(path.join(vault, "wiki", "tools", "Claude.md")), true);

  const rolledBack = rollbackRootMoves({
    memoryRoot: vault,
    storageRoot: store,
    batchId,
    approved: true,
    approvalFile,
  });

  assert.equal(rolledBack.ok, true);
  assert.equal(fs.readFileSync(path.join(vault, "Claude.md"), "utf8"), "# Claude\nRoot tool note.\n");
  assert.equal(fs.existsSync(path.join(vault, "wiki", "tools", "Claude.md")), false);
});
