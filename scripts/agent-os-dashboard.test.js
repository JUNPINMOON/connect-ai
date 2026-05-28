#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const dashboard = require("./agent-os-dashboard.js");

test("dashboard exports queue and bundle summaries", () => {
  assert.equal(typeof dashboard.queueSummary, "function");
  assert.equal(typeof dashboard.approvalWatcherSummary, "function");
  assert.equal(typeof dashboard.bundleHashSummary, "function");
  assert.equal(typeof dashboard.canonicalStatusFromOutcome, "function");
  assert.equal(typeof dashboard.collectDashboardStatusReasons, "function");
  assert.equal(typeof dashboard.currentAgentContractValidation, "function");
  assert.equal(typeof dashboard.currentBlockedRetryPlan, "function");
  assert.equal(typeof dashboard.currentGraphAudit, "function");
  assert.equal(typeof dashboard.currentRootMigrationApprovalVerification, "function");
  assert.equal(typeof dashboard.currentTransportAudit, "function");
  assert.equal(typeof dashboard.currentVaultHealth, "function");
  assert.equal(typeof dashboard.deriveDashboardStatus, "function");
  assert.equal(typeof dashboard.listApprovalPackets, "function");
  assert.equal(typeof dashboard.listVerificationHistory, "function");
  assert.equal(typeof dashboard.phase2StorageRootFromQueuePath, "function");
  assert.equal(typeof dashboard.vaultHealthScore, "function");
  assert.equal(typeof dashboard.scheduledTaskStatus, "function");
  assert.equal(typeof dashboard.classifyBlockedReason, "function");
  assert.equal(typeof dashboard.compactQueueItem, "function");
  const queue = dashboard.queueSummary();
  assert.ok(queue.path);
  assert.ok(queue.counts);
});

test("dashboard classifies blocked queue reasons for UI display", () => {
  assert.equal(dashboard.classifyBlockedReason({
    title: "Decision request: 승인 필요",
    resultSummary: "HUMAN_APPROVAL_REQUIRED",
  }).code, "human_approval_required");
  assert.equal(dashboard.classifyBlockedReason({
    title: "Green probe",
    resultSummary: "blocked_by_prompt_constraints=true; worker 실행 금지",
  }).code, "prompt_constraints");
  assert.equal(dashboard.classifyBlockedReason({
    title: "Antigravity planner",
    resultSummary: "RESOURCE_EXHAUSTED quota reached",
  }).code, "cli_health_or_quota");
  assert.equal(dashboard.classifyBlockedReason({
    title: "Old duplicate",
    resultSummary: "Superseded by coordinator",
  }).code, "superseded_or_duplicate");
  assert.equal(dashboard.classifyBlockedReason({
    title: "구직 프로젝트 Connect AI 연결 실제 작업 등록",
    prompt: "Red/Yellow 작업은 decision request 및 승인 필요",
    resultSummary: "Superseded by coordinator. No project files changed by this task.",
  }).code, "superseded_or_duplicate");
});

test("dashboard compact queue item preserves blocked reason and evidence preview", () => {
  const item = dashboard.compactQueueItem({
    id: "aq-test",
    assignee: "codex",
    status: "blocked",
    priority: "P1",
    title: "Green worker handoff",
    resultSummary: "blocked_by_prompt_constraints=true. 파일 수정 금지라 실행하지 않음.",
    prompt: "테스트용 Green worker 하달 점검",
    claimedBy: "codex-test",
    workerClass: "executor",
    riskClass: "Green",
  });

  assert.equal(item.blockedReason.code, "prompt_constraints");
  assert.equal(item.workerClass, "executor");
  assert.match(item.resultSummaryPreview, /blocked_by_prompt_constraints/);
});

test("dashboard vault health score penalizes current graph issues", () => {
  assert.equal(dashboard.vaultHealthScore({
    UnresolvedLinks: 0,
    FilesWithoutAnyLinks: 0,
    FilesWithoutFrontmatter: 0,
    ScratchBakOrTmpFiles: 0,
    StaleInboxFilesOver7Days: 0,
  }), 100);
  assert.ok(dashboard.vaultHealthScore({
    UnresolvedLinks: 2,
    FilesWithoutAnyLinks: 8,
    FilesWithoutFrontmatter: 20,
    ScratchBakOrTmpFiles: 1,
    StaleInboxFilesOver7Days: 1,
  }) < 100);
});

test("dashboard derives phase2 storage root from phase3 queue path", () => {
  const queueFile = path.join("C:", "Users", "someone", "globalStorage", "connectailab.connect-ai-lab", "phase3", "agent-queue.json");

  assert.equal(
    dashboard.phase2StorageRootFromQueuePath(queueFile),
    path.join("C:", "Users", "someone", "globalStorage", "connectailab.connect-ai-lab", "phase2"),
  );
});

