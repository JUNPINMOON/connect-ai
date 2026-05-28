#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const envPaths = require("./env-paths.js");
const { auditGraph, verifyRootMigrationApprovalPacket } = require("./obsidian-graph-audit.js");

const repoRoot = envPaths.repoRoot();
const queuePath = envPaths.agentQueuePath();
const vaultRoot = envPaths.vaultRoot();
const companyDir = envPaths.companyDir();

function storageRoot() {
  return phase2StorageRootFromQueuePath(queuePath);
}

function phase2StorageRootFromQueuePath(file) {
  const queueDir = path.dirname(file);
  return path.basename(queueDir).toLowerCase() === "phase3" ? path.join(path.dirname(queueDir), "phase2") : queueDir;
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")); } catch { return fallback; }
}

function tryParseJson(text) {
  try { return JSON.parse(String(text || "")); } catch { return null; }
}

function readJsonl(file) {
  try {
    return fs.readFileSync(file, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => tryParseJson(line))
      .filter((entry) => entry && typeof entry === "object");
  } catch {
    return [];
  }
}

function sha256(file) {
  try { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); } catch { return ""; }
}

function fileSummary(file) {
  try {
    const stat = fs.statSync(file);
    return { exists: true, bytes: stat.size, mtime: stat.mtime.toISOString() };
  } catch {
    return { exists: false };
  }
}

function listApprovalPackets(root = storageRoot(), count = 5) {
  const dir = path.join(root, "vault-writer", "approval-packets");
  if (!fs.existsSync(dir)) return { dir, latest: null, packets: [] };
  const packets = fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".json"))
    .map((entry) => {
      const jsonPath = path.join(dir, entry.name);
      const batchId = path.basename(entry.name, ".json");
      const packet = readJson(jsonPath, null);
      if (!packet || typeof packet !== "object") {
        return {
          ok: false,
          batchId,
          jsonPath,
          markdownPath: path.join(dir, `${batchId}.md`),
          file: fileSummary(jsonPath),
          reason: "invalid_json",
        };
      }
      const resolvedBatchId = packet.batchId || batchId;
      const markdownPath = path.join(dir, `${resolvedBatchId}.md`);
      return {
        ok: true,
        batchId: resolvedBatchId,
        generatedAt: packet.generatedAt || "",
        mode: packet.mode || "",
        readyForApproval: !!packet.readyForApproval,
        requiresExplicitHumanApproval: !!packet.requiresExplicitHumanApproval,
        approved: !!packet.approved,
        counts: packet.counts || {},
        commands: packet.commands || {},
        safetyPolicy: packet.safetyPolicy || {},
        safetyProblems: Array.isArray(packet.safetyProblems) ? packet.safetyProblems : [],
        jsonPath,
        markdownPath,
        file: fileSummary(jsonPath),
        markdownFile: fileSummary(markdownPath),
      };
    })
    .sort((a, b) => String(b.generatedAt || b.file.mtime || "").localeCompare(String(a.generatedAt || a.file.mtime || "")))
    .slice(0, count);
  return {
    dir,
    latest: packets[0] || null,
    packets,
  };
}

function currentRootMigrationApprovalVerification(pendingApprovals, root = storageRoot()) {
  const packet = pendingApprovals?.rootMigrationPackets?.latest || null;
  if (!packet) {
    return {
      ok: true,
      pending: false,
      fresh: true,
      reason: "no_pending_root_migration_packet",
    };
  }
  try {
    return verifyRootMigrationApprovalPacket({
      vaultRoot,
      storageRoot: root,
      packetPath: packet.jsonPath,
    });
  } catch (error) {
    return {
      ok: false,
      pending: true,
      fresh: false,
      reason: "root_migration_approval_verifier_failed",
      error: error && error.message ? error.message : String(error),
      packetPath: packet.jsonPath || "",
    };
  }
}

