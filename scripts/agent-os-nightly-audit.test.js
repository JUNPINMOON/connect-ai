#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const audit = require("./agent-os-nightly-audit.js");

test("nightly audit builds a read-only command plan", () => {
  const plan = audit.buildAuditPlan({
    repoRoot: "C:\\repo",
    vaultRoot: "C:\\vault",
  });
  assert.ok(plan.commands.some((item) => item.name === "transportAudit"));
  assert.ok(plan.commands.some((item) => item.name === "vaultHealth"));
  assert.ok(plan.commands.some((item) => item.name === "graphAudit"));
  assert.ok(plan.commands.some((item) => item.name === "agentContracts"));
  assert.ok(plan.commands.some((item) => item.name === "rootMigrationApproval"));
  assert.ok(plan.commands.every((item) => item.mutates === false));
});

test("nightly audit queue gate uses verifier dispatch, not direct closure", () => {
  const source = fs.readFileSync(path.join(__dirname, "agent-os-nightly-audit.js"), "utf8");
  assert.match(source, /verification-dispatch\.js/);
  assert.match(source, /--apply/);
  assert.match(source, /검증 판정: accept/);
});

test("nightly audit queue gate smoke includes required evidence fields", () => {
  const source = fs.readFileSync(path.join(__dirname, "agent-os-nightly-audit.js"), "utf8");

  assert.match(source, /Files changed: none/);
  assert.match(source, /Commands run: temp smoke/);
  assert.match(source, /Current-run expected tests\/evidence:/);
  assert.match(source, /Unresolved failures: none/);
  assert.match(source, /누락 증거: 없음/);
});

test("nightly audit derives verdict from critical checks", () => {
  assert.equal(audit.deriveVerdict({
    transportAudit: { ok: true, parsed: { findings: [] } },
    vaultHealth: { ok: true, parsed: { UnresolvedLinks: 0, StaleInboxFilesOver7Days: 0 } },
    graphAudit: { ok: true, parsed: { counts: { applyEligibleRepairs: 0, needsManualMoveOrPolicy: 0 } } },
    agentContracts: { ok: true, parsed: { success: true } },
    rootMigrationApproval: { ok: true, parsed: { ok: true, fresh: true } },
    dashboardPlugin: { ok: true, status: 200 },
    queueGate: { ok: true },
  }), "VERIFIED");
  assert.equal(audit.deriveVerdict({
    transportAudit: { ok: false },
    vaultHealth: { ok: true, parsed: { UnresolvedLinks: 0 } },
    graphAudit: { ok: true, parsed: { counts: { applyEligibleRepairs: 0, needsManualMoveOrPolicy: 0 } } },
    agentContracts: { ok: true, parsed: { success: true } },
    rootMigrationApproval: { ok: true, parsed: { ok: true } },
  }), "BLOCKED");
  assert.equal(audit.deriveVerdict({
    transportAudit: { ok: true, parsed: { findings: [] } },
    vaultHealth: { ok: true, parsed: { UnresolvedLinks: 0 } },
    graphAudit: { ok: true, parsed: { counts: { applyEligibleRepairs: 0, needsManualMoveOrPolicy: 0 } } },
    agentContracts: { ok: true, parsed: { success: false, errors: ["bad contract"] } },
    rootMigrationApproval: { ok: true, parsed: { ok: true } },
  }), "BLOCKED");
  assert.equal(audit.deriveVerdict({
    transportAudit: { ok: true, parsed: { findings: [] } },
    vaultHealth: { ok: true, parsed: { UnresolvedLinks: 0 } },
    graphAudit: { ok: true, parsed: { counts: { applyEligibleRepairs: 0, needsManualMoveOrPolicy: 0 }, debtSummary: { approvalRequiredRootMoves: { count: 35 } } } },
    agentContracts: { ok: true, parsed: { success: true } },
    rootMigrationApproval: { ok: true, parsed: { ok: false, staleReasons: ["move_plan_changed"], counts: { currentPlannedMoves: 35 } } },
  }), "BLOCKED");
  assert.equal(audit.deriveVerdict({
    transportAudit: { ok: true, parsed: { findings: [] } },
    vaultHealth: { ok: true, parsed: { UnresolvedLinks: 0, StaleInboxFilesOver7Days: 0 } },
    graphAudit: { ok: true, parsed: { counts: { applyEligibleRepairs: 0, needsManualMoveOrPolicy: 0 }, debtSummary: { approvalRequiredRootMoves: { count: 0 } } } },
    agentContracts: { ok: true, parsed: { success: true } },
    rootMigrationApproval: { ok: false, parsed: { ok: false, staleReasons: ["move_plan_changed"], counts: { currentPlannedMoves: 0 } } },
    dashboardPlugin: { ok: true, status: 200 },
    queueGate: { ok: true },
  }), "VERIFIED");
  assert.equal(audit.deriveVerdict({
    transportAudit: { ok: true, parsed: { findings: [] } },
    vaultHealth: { ok: true, parsed: { UnresolvedLinks: 2 } },
    graphAudit: { ok: true, parsed: { counts: { applyEligibleRepairs: 0, needsManualMoveOrPolicy: 0 } } },
    agentContracts: { ok: true, parsed: { success: true } },
    rootMigrationApproval: { ok: true, parsed: { ok: true } },
  }), "PARTIAL");
  assert.equal(audit.deriveVerdict({
    transportAudit: { ok: true, parsed: { findings: [] } },
    vaultHealth: { ok: true, parsed: { UnresolvedLinks: 0, StaleInboxFilesOver7Days: 0 } },
    graphAudit: { ok: true, parsed: { counts: { applyEligibleRepairs: 0, needsManualMoveOrPolicy: 35 } } },
    agentContracts: { ok: true, parsed: { success: true } },
    rootMigrationApproval: { ok: true, parsed: { ok: true } },
    dashboardPlugin: { ok: true, status: 200 },
    queueGate: { ok: true },
  }), "PARTIAL");
});