test("dashboard summarizes latest root migration approval packet", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-dashboard-packets-"));
  const dir = path.join(root, "vault-writer", "approval-packets");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "older.json"), `${JSON.stringify({
    generatedAt: "2026-05-27T00:00:00.000Z",
    mode: "approval-packet",
    batchId: "older",
    readyForApproval: false,
    counts: { plannedMoves: 1, safetyProblems: 1 },
  })}\n`, "utf8");
  fs.writeFileSync(path.join(dir, "latest.json"), `${JSON.stringify({
    generatedAt: "2026-05-27T01:00:00.000Z",
    mode: "approval-packet",
    batchId: "latest",
    readyForApproval: true,
    requiresExplicitHumanApproval: true,
    approved: false,
    counts: { plannedMoves: 35, safetyProblems: 0 },
    commands: { live: "npm run agent:graph-audit -- --migrate-roots --execute --approved" },
    safetyPolicy: { directVaultWritesAllowed: false },
    safetyProblems: [],
  })}\n`, "utf8");
  fs.writeFileSync(path.join(dir, "latest.md"), "# Latest packet\n", "utf8");

  const summary = dashboard.listApprovalPackets(root, 5);

  assert.equal(summary.latest.batchId, "latest");
  assert.equal(summary.latest.readyForApproval, true);
  assert.equal(summary.latest.requiresExplicitHumanApproval, true);
  assert.equal(summary.latest.counts.plannedMoves, 35);
  assert.equal(summary.latest.counts.safetyProblems, 0);
  assert.equal(summary.latest.markdownFile.exists, true);
});

test("dashboard summarizes recent verification history from harness log", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-dashboard-verification-"));
  const log = path.join(root, "codex_work_log.jsonl");
  fs.writeFileSync(log, [
    JSON.stringify({
      task_id: "old",
      timestamp: "2026-05-27T00:00:00+09:00",
      title: "Old task",
      outcome: "success",
      commands_run: ["node --test old.test.js"],
      verification: ["1 Node tests passed"],
      failures: [],
      next_action: "none",
    }),
    JSON.stringify({
      task_id: "latest",
      timestamp: "2026-05-27T01:00:00+09:00",
      title: "Latest task",
      outcome: "partial",
      commands_run: ["node --test suite.test.js", "npm run compile"],
      verification: ["79 Node tests passed", "compile passed"],
      failures: ["CodeRabbit timed out"],
      next_action: "retry review later",
    }),
  ].join("\n") + "\n", "utf8");

  const history = dashboard.listVerificationHistory(log, 5);

  assert.equal(history.latest.taskId, "latest");
  assert.equal(history.latest.status, "PARTIAL");
  assert.equal(history.latest.outcome, "partial");
  assert.equal(history.latest.commandCount, 2);
  assert.equal(history.latest.hasFailures, true);
  assert.deepEqual(history.latest.testEvidence, ["79 Node tests passed", "compile passed"]);
  assert.equal(history.entries.length, 2);
  assert.equal(history.entries[1].status, "VERIFIED");
});

test("dashboard summarizes approval watcher state for root migration packets", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-dashboard-approval-watcher-"));
  const packetDir = path.join(root, "vault-writer", "approval-packets");
  const statePath = path.join(root, "approval-watcher.state.json");
  fs.mkdirSync(packetDir, { recursive: true });
  fs.writeFileSync(path.join(packetDir, "root-migration-one.json"), `${JSON.stringify({
    batchId: "root-migration-one",
    generatedAt: "2026-05-27T01:00:00.000Z",
    readyForApproval: true,
    requiresExplicitHumanApproval: true,
    approved: false,
    counts: { plannedMoves: 35 },
  })}\n`, "utf8");
  fs.writeFileSync(statePath, `\uFEFF${JSON.stringify({
    seenTokens: ["packet:root-migration-one"],
  })}\n`, "utf8");

  const summary = dashboard.approvalWatcherSummary(root, {
    scheduledTask: {
      exists: true,
      taskName: "ConnectAI-ApprovalWatcher",
      state: "Ready",
      lastTaskResult: 0,
    },
  });

  assert.equal(summary.readyPacketCount, 1);
  assert.equal(summary.seenReadyPacketCount, 1);
  assert.deepEqual(summary.unseenReadyPackets, []);
  assert.equal(summary.latestReadyPacket, "root-migration-one");
  assert.equal(summary.scheduledTask.exists, true);
});