function defaultCodexWorkLogPath() {
  if (process.env.CODEX_WORK_LOG) return process.env.CODEX_WORK_LOG;
  return path.join(os.homedir(), ".codex", "codex-harness", "data", "codex_work_log.jsonl");
}

function extractTestEvidence(entry) {
  const values = [
    ...(Array.isArray(entry.verification) ? entry.verification : []),
    ...(Array.isArray(entry.commands_run) ? entry.commands_run : []),
  ].map(String);
  return values.filter((value) => /\b\d+\s+(?:node\s+)?tests?\s+(?:passed|pass)\b|\b(?:pass|passed)\b.*\b\d+\b|\b(?:pass|passed)\b|\bfail(?:ed|ures?)?\b/i.test(value));
}

function canonicalStatusFromOutcome(outcome, failures = [], testEvidence = []) {
  const value = String(outcome || "").toLowerCase();
  if (value === "blocked" || value === "failed") return "BLOCKED";
  if (value === "partial" || failures.length > 0) return "PARTIAL";
  if (value === "success" && testEvidence.length > 0) return "VERIFIED";
  return "PARTIAL";
}

function listVerificationHistory(logPath = defaultCodexWorkLogPath(), count = 8) {
  const entries = readJsonl(logPath)
    .filter((entry) => Array.isArray(entry.verification) || Array.isArray(entry.commands_run))
    .slice(-count)
    .reverse()
    .map((entry) => {
      const failures = Array.isArray(entry.failures) ? entry.failures.map(String) : [];
      const testEvidence = extractTestEvidence(entry).slice(0, 8);
      const status = canonicalStatusFromOutcome(entry.outcome, failures, testEvidence);
      return {
        taskId: entry.task_id || "",
        timestamp: entry.timestamp || "",
        title: entry.title || "",
        status,
        outcome: entry.outcome || "",
        commandCount: Array.isArray(entry.commands_run) ? entry.commands_run.length : 0,
        commandsRun: Array.isArray(entry.commands_run) ? entry.commands_run.map(String).slice(0, 8) : [],
        verification: Array.isArray(entry.verification) ? entry.verification.map(String).slice(0, 10) : [],
        testEvidence,
        failures,
        hasFailures: failures.length > 0 || status !== "VERIFIED",
        nextAction: entry.next_action || "",
      };
    });
  return {
    path: logPath,
    latest: entries[0] || null,
    entries,
  };
}

function hasPendingHumanApproval(pendingApprovals) {
  const packet = pendingApprovals?.rootMigrationPackets?.latest;
  return Boolean(packet?.readyForApproval && packet?.requiresExplicitHumanApproval && !packet?.approved);
}

function statusReason(status, code, message, evidence = {}) {
  return { status, code, message, evidence };
}

