#!/usr/bin/env node
"use strict";

// Operator-facing readiness summary for Connect AI.
// This is read-only. It runs the existing transport audit and converts the
// evidence into a compact "can I use Connect Chat now?" answer.

const { spawnSync } = require("node:child_process");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");
const transportAuditCli = path.join(__dirname, "transport-audit.js");

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function parseJson(text) {
  return JSON.parse(String(text || "").trim());
}

function runTransportAudit(options = {}) {
  const args = [transportAuditCli, "--json"];
  if (options.plannerSmoke) args.push("--planner-smoke");
  const result = spawnSync(process.execPath, args, {
    cwd: repoRoot,
    env: process.env,
    encoding: "utf8",
    windowsHide: true,
    timeout: options.timeoutMs || 180000,
    maxBuffer: 30 * 1024 * 1024,
  });

  let audit = null;
  try {
    audit = parseJson(result.stdout);
  } catch (error) {
    return {
      success: false,
      exitCode: result.status ?? 1,
      error: result.error ? result.error.message : String(error && error.message || error),
      stdout: String(result.stdout || "").slice(0, 2000),
      stderr: String(result.stderr || "").slice(0, 2000),
    };
  }
  return {
    success: true,
    exitCode: result.status ?? 0,
    audit,
  };
}

function severityCounts(findings = []) {
  const counts = { P0: 0, P1: 0, P2: 0, P3: 0 };
  for (const finding of findings) {
    if (Object.prototype.hasOwnProperty.call(counts, finding.severity)) counts[finding.severity] += 1;
  }
  return counts;
}

function classifyReadiness(audit) {
  const findings = audit.findings || [];
  const counts = severityCounts(findings);
  const queueCounts = audit.queue?.counts || {};
  const queued = queueCounts.queued || 0;
  const running = queueCounts.running || 0;
  const copied = queueCounts.copied || 0;
  const plannerDefault = audit.package?.plannerProviderDefault;
  const localDefault = audit.package?.localLlmEnabledDefault;

  if (counts.P0 > 0) {
    return {
      verdict: "NOT_READY",
      usableForGreenChat: false,
      reason: "P0 transport or runtime finding is present.",
      severityCounts: counts,
    };
  }
  if (counts.P1 > 0) {
    return {
      verdict: "NEEDS_TRIAGE",
      usableForGreenChat: false,
      reason: "P1 finding is present. Triage before new worker dispatch.",
      severityCounts: counts,
    };
  }
  if (plannerDefault !== "antigravity" || localDefault !== false) {
    return {
      verdict: "NEEDS_TRIAGE",
      usableForGreenChat: false,
      reason: "Planner/local LLM defaults are not on the safe operating profile.",
      severityCounts: counts,
    };
  }
  if (queued || running || copied) {
    return {
      verdict: "BUSY_BUT_USABLE",
      usableForGreenChat: true,
      reason: `Queue has active work: queued=${queued}, running=${running}, copied=${copied}.`,
      severityCounts: counts,
    };
  }
  if (counts.P2 > 0) {
    return {
      verdict: "LIMITED_READY",
      usableForGreenChat: true,
      reason: "Only P2 limitations remain; Green chat/queue work is usable with the documented fallback.",
      severityCounts: counts,
    };
  }
  return {
    verdict: "READY",
    usableForGreenChat: true,
    reason: "No P0/P1/P2 findings and no active queue work.",
    severityCounts: counts,
  };
}

function buildNextActions(audit, readiness) {
  const actions = [];
  const findings = audit.findings || [];
  const blocked = audit.blockedTriage?.candidateCounts || {};
  const queueCounts = audit.queue?.counts || {};

  if (readiness.verdict === "NOT_READY" || readiness.verdict === "NEEDS_TRIAGE") {
    actions.push("P0/P1 finding을 먼저 고친 뒤 `npm run agent:transport-audit -- --planner-smoke`를 다시 실행한다.");
  }
  if (findings.some((finding) => finding.code === "ANTIGRAVITY_DIRECT_RATE_LIMITED" || finding.code === "PLANNER_USING_GEMINI_FALLBACK_FOR_ANTIGRAVITY_QUOTA")) {
    actions.push("Antigravity direct quota가 풀릴 때까지 Gemini fallback을 유지하고, 이후 `npm run agent:planner-smoke -- --print-timeout 45s`로 재확인한다.");
  }
  if (findings.some((finding) => finding.code === "ANTIGRAVITY_DIRECT_COVERAGE_MISSING")) {
    actions.push("Antigravity lane은 fallback 결과를 성공으로 세지 말고, direct-only Antigravity 재실행으로 agy/transcript/stdout 증거를 채운다.");
  }
  if ((blocked.verifiedArchiveCandidates || 0) > 0) {
    actions.push("막힌 중복 작업은 `npm run agent:blocked-closure`로 dry-run 확인 후, 사용자 승인된 항목만 `--execute --human-approved --id <task-id>`로 닫는다.");
  }
  if ((blocked.retryCandidates || 0) > 0) {
    actions.push("재시도 후보는 CLI health READY 확인 후 `npm run agent:blocked-retry` dry-run부터 본다.");
  }
  if ((queueCounts.queued || 0) === 0 && (queueCounts.running || 0) === 0) {
    actions.push("새 Green 작업은 Connect Chat으로 지시해도 된다. 단, 파일 수정/worker 실행 허용 여부를 프롬프트에 명시한다.");
  }
  actions.push("Red/high-risk, protected path, 승인/토큰/주문/배포 작업은 사용자 직접 승인 전까지 큐 실행 금지.");
  return actions;
}