test("nightly audit can persist non-secret runtime reports", () => {
  const runtime = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "connect-ai-nightly-report-"));
  const report = {
    generatedAt: "2026-05-27T18:00:00.000Z",
    status: "PARTIAL",
    summary: {
      transportFindings: 1,
      unresolvedLinks: 0,
      graphSafeAutoRepair: 0,
      graphApprovalRequiredRootMoves: 35,
      graphIgnoredByPolicyDebt: 9,
      graphNextSafeAction: "request_human_root_migration_approval",
      rootMigrationApprovalFresh: true,
      rootMigrationApprovalArtifactExists: false,
      queueGateOk: true,
    },
  };

  const result = audit.writeAuditReport(report, { companyDir: runtime });

  assert.equal(result.ok, true);
  assert.equal(result.wrote, true);
  assert.match(result.jsonPath, /agent-os[\\/]nightly-audits[\\/]20260527T180000Z\.json$/);
  assert.match(result.markdownPath, /agent-os[\\/]nightly-audits[\\/]20260527T180000Z\.md$/);
  assert.equal(JSON.parse(fs.readFileSync(result.jsonPath, "utf8")).status, "PARTIAL");
  assert.equal(JSON.parse(fs.readFileSync(result.jsonPath, "utf8")).reportFiles.latestJsonPath, path.join(runtime, "agent-os", "nightly-audits", "latest.json"));
  const markdown = fs.readFileSync(result.markdownPath, "utf8");
  assert.match(markdown, /Status: PARTIAL/);
  assert.match(markdown, /graphApprovalRequiredRootMoves: 35/);
  assert.equal(fs.existsSync(path.join(runtime, "agent-os", "nightly-audits", "latest.json")), true);
  assert.equal(fs.existsSync(path.join(runtime, "agent-os", "nightly-audits", "latest.md")), true);
});

test("nightly audit markdown exposes executable blocked retry plan counts", () => {
  const markdown = audit.reportMarkdown({
    generatedAt: "2026-05-28T06:00:00.000Z",
    status: "VERIFIED",
    summary: {
      transportFindings: 0,
      blockedRetryPlanned: 0,
      blockedRetryBacklog: 1,
      blockedRetrySkipped: 20,
      blockedRetryCutoffHours: 6,
    },
  });

  assert.match(markdown, /blockedRetryPlanned: 0/);
  assert.match(markdown, /blockedRetryBacklog: 1/);
  assert.match(markdown, /blockedRetrySkipped: 20/);
  assert.match(markdown, /blockedRetryCutoffHours: 6/);
});