function collectDashboardStatusReasons(report) {
  const reasons = [];
  const vaultHealth = report?.vaultHealthCurrent || {};
  const transportAudit = report?.transportAudit || {};
  const bundle = report?.bundle || {};
  const installs = Array.isArray(bundle.installs) ? bundle.installs : [];
  const transportFindings = Array.isArray(transportAudit.findings) ? transportAudit.findings : [];
  const graphDebt = report?.graphAudit?.debtSummary || null;

  if (!vaultHealth.ok) {
    reasons.push(statusReason("BLOCKED", "vault_health_unavailable", "Vault health check did not produce a usable result.", {
      exitCode: vaultHealth.exitCode ?? null,
      reason: vaultHealth.reason || "",
    }));
  }
  if (!transportAudit.ok) {
    reasons.push(statusReason("BLOCKED", "transport_audit_unavailable", "Transport audit did not produce a usable result.", {
      exitCode: transportAudit.exitCode ?? null,
      reason: transportAudit.reason || "",
    }));
  }
  if (!bundle?.sourceFile?.exists) {
    reasons.push(statusReason("BLOCKED", "source_bundle_missing", "Repo build bundle is missing.", {
      source: bundle.source || "",
    }));
  }

  const mismatchedInstalls = installs.filter((item) => item.matchesSource === false);
  if (mismatchedInstalls.length > 0) {
    reasons.push(statusReason("PARTIAL", "installed_bundle_mismatch", "Installed VS Code/Cursor bundle hash does not match the repo build.", {
      count: mismatchedInstalls.length,
      files: mismatchedInstalls.map((item) => item.file).slice(0, 5),
    }));
  }
  if (report?.blockedRetryPlan?.ok === false) {
    reasons.push(statusReason("PARTIAL", "blocked_retry_plan_unavailable", "Blocked retry plan could not be collected safely.", {
      exitCode: report.blockedRetryPlan.exitCode ?? null,
      reason: report.blockedRetryPlan.reason || "",
    }));
  }
  if (report?.graphAudit?.ok === false) {
    reasons.push(statusReason("PARTIAL", "graph_audit_unavailable", "Graph audit did not produce a usable debt report.", {
      reason: report.graphAudit.reason || "",
    }));
  }
  if (report?.agentContracts?.ok === false || report?.agentContracts?.success === false) {
    reasons.push(statusReason("BLOCKED", "agent_contracts_invalid", "Agent contract validation failed, so multi-agent dispatch is unsafe.", {
      exitCode: report?.agentContracts?.exitCode ?? null,
      errors: Array.isArray(report?.agentContracts?.errors) ? report.agentContracts.errors.slice(0, 10) : [],
    }));
  }
  if (transportFindings.length > 0) {
    reasons.push(statusReason("PARTIAL", "transport_findings_present", "Transport audit reported findings.", {
      count: transportFindings.length,
      findings: transportFindings.slice(0, 5),
    }));
  }
  if (Number(vaultHealth.unresolvedLinks || 0) > 0) {
    reasons.push(statusReason("PARTIAL", "vault_unresolved_links", "Vault has unresolved wiki links.", {
      count: Number(vaultHealth.unresolvedLinks || 0),
    }));
  }
  if (Number(vaultHealth.linklessNotes || 0) > 0) {
    reasons.push(statusReason("PARTIAL", "vault_linkless_notes", "Vault still has linkless notes, so the graph is not fully hub-connected.", {
      count: Number(vaultHealth.linklessNotes || 0),
      graphDebt,
    }));
  }
  if (Number(vaultHealth.filesWithoutFrontmatter || 0) > 0) {
    reasons.push(statusReason("PARTIAL", "vault_frontmatter_missing", "Vault still has notes without standard frontmatter.", {
      count: Number(vaultHealth.filesWithoutFrontmatter || 0),
      graphDebt,
    }));
  }
  if (hasPendingHumanApproval(report?.pendingApprovals)) {
    const packet = report.pendingApprovals.rootMigrationPackets.latest;
    const rootApproval = report?.rootMigrationApproval || {};
    if (rootApproval.pending && rootApproval.ok === false) {
      reasons.push(statusReason("BLOCKED", "root_migration_approval_packet_stale", "Root note migration approval packet no longer matches the current vault state.", {
        batchId: rootApproval.batchId || packet.batchId || "",
        staleReasons: Array.isArray(rootApproval.staleReasons) ? rootApproval.staleReasons.slice(0, 10) : [],
        packetPath: rootApproval.packetPath || packet.jsonPath || "",
      }));
    }
    reasons.push(statusReason("PARTIAL", "pending_root_migration_approval", "Root note migration packet is ready but requires explicit human approval.", {
      batchId: packet.batchId || "",
      plannedMoves: packet.counts?.plannedMoves ?? null,
      markdownPath: packet.markdownPath || "",
      fresh: rootApproval.fresh ?? null,
      humanApprovalArtifactExists: rootApproval.humanApprovalArtifact?.exists ?? null,
      humanApprovalArtifactPath: rootApproval.humanApprovalArtifact?.path || "",
    }));
    const watcher = report?.approvalWatcher || {};
    if (watcher?.scheduledTask?.exists === false) {
      reasons.push(statusReason("PARTIAL", "approval_watcher_not_scheduled", "Approval watcher scheduled task is not registered.", {
        taskName: watcher.scheduledTask.taskName || "ConnectAI-ApprovalWatcher",
      }));
    }
    if (watcher?.scheduledTask?.exists && watcher.scheduledTask.lastTaskResult !== null && watcher.scheduledTask.lastTaskResult !== 0) {
      reasons.push(statusReason("PARTIAL", "approval_watcher_last_run_failed", "Approval watcher scheduled task last run did not exit cleanly.", {
        taskName: watcher.scheduledTask.taskName || "ConnectAI-ApprovalWatcher",
        lastTaskResult: watcher.scheduledTask.lastTaskResult,
        lastRunTime: watcher.scheduledTask.lastRunTime || "",
      }));
    }
    if (Array.isArray(watcher.unseenReadyPackets) && watcher.unseenReadyPackets.length > 0) {
      reasons.push(statusReason("PARTIAL", "approval_watcher_unseen_packets", "Approval watcher has not yet observed all ready approval packets.", {
        unseenReadyPackets: watcher.unseenReadyPackets.slice(0, 10),
      }));
    }
  }

  const latest = report?.verificationHistory?.latest;
  if (!latest) {
    reasons.push(statusReason("PARTIAL", "verification_history_missing", "No recent verification history is available.", {}));
  } else if (latest.status !== "VERIFIED") {
    reasons.push(statusReason(latest.status === "BLOCKED" ? "BLOCKED" : "PARTIAL", "latest_verification_not_verified", "Latest recorded verification is not VERIFIED.", {
      taskId: latest.taskId || "",
      title: latest.title || "",
      status: latest.status || "",
      failures: Array.isArray(latest.failures) ? latest.failures.slice(0, 5) : [],
      nextAction: latest.nextAction || "",
    }));
  }

  return reasons;
}