test("dashboard reasons flag unseen approval watcher packets", () => {
  const report = {
    vaultHealthCurrent: { ok: true, unresolvedLinks: 0, linklessNotes: 0, filesWithoutFrontmatter: 0 },
    transportAudit: { ok: true, findings: [] },
    blockedRetryPlan: { ok: true },
    agentContracts: { ok: true, success: true },
    bundle: { sourceFile: { exists: true }, installs: [{ matchesSource: true }] },
    pendingApprovals: {
      rootMigrationPackets: {
        latest: {
          batchId: "root-migration-one",
          readyForApproval: true,
          requiresExplicitHumanApproval: true,
          approved: false,
          counts: { plannedMoves: 35 },
        },
      },
    },
    approvalWatcher: {
      scheduledTask: { exists: true, taskName: "ConnectAI-ApprovalWatcher", lastTaskResult: 0 },
      unseenReadyPackets: ["packet:root-migration-one"],
    },
    verificationHistory: { latest: { status: "VERIFIED" } },
  };

  const reasons = dashboard.collectDashboardStatusReasons(report);

  assert.ok(reasons.some((reason) => reason.code === "approval_watcher_unseen_packets"));
  assert.equal(dashboard.deriveDashboardStatus(report), "PARTIAL");
});

test("dashboard blocks stale root migration approval packets", () => {
  const report = {
    vaultHealthCurrent: { ok: true, unresolvedLinks: 0, linklessNotes: 0, filesWithoutFrontmatter: 0 },
    transportAudit: { ok: true, findings: [] },
    blockedRetryPlan: { ok: true },
    agentContracts: { ok: true, success: true },
    bundle: { sourceFile: { exists: true }, installs: [{ matchesSource: true }] },
    pendingApprovals: {
      rootMigrationPackets: {
        latest: {
          batchId: "root-migration-one",
          jsonPath: "packet.json",
          markdownPath: "packet.md",
          readyForApproval: true,
          requiresExplicitHumanApproval: true,
          approved: false,
          counts: { plannedMoves: 35 },
        },
      },
    },
    rootMigrationApproval: {
      ok: false,
      pending: true,
      fresh: false,
      batchId: "root-migration-one",
      packetPath: "packet.json",
      humanApprovalArtifact: { exists: false, path: "approval.json" },
      staleReasons: ["move_plan_changed"],
    },
    approvalWatcher: {
      scheduledTask: { exists: true, taskName: "ConnectAI-ApprovalWatcher", lastTaskResult: 0 },
      unseenReadyPackets: [],
    },
    verificationHistory: { latest: { status: "VERIFIED" } },
  };

  const reasons = dashboard.collectDashboardStatusReasons(report);

  assert.equal(dashboard.deriveDashboardStatus(report), "BLOCKED");
  assert.ok(reasons.some((reason) => reason.code === "root_migration_approval_packet_stale"));
  assert.equal(reasons.find((reason) => reason.code === "pending_root_migration_approval").evidence.fresh, false);
  assert.equal(reasons.find((reason) => reason.code === "pending_root_migration_approval").evidence.humanApprovalArtifactExists, false);
});

test("dashboard blocks when agent contracts are invalid", () => {
  const report = {
    vaultHealthCurrent: { ok: true, unresolvedLinks: 0, linklessNotes: 0, filesWithoutFrontmatter: 0 },
    transportAudit: { ok: true, findings: [] },
    blockedRetryPlan: { ok: true },
    agentContracts: { ok: false, success: false, errors: ["missing contract codex-implementer"] },
    bundle: { sourceFile: { exists: true }, installs: [{ matchesSource: true }] },
    pendingApprovals: { rootMigrationPackets: { latest: null } },
    verificationHistory: { latest: { status: "VERIFIED" } },
  };

  const reasons = dashboard.collectDashboardStatusReasons(report);

  assert.equal(dashboard.deriveDashboardStatus(report), "BLOCKED");
  assert.ok(reasons.some((reason) => reason.code === "agent_contracts_invalid"));
});

