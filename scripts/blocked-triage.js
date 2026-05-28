#!/usr/bin/env node
"use strict";

// Read-only triage for blocked queue items. It never changes queue state.

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const repoRoot = path.resolve(__dirname, "..");
const queueCli = path.join(__dirname, "agent-queue.js");

function getArg(name, fallback = "") {
  const idx = process.argv.indexOf(`--${name}`);
  return idx === -1 ? fallback : (process.argv[idx + 1] || fallback);
}

function redact(text, maxLen = 1200) {
  let value = String(text ?? "");
  value = value.replace(/\bAuthorization\s*:\s*Bearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi, "Authorization: Bearer <redacted>");
  value = value.replace(/\b((?:token|secret|password|passwd|api[_-]?key|client[_-]?secret|authorization|cookie|localStorage)\b\s*[:=]\s*)["']?[^"'\s,}]+/gi, "$1<redacted>");
  value = value.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi, "Bearer <redacted>");
  value = value.trim();
  return value.length > maxLen ? `${value.slice(0, maxLen)}\n...[truncated]` : value;
}

function runQueue(args, options = {}) {
  const output = execFileSync(process.execPath, [queueCli, ...args], {
    cwd: repoRoot,
    env: options.env || process.env,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  return JSON.parse(output);
}

function classifyBlocked(item) {
  const text = `${item.title || ""}\n${item.prompt || ""}\n${item.resultSummary || ""}`;
  const summary = String(item.resultSummary || "");
  if (/Green E2E probe|synthetic.*probe|E2E queue probe/i.test(item.title || "") && /blocked output|sandbox prevented|read commands|실제 파일 수정 없음/i.test(summary)) {
    return {
      bucket: "obsolete_probe_evidence",
      action: "후속 probe 통과 여부 확인 후 실패 증거로 보존하거나 별도 승인으로 archive 후보",
      closureRecommendation: "keep_as_evidence_until_new_probe_verified",
      requiresHumanDecision: false,
    };
  }
  if (/Superseded by coordinator|Original broad|replacing with small Green|대체|중복|already done|완료됨/i.test(summary)) {
    return {
      bucket: "superseded_or_duplicate",
      action: "중복/대체 근거 확인 후 별도 승인으로 archive 또는 done 정리 후보",
      closureRecommendation: "candidate_for_verified_archive",
      requiresHumanDecision: true,
    };
  }
  if (/session limit|rate.?limit|timeout|timed out|ETIMEDOUT|CLI.*failed|exit=1|AUTH_EXPIRED|TOKEN|Reached max turns/i.test(summary)) {
    return {
      bucket: "retry_after_health_check",
      action: "CLI health 재확인 후 Green/read-only 범위에서만 재큐잉 후보",
      closureRecommendation: "retry_only_after_ready_health",
      requiresHumanDecision: false,
    };
  }
  if (/^Decision request:/i.test(item.title || "") || /HUMAN_APPROVAL_REQUIRED|사용자\s*승인|human approval|approval|승인|harness|baseline|protected[_-\s]?paths/i.test(text)) {
    return {
      bucket: "needs_human",
      action: "사용자 승인 또는 명시적 폐기 결정 전까지 자동 재시도 금지",
      closureRecommendation: "keep_blocked_until_user_decision",
      requiresHumanDecision: true,
    };
  }
  if (/broker|order|live.?trade|주문|잔고|token|secret|credential|deploy|send|gmail|google sheets|구직|주식/i.test(text)) {
    return {
      bucket: "protected_or_high_risk",
      action: "보호경로/외부효과 검토 전 자동 재시도 금지",
      closureRecommendation: "keep_blocked_until_scope_rewritten",
      requiresHumanDecision: true,
    };
  }
  return {
    bucket: "manual_triage",
    action: "원인 불명. 원 작업 prompt/resultSummary 확인 후 다음 조치 결정",
    closureRecommendation: "manual_review_required",
    requiresHumanDecision: true,
  };
}

function summarize(items) {
  const blocked = items.filter((item) => item.status === "blocked");
  const details = blocked.map((item) => {
    const cls = classifyBlocked(item);
    return {
      id: item.id,
      title: item.title,
      assignee: item.assignee,
      priority: item.priority,
      bucket: cls.bucket,
      action: cls.action,
      closureRecommendation: cls.closureRecommendation,
      requiresHumanDecision: cls.requiresHumanDecision,
      resultSummary: redact(item.resultSummary || "", 600),
    };
  });
  const buckets = {};
  const recommendations = {};
  for (const detail of details) buckets[detail.bucket] = (buckets[detail.bucket] || 0) + 1;
  for (const detail of details) recommendations[detail.closureRecommendation] = (recommendations[detail.closureRecommendation] || 0) + 1;
  return {
    generatedAt: new Date().toISOString(),
    totalBlocked: blocked.length,
    buckets,
    recommendations,
    candidateCounts: {
      verifiedArchiveCandidates: details.filter((item) => item.closureRecommendation === "candidate_for_verified_archive").length,
      retryCandidates: details.filter((item) => item.closureRecommendation === "retry_only_after_ready_health").length,
      userDecisionRequired: details.filter((item) => item.requiresHumanDecision).length,
      evidenceOnly: details.filter((item) => item.closureRecommendation === "keep_as_evidence_until_new_probe_verified").length,
    },
    details,
    safeDefaults: [
      "Do not auto-retry needs_human or protected_or_high_risk items.",
      "Only retry retry_after_health_check items after current CLI health is READY.",
      "Do not mark superseded items done without evidence and a separate verifier.",
      "Keep failed synthetic probes as evidence until a newer probe passes and is independently validated.",
    ],
  };
}

function toMarkdown(report) {
  const lines = [];
  lines.push("# Connect AI Blocked Queue Triage");
  lines.push("");
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Blocked total: ${report.totalBlocked}`);
  lines.push("");
  lines.push("## Buckets");
  for (const [bucket, count] of Object.entries(report.buckets)) {
    lines.push(`- ${bucket}: ${count}`);
  }
  lines.push("");
  lines.push("## Closure Candidates");
  lines.push(`- verified archive candidates: ${report.candidateCounts.verifiedArchiveCandidates}`);
  lines.push(`- retry candidates: ${report.candidateCounts.retryCandidates}`);
  lines.push(`- user decision required: ${report.candidateCounts.userDecisionRequired}`);
  lines.push(`- evidence-only failed probes: ${report.candidateCounts.evidenceOnly}`);
  lines.push("");
  lines.push("## Items");
  for (const item of report.details) {
    lines.push(`### ${item.id}`);
    lines.push(`- title: ${item.title}`);
    lines.push(`- assignee: ${item.assignee}`);
    lines.push(`- priority: ${item.priority}`);
    lines.push(`- bucket: ${item.bucket}`);
    lines.push(`- action: ${item.action}`);
    lines.push(`- closureRecommendation: ${item.closureRecommendation}`);
    lines.push(`- requiresHumanDecision: ${item.requiresHumanDecision}`);
    if (item.resultSummary) {
      lines.push("- resultSummary:");
      lines.push("```");
      lines.push(item.resultSummary);
      lines.push("```");
    }
    lines.push("");
  }
  lines.push("## Safe Defaults");
  for (const rule of report.safeDefaults) lines.push(`- ${rule}`);
  return lines.join("\n");
}

function main() {
  const listed = runQueue(["list"]);
  const report = summarize(listed.items || []);
  const output = getArg("output", "json").toLowerCase();
  if (output === "md" || output === "markdown") {
    console.log(toMarkdown(report));
  } else {
    console.log(JSON.stringify({ success: true, path: listed.path, ...report }, null, 2));
  }
}

if (require.main === module) main();

module.exports = {
  classifyBlocked,
  summarize,
  toMarkdown,
};