function deriveDashboardStatus(report) {
  const reasons = collectDashboardStatusReasons(report);
  if (reasons.some((reason) => reason.status === "BLOCKED")) return "BLOCKED";
  if (reasons.some((reason) => reason.status === "PARTIAL")) return "PARTIAL";
  return "VERIFIED";
}

function listRecentFiles(root, count = 12) {
  const files = [];
  function walk(dir) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      if (entry.isFile()) {
        try {
          const stat = fs.statSync(full);
          files.push({ path: full, relPath: path.relative(root, full), mtime: stat.mtime.toISOString(), bytes: stat.size });
        } catch { /* ignore */ }
      }
    }
  }
  if (fs.existsSync(root)) walk(root);
  return files.sort((a, b) => String(b.mtime).localeCompare(String(a.mtime))).slice(0, count);
}

function compactText(value, maxLen = 360) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > maxLen ? `${text.slice(0, maxLen)}...` : text;
}

function classifyBlockedReason(item) {
  const summaryText = `${item?.title || ""}\n${item?.resultSummary || ""}`;
  const text = `${item?.title || ""}\n${item?.prompt || ""}\n${item?.resultSummary || ""}`;
  if (/superseded|duplicate|대체|중복/i.test(summaryText)) {
    return { code: "superseded_or_duplicate", label: "중복/대체 후보", severity: "Green" };
  }
  if (/FABRICATED_APPROVAL|fabricated approval|가짜\s*승인|승인.*환각/i.test(text)) {
    return { code: "fabricated_approval_guard", label: "가짜 승인 차단", severity: "Red" };
  }
  if (/HUMAN_APPROVAL_REQUIRED|requiresHumanApproval|human approval|사용자\s*승인|승인\s*필요|Decision request/i.test(text)) {
    return { code: "human_approval_required", label: "사용자 승인 필요", severity: "Red" };
  }
  if (/protected path|forbidden path|보호\s*경로|주식|구직|token|secret|credential/i.test(text)) {
    return { code: "protected_path_or_secret", label: "보호 경로/비밀정보", severity: "Red" };
  }
  if (/blocked_by_prompt_constraints|prompt constraints|파일 수정.*금지|worker 실행.*금지|큐 상태 변경.*금지/i.test(text)) {
    return { code: "prompt_constraints", label: "프롬프트 제약", severity: "Yellow" };
  }
  if (/session limit|auth|login|expired|quota|rate limit|RESOURCE_EXHAUSTED|CLI failed|failed exit/i.test(text)) {
    return { code: "cli_health_or_quota", label: "CLI/인증/쿼터", severity: "Yellow" };
  }
  if (/timeout|timed out|max turns|시간.*초과/i.test(text)) {
    return { code: "timeout_or_turn_limit", label: "타임아웃/턴 제한", severity: "Yellow" };
  }
  if (/health|dependency|의존성|선행/i.test(text)) {
    return { code: "health_or_dependency", label: "헬스/의존성 대기", severity: "Yellow" };
  }
  return { code: "unknown_blocked_reason", label: "원인 미분류", severity: "Yellow" };
}