function buildReadinessReport(audit) {
  const readiness = classifyReadiness(audit);
  return {
    success: true,
    generatedAt: new Date().toISOString(),
    verdict: readiness.verdict,
    usableForGreenChat: readiness.usableForGreenChat,
    reason: readiness.reason,
    severityCounts: readiness.severityCounts,
    queue: {
      total: audit.queue?.count || 0,
      queued: audit.queue?.counts?.queued || 0,
      copied: audit.queue?.counts?.copied || 0,
      running: audit.queue?.counts?.running || 0,
      blocked: audit.queue?.counts?.blocked || 0,
      done: audit.queue?.counts?.done || 0,
    },
    planner: {
      defaultProvider: audit.package?.plannerProviderDefault,
      localLlmDefault: audit.package?.localLlmEnabledDefault,
      smokeSource: audit.plannerCliSmoke?.source || "",
      smokeDirectStatus: audit.plannerCliSmoke?.directStatus || "",
    },
    antigravityQuota: audit.antigravityQuota || null,
    blockedTriage: audit.blockedTriage?.candidateCounts || {},
    findings: (audit.findings || []).map((finding) => ({
      severity: finding.severity,
      code: finding.code,
      message: finding.message,
    })),
    nextActions: buildNextActions(audit, readiness),
  };
}

function formatHuman(report) {
  const lines = [];
  lines.push("Connect AI readiness (read-only)");
  lines.push("");
  lines.push(`verdict: ${report.verdict}`);
  lines.push(`usable for Green chat: ${report.usableForGreenChat ? "YES" : "NO"}`);
  lines.push(`reason: ${report.reason}`);
  lines.push(`queue: total ${report.queue.total}, queued ${report.queue.queued}, running ${report.queue.running}, copied ${report.queue.copied}, blocked ${report.queue.blocked}, done ${report.queue.done}`);
  lines.push(`planner: default=${report.planner.defaultProvider}, localLlmDefault=${report.planner.localLlmDefault}, smoke=${report.planner.smokeSource || "not-run"}, direct=${report.planner.smokeDirectStatus || "unknown"}`);
  if (report.antigravityQuota) {
    lines.push(`antigravity quota: source=${report.antigravityQuota.source}, window=${report.antigravityQuota.refreshWindow}, overages=${report.antigravityQuota.overages}`);
    for (const model of report.antigravityQuota.models || []) {
      lines.push(`- ${model.model}: ${model.remaining} (${(model.tiers || []).join("/")})`);
    }
  }
  lines.push(`blocked: archiveCandidates=${report.blockedTriage.verifiedArchiveCandidates || 0}, retryCandidates=${report.blockedTriage.retryCandidates || 0}, userDecisionRequired=${report.blockedTriage.userDecisionRequired || 0}, evidenceOnly=${report.blockedTriage.evidenceOnly || 0}`);
  lines.push("");
  lines.push("findings:");
  if (!report.findings.length) lines.push("- none");
  for (const finding of report.findings) lines.push(`- [${finding.severity}] ${finding.code}: ${finding.message}`);
  lines.push("");
  lines.push("next actions:");
  for (const action of report.nextActions) lines.push(`- ${action}`);
  return lines.join("\n");
}

function main() {
  const plannerSmoke = hasFlag("planner-smoke");
  const json = hasFlag("json");
  const auditResult = runTransportAudit({ plannerSmoke });
  if (!auditResult.success) {
    const failure = {
      success: false,
      verdict: "NOT_READY",
      usableForGreenChat: false,
      reason: "transport audit could not be parsed.",
      auditError: auditResult,
    };
    console.log(json ? JSON.stringify(failure, null, 2) : formatHuman({
      ...failure,
      queue: {},
      planner: {},
      blockedTriage: {},
      findings: [{ severity: "P0", code: "READINESS_AUDIT_FAILED", message: failure.reason }],
      nextActions: ["transport audit 실패 원인을 먼저 확인한다."],
    }));
    process.exit(1);
  }

  const report = buildReadinessReport(auditResult.audit);
  console.log(json ? JSON.stringify(report, null, 2) : formatHuman(report));
  process.exit(report.verdict === "NOT_READY" ? 1 : 0);
}

if (require.main === module) main();

module.exports = {
  buildNextActions,
  buildReadinessReport,
  classifyReadiness,
  formatHuman,
  severityCounts,
};