test("dashboard derives canonical status from health, approvals, and verification", () => {
  const base = {
    vaultHealthCurrent: { ok: true, unresolvedLinks: 0, linklessNotes: 0, filesWithoutFrontmatter: 0 },
    transportAudit: { ok: true, findings: [] },
    blockedRetryPlan: { ok: true, plannedCount: 0 },
    agentContracts: { ok: true, success: true },
    bundle: { sourceFile: { exists: true }, installs: [{ matchesSource: true }] },
    pendingApprovals: { rootMigrationPackets: { latest: null } },
    verificationHistory: {
      latest: { status: "VERIFIED" },
    },
  };

  assert.equal(dashboard.deriveDashboardStatus(base), "VERIFIED");
  assert.equal(dashboard.deriveDashboardStatus({
    ...base,
    pendingApprovals: {
      rootMigrationPackets: {
        latest: {
          readyForApproval: true,
          requiresExplicitHumanApproval: true,
          approved: false,
        },
      },
    },
  }), "PARTIAL");
  assert.equal(dashboard.deriveDashboardStatus({
    ...base,
    vaultHealthCurrent: { ok: false, unresolvedLinks: null },
  }), "BLOCKED");
  assert.equal(dashboard.deriveDashboardStatus({
    ...base,
    transportAudit: {
      ok: true,
      findings: [{ severity: "P2", code: "CLAUDE_HEALTH_STATUS_MISMATCH" }],
    },
  }), "PARTIAL");
  assert.equal(dashboard.deriveDashboardStatus({
    ...base,
    blockedRetryPlan: { ok: false },
  }), "PARTIAL");
  assert.equal(dashboard.deriveDashboardStatus({
    ...base,
    verificationHistory: { latest: { status: "PARTIAL" } },
  }), "PARTIAL");
});

test("dashboard exposes structured status reasons", () => {
  const report = {
    vaultHealthCurrent: {
      ok: true,
      unresolvedLinks: 0,
      linklessNotes: 11,
      filesWithoutFrontmatter: 44,
    },
    transportAudit: { ok: true, findings: [] },
    blockedRetryPlan: { ok: true, plannedCount: 0, skipped: [] },
    agentContracts: { ok: true, success: true },
    bundle: { sourceFile: { exists: true }, installs: [{ matchesSource: true }] },
    pendingApprovals: {
      rootMigrationPackets: {
        latest: {
          batchId: "root-migration",
          readyForApproval: true,
          requiresExplicitHumanApproval: true,
          approved: false,
          counts: { plannedMoves: 35 },
          markdownPath: "approval.md",
        },
      },
    },
    rootMigrationApproval: {
      ok: true,
      pending: true,
      fresh: true,
      humanApprovalArtifact: { exists: false, path: "approval.json" },
    },
    verificationHistory: {
      latest: {
        taskId: "latest",
        title: "Latest slice",
        status: "PARTIAL",
        failures: ["CodeRabbit timed out"],
        nextAction: "retry review",
      },
    },
  };

  const reasons = dashboard.collectDashboardStatusReasons(report);
  const codes = reasons.map((reason) => reason.code);

  assert.equal(dashboard.deriveDashboardStatus(report), "PARTIAL");
  assert.ok(codes.includes("vault_linkless_notes"));
  assert.ok(codes.includes("vault_frontmatter_missing"));
  assert.ok(codes.includes("pending_root_migration_approval"));
  assert.ok(codes.includes("latest_verification_not_verified"));
  assert.equal(reasons.find((reason) => reason.code === "pending_root_migration_approval").evidence.plannedMoves, 35);
  assert.equal(reasons.find((reason) => reason.code === "pending_root_migration_approval").evidence.humanApprovalArtifactExists, false);
});

test("dashboard status reasons expose graph debt action buckets", () => {
  const report = {
    vaultHealthCurrent: {
      ok: true,
      unresolvedLinks: 0,
      linklessNotes: 6,
      filesWithoutFrontmatter: 35,
    },
    graphAudit: {
      ok: true,
      counts: {
        applyEligibleRepairs: 0,
        needsManualMoveOrPolicy: 35,
      },
      debtSummary: {
        safeAutoRepair: { count: 0, sample: [] },
        approvalRequiredRootMoves: { count: 35, sample: [{ path: "Claude.md", targetPath: "wiki/tools/Claude.md" }] },
        ignoredByPolicyDebt: { count: 9, sample: [{ path: "40_템플릿/developer/README.md" }] },
        nextSafeAction: "request_human_root_migration_approval",
      },
    },
    transportAudit: { ok: true, findings: [] },
    blockedRetryPlan: { ok: true, plannedCount: 0, skipped: [] },
    agentContracts: { ok: true, success: true },
    bundle: { sourceFile: { exists: true }, installs: [{ matchesSource: true }] },
    pendingApprovals: { rootMigrationPackets: { latest: null } },
    verificationHistory: { latest: { status: "VERIFIED" } },
  };

  const reasons = dashboard.collectDashboardStatusReasons(report);

  assert.equal(reasons.find((reason) => reason.code === "vault_frontmatter_missing").evidence.graphDebt.approvalRequiredRootMoves.count, 35);
  assert.equal(reasons.find((reason) => reason.code === "vault_linkless_notes").evidence.graphDebt.nextSafeAction, "request_human_root_migration_approval");
});