function compactQueueItem(item) {
  const blockedReason = item.status === "blocked" ? classifyBlockedReason(item) : null;
  return {
    id: item.id,
    assignee: item.assignee,
    title: item.title,
    priority: item.priority || "",
    status: item.status || "",
    workerClass: item.workerClass || "",
    riskClass: item.riskClass || "",
    claimedBy: item.claimedBy || "",
    claimedAt: item.claimedAt || "",
    updatedAt: item.updatedAt || "",
    resultSummaryPreview: compactText(item.resultSummary, 500),
    promptPreview: compactText(item.prompt, 300),
    blockedReason,
  };
}

function queueSummary() {
  const items = readJson(queuePath, []);
  const array = Array.isArray(items) ? items : [];
  const counts = {};
  for (const item of array) counts[item.status || "unknown"] = (counts[item.status || "unknown"] || 0) + 1;
  return {
    path: queuePath,
    counts,
    activeWorkers: array.filter((item) => item.status === "running").map(compactQueueItem),
    blockedBacklog: array.filter((item) => item.status === "blocked").map(compactQueueItem),
    readyForVerification: array.filter((item) => item.status === "ready_for_verification").map(compactQueueItem),
    blockedReasonCounts: array.filter((item) => item.status === "blocked").reduce((acc, item) => {
      const reason = classifyBlockedReason(item);
      acc[reason.code] = (acc[reason.code] || 0) + 1;
      return acc;
    }, {}),
  };
}

function latestPreflight() {
  return readJson(path.join(repoRoot, "docs", "agent-os", "latest-preflight.json"), {});
}

function vaultHealthScore(parsed) {
  if (!parsed || typeof parsed !== "object") return null;
  const unresolvedPenalty = Math.min(Number(parsed.UnresolvedLinks || 0) * 15, 45);
  const linklessPenalty = Math.min(Number(parsed.FilesWithoutAnyLinks || 0), 20);
  const frontmatterPenalty = Math.min(Number(parsed.FilesWithoutFrontmatter || 0) * 0.2, 15);
  const scratchPenalty = Math.min(Number(parsed.ScratchBakOrTmpFiles || 0), 5);
  const stalePenalty = Math.min(Number(parsed.StaleInboxFilesOver7Days || 0) * 5, 15);
  return Math.max(0, Math.round(100 - unresolvedPenalty - linklessPenalty - frontmatterPenalty - scratchPenalty - stalePenalty));
}

function currentVaultHealth() {
  const script = path.join(vaultRoot, "runbooks", "_scripts", "obsidian-vault-health.ps1");
  if (!fs.existsSync(script)) {
    return { ok: false, reason: "vault_health_script_missing", script };
  }
  const result = spawnSync("powershell", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    `$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); & '${script.replace(/'/g, "''")}' -Json`,
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
    timeout: 60000,
    maxBuffer: 20 * 1024 * 1024,
  });
  const parsed = tryParseJson(result.stdout);
  return {
    ok: (result.status ?? 1) === 0 && Boolean(parsed),
    exitCode: result.status ?? 1,
    score: vaultHealthScore(parsed),
    unresolvedLinks: parsed?.UnresolvedLinks ?? null,
    linklessNotes: parsed?.FilesWithoutAnyLinks ?? null,
    filesWithoutFrontmatter: parsed?.FilesWithoutFrontmatter ?? null,
    staleInboxFilesOver7Days: parsed?.StaleInboxFilesOver7Days ?? null,
    scratchBakOrTmpFiles: parsed?.ScratchBakOrTmpFiles ?? null,
    parsed,
    stderr: String(result.stderr || result.error?.message || "").trim().slice(0, 4000),
  };
}

function currentGraphAudit() {
  try {
    const report = auditGraph({ vaultRoot, maxItems: 50 });
    return {
      ok: true,
      generatedAt: report.generatedAt,
      mode: report.mode,
      noteCount: report.noteCount,
      counts: report.counts,
      debtSummary: report.debtSummary,
      repairPlan: Array.isArray(report.repairPlan) ? report.repairPlan.slice(0, 10) : [],
      manualPlan: Array.isArray(report.manualPlan) ? report.manualPlan.slice(0, 10) : [],
    };
  } catch (error) {
    return {
      ok: false,
      reason: "graph_audit_failed",
      error: error && error.message ? error.message : String(error),
    };
  }
}

function currentTransportAudit() {
  const script = path.join(repoRoot, "scripts", "transport-audit.js");
  if (!fs.existsSync(script)) {
    return { ok: false, reason: "transport_audit_script_missing", script, findings: [] };
  }
  const result = spawnSync(process.execPath, [script, "--json"], {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
    timeout: 60000,
    maxBuffer: 20 * 1024 * 1024,
  });
  const parsed = tryParseJson(result.stdout);
  const findings = Array.isArray(parsed?.findings) ? parsed.findings : [];
  return {
    ok: Boolean(parsed),
    exitCode: result.status ?? 1,
    findings,
    findingCount: findings.length,
    queueCounts: parsed?.queue?.counts || {},
    workerStatus: parsed?.workers?.status || {},
    workerHealthAgents: parsed?.workers?.healthAgents || {},
    workerHealthGeneratedAt: parsed?.workers?.healthGeneratedAt || "",
    stderr: String(result.stderr || result.error?.message || "").trim().slice(0, 4000),
  };
}

function currentBlockedRetryPlan() {
  const script = path.join(repoRoot, "scripts", "blocked-retry-planner.js");
  if (!fs.existsSync(script)) {
    return { ok: false, reason: "blocked_retry_planner_missing", script };
  }
  const result = spawnSync(process.execPath, [script], {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
    timeout: 60000,
    maxBuffer: 20 * 1024 * 1024,
  });
  const parsed = tryParseJson(result.stdout);
  return {
    ok: (result.status ?? 1) === 0 && Boolean(parsed),
    exitCode: result.status ?? 1,
    mode: parsed?.mode || "",
    plannedCount: parsed?.plannedCount ?? null,
    circuitThreshold: parsed?.circuitThreshold ?? null,
    plans: Array.isArray(parsed?.plans) ? parsed.plans.slice(0, 10) : [],
    skipped: Array.isArray(parsed?.skipped) ? parsed.skipped.slice(0, 20) : [],
    stderr: String(result.stderr || result.error?.message || "").trim().slice(0, 4000),
  };
}

function currentAgentContractValidation() {
  const script = path.join(repoRoot, "scripts", "validate-agent-contracts.js");
  if (!fs.existsSync(script)) {
    return { ok: false, success: false, reason: "agent_contract_validator_missing", script };
  }
  const result = spawnSync(process.execPath, [script], {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
    timeout: 60000,
    maxBuffer: 5 * 1024 * 1024,
  });
  const parsed = tryParseJson(result.stdout);
  return {
    ok: (result.status ?? 1) === 0 && Boolean(parsed),
    exitCode: result.status ?? 1,
    success: parsed?.success === true,
    contractCount: parsed?.contractCount ?? null,
    expectedContractCount: parsed?.expectedContractCount ?? null,
    errors: Array.isArray(parsed?.errors) ? parsed.errors : [],
    stderr: String(result.stderr || result.error?.message || "").trim().slice(0, 4000),
  };
}

function scheduledTaskStatus(taskName = "ConnectAI-ApprovalWatcher") {
  if (process.platform !== "win32") {
    return { exists: false, taskName, supported: false, reason: "scheduled_tasks_windows_only" };
  }
  const script = [
    `$task = Get-ScheduledTask -TaskName '${taskName.replace(/'/g, "''")}' -ErrorAction SilentlyContinue`,
    "if ($task) {",
    `  $info = Get-ScheduledTaskInfo -TaskName '${taskName.replace(/'/g, "''")}' -ErrorAction Stop`,
    "  [pscustomobject]@{",
    "    exists = $true",
    "    supported = $true",
    "    taskName = $task.TaskName",
    "    state = [string]$task.State",
    "    lastRunTime = if ($info.LastRunTime) { $info.LastRunTime.ToString('o') } else { '' }",
    "    lastTaskResult = $info.LastTaskResult",
    "    nextRunTime = if ($info.NextRunTime) { $info.NextRunTime.ToString('o') } else { '' }",
    "    action = (($task.Actions | ForEach-Object { \"$($_.Execute) $($_.Arguments)\" }) -join '; ')",
    "  } | ConvertTo-Json -Compress",
    "} else {",
    `  [pscustomobject]@{ exists = $false; supported = $true; taskName = '${taskName.replace(/'/g, "''")}'; reason = 'task_not_found' } | ConvertTo-Json -Compress`,
    "}",
  ].join("\n");
  const result = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
    timeout: 30000,
    maxBuffer: 1024 * 1024,
  });
  const parsed = tryParseJson(result.stdout);
  if (!parsed) {
    return {
      exists: false,
      supported: true,
      taskName,
      reason: "scheduled_task_status_unavailable",
      exitCode: result.status ?? 1,
      stderr: String(result.stderr || result.error?.message || "").trim().slice(0, 1000),
    };
  }
  return {
    exists: !!parsed.exists,
    supported: parsed.supported !== false,
    taskName: parsed.taskName || taskName,
    state: parsed.state || "",
    lastRunTime: parsed.lastRunTime || "",
    lastTaskResult: Number.isFinite(Number(parsed.lastTaskResult)) ? Number(parsed.lastTaskResult) : null,
    nextRunTime: parsed.nextRunTime || "",
    action: parsed.action || "",
    reason: parsed.reason || "",
  };
}

function approvalWatcherSummary(root = storageRoot(), options = {}) {
  const statePath = options.statePath || path.join(root, "approval-watcher.state.json");
  const packetSummary = options.packetSummary || listApprovalPackets(root, 20);
  const state = readJson(statePath, {});
  const seenTokens = Array.isArray(state.seenTokens) ? state.seenTokens.map(String) : [];
  const readyPackets = (packetSummary.packets || []).filter((packet) => packet.readyForApproval && packet.requiresExplicitHumanApproval && !packet.approved);
  const readyPacketMarkers = readyPackets.map((packet) => `packet:${packet.batchId}`);
  const unseenReadyPackets = readyPacketMarkers.filter((marker) => !seenTokens.includes(marker));
  const scheduledTask = options.scheduledTask || scheduledTaskStatus(options.taskName || "ConnectAI-ApprovalWatcher");
  return {
    statePath,
    stateFile: fileSummary(statePath),
    scheduledTask,
    readyPacketCount: readyPacketMarkers.length,
    seenReadyPacketCount: readyPacketMarkers.length - unseenReadyPackets.length,
    readyPacketMarkers,
    unseenReadyPackets,
    latestReadyPacket: readyPackets[0]?.batchId || "",
  };
}

function resolveRepoPath(value) {
  if (!value) return "";
  const expanded = String(value).replaceAll("${CONNECT_AI_REPO}", repoRoot);
  return path.isAbsolute(expanded) ? expanded : path.join(repoRoot, expanded);
}

function findInstalledBundles() {
  const roots = [
    process.env.USERPROFILE ? path.join(process.env.USERPROFILE, ".vscode", "extensions") : "",
    process.env.USERPROFILE ? path.join(process.env.USERPROFILE, ".cursor", "extensions") : "",
  ].filter(Boolean);
  const bundles = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory() && /^connectailab\.connect-ai-lab-/i.test(entry.name)) {
        bundles.push(path.join(root, entry.name, "out", "extension.js"));
      }
    }
  }
  return bundles;
}

function bundleHashSummary() {
  const source = path.join(repoRoot, "out", "extension.js");
  const installs = findInstalledBundles();
  const sourceHash = sha256(source);
  return {
    source,
    sourceHash,
    sourceFile: fileSummary(source),
    installs: installs.map((file) => ({ file, hash: sha256(file), matchesSource: Boolean(sourceHash && sha256(file) === sourceHash), fileSummary: fileSummary(file) })),
  };
}

function main() {
  const preflight = latestPreflight();
  const preflightDir = resolveRepoPath(preflight.preflight);
  const health = preflightDir ? readJson(path.join(preflightDir, "vault-health.json"), null) : null;
  const syntheticLog = path.join(storageRoot(), "vault-writer", "writes.jsonl");
  const liveHealth = currentVaultHealth();
  const transportAudit = currentTransportAudit();
  const graphAudit = currentGraphAudit();
  const blockedRetryPlan = currentBlockedRetryPlan();
  const agentContracts = currentAgentContractValidation();
  const pendingApprovals = {
    rootMigrationPackets: listApprovalPackets(storageRoot(), 5),
  };
  const rootMigrationApproval = currentRootMigrationApprovalVerification(pendingApprovals, storageRoot());
  const approvalWatcher = approvalWatcherSummary(storageRoot(), { packetSummary: pendingApprovals.rootMigrationPackets });
  const verificationHistory = listVerificationHistory(defaultCodexWorkLogPath(), 8);
  const report = {
    generatedAt: new Date().toISOString(),
    repoRoot,
    vaultRoot,
    companyDir,
    queue: queueSummary(),
    vaultHealthCurrent: liveHealth,
    vaultHealthBaselineSource: preflightDir || null,
    vaultHealthBaseline: health,
    graphAudit,
    recentVaultFiles: listRecentFiles(vaultRoot, 10),
    recentRuntimeFiles: listRecentFiles(companyDir, 10),
    bundle: bundleHashSummary(),
    transportAudit,
    blockedRetryPlan,
    agentContracts,
    pendingApprovals,
    rootMigrationApproval,
    approvalWatcher,
    verificationHistory,
    lastSuccessfulSyntheticWrite: fileSummary(syntheticLog),
    tokenCostEstimate: "not_available_without_provider_usage_exports",
  };
  report.statusReasons = collectDashboardStatusReasons(report);
  report.status = deriveDashboardStatus(report);
  console.log(JSON.stringify(report, null, 2));
}

if (require.main === module) main();

module.exports = {
  bundleHashSummary,
  canonicalStatusFromOutcome,
  approvalWatcherSummary,
  collectDashboardStatusReasons,
  currentAgentContractValidation,
  currentBlockedRetryPlan,
  currentGraphAudit,
  currentRootMigrationApprovalVerification,
  currentTransportAudit,
  currentVaultHealth,
  deriveDashboardStatus,
  listApprovalPackets,
  listVerificationHistory,
  phase2StorageRootFromQueuePath,
  queueSummary,
  scheduledTaskStatus,
  classifyBlockedReason,
  compactQueueItem,
  vaultHealthScore,
};
