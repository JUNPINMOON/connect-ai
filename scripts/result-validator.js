#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { normalizeQueueItem } = require("./agent-policy.js");

function getArg(name, fallback = "") {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return fallback;
  return process.argv[idx + 1] || fallback;
}

function isWsl() {
  return process.platform === "linux" && fs.existsSync("/mnt/c");
}

function defaultStorageRoot() {
  if (process.env.CONNECT_AI_AGENT_QUEUE) return path.dirname(process.env.CONNECT_AI_AGENT_QUEUE);
  if (process.env.APPDATA) return path.join(process.env.APPDATA, "Code", "User", "globalStorage", "connectailab.connect-ai-lab", "phase3");
  if (isWsl()) {
    const user = process.env.CONNECT_AI_WINDOWS_USER || process.env.USER || "mjb58";
    return `/mnt/c/Users/${user}/AppData/Roaming/Code/User/globalStorage/connectailab.connect-ai-lab/phase3`;
  }
  return path.join(os.homedir(), ".connect-ai", "globalStorage", "connectailab.connect-ai-lab", "phase3");
}

function queuePath() {
  return process.env.CONNECT_AI_AGENT_QUEUE || path.join(defaultStorageRoot(), "agent-queue.json");
}

function readQueue() {
  try {
    const parsed = JSON.parse(fs.readFileSync(queuePath(), "utf8") || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasEvidenceFor(summary, label) {
  const normalizedLabel = String(label || "").trim().toLowerCase();
  const text = String(summary || "");
  if (!normalizedLabel) return true;
  if (normalizedLabel.includes("files changed") || normalizedLabel.includes("no-write")) {
    return /files?\s+changed|changed\s+files|filesChanged|no[-\s]?write|no\s+files?\s+(were\s+)?changed|files?\s+inspected|파일.*(변경|수정)|변경.*파일/i.test(text);
  }
  if (normalizedLabel.includes("commands run")) {
    return hasCommandEvidence(text);
  }
  if (normalizedLabel.includes("current-run") || normalizedLabel.includes("expected tests") || normalizedLabel.includes("evidence")) {
    return hasCurrentRunEvidence(text);
  }
  if (normalizedLabel.includes("unresolved failures")) {
    return hasNoUnresolvedFailures(text);
  }
  if (normalizedLabel.includes("검증 판정")) {
    return /검증\s*판정\s*:\s*(accept|reject|needs_human)/i.test(text);
  }
  if (normalizedLabel === "근거") {
    return /근거|evidence|because|검증/i.test(text);
  }
  if (normalizedLabel.includes("누락 증거")) {
    return /누락\s*증거|missing\s+evidence|none|없음/i.test(text);
  }
  return new RegExp(escapeRegex(normalizedLabel), "i").test(text);
}

function badEvidenceValue(value) {
  return /\b(not\s+(run|executed|listed|available|verified)|missing|failed|failing|failure|none|no\s+commands?)\b|미실행|누락|실패|검증하지\s*못|실행하지\s*않|없음/i.test(String(value || ""));
}

function evidenceFieldValue(text, labelPattern) {
  const nextLabel = [
    "files?\\s+changed",
    "changed\\s+files",
    "commands?\\s+run",
    "commandsRun",
    "current[-\\s]?run",
    "expected\\s+tests?\\/evidence",
    "expected\\s+tests?",
    "unresolved\\s+failures?",
    "unresolvedFailures",
    "remaining\\s+failures?",
    "residual\\s+risk",
    "검증\\s*판정",
    "근거",
    "누락\\s*증거",
  ].join("|");
  const pattern = new RegExp(`(?:${labelPattern})\\s*[:：]\\s*([\\s\\S]*?)(?=\\s+(?:${nextLabel})\\s*[:：]|$)`, "i");
  const match = String(text || "").match(pattern);
  return match ? match[1].trim() : "";
}

function hasCommandEvidence(summary) {
  const text = String(summary || "");
  const field = evidenceFieldValue(text, "commands?\\s+run|commandsRun|command|실행한\\s*명령|명령");
  if (field && badEvidenceValue(field)) return false;
  return /commands?\s+run|commandsRun|command\s*:|node --|npm run|npx\s+|pytest|python\s+|powershell|명령|실행한\s+명령/i.test(text);
}

function hasCurrentRunEvidence(summary) {
  const text = String(summary || "");
  const field = evidenceFieldValue(text, "current[-\\s]?run(?:\\s+expected\\s+tests\\/evidence)?|expected\\s+tests?\\/evidence|expected\\s+tests?");
  if (field && badEvidenceValue(field)) return false;
  return /current[-\s]?run|expected\s+tests?|tests?\s+(passed|run)|evidence|검증|통과|node --|npm run|npx\s+|pytest/i.test(text);
}

function hasNoUnresolvedFailures(summary) {
  const text = String(summary || "");
  if (/no\s+unresolved\s+failures?|no\s+remaining\s+failures?|미해결\s*실패\s*(없음|없|0)|실패.*없/i.test(text)) return true;
  if (/residual\s+risk\s*:\s*(none|0|no|없음)/i.test(text)) return true;
  const field = text.match(/(?:unresolved\s+failures?|unresolvedFailures|remaining\s+failures?|미해결\s*실패)\s*[:：]\s*([^\r\n.;]*)/i);
  if (!field) return false;
  const value = field[1].trim();
  return /^(none|no|0|\[\]|없음|없|무|n\/a|na)$/i.test(value);
}

function missingRequiredEvidence(item) {
  const requirements = Array.isArray(item.evidenceRequired) ? item.evidenceRequired : [];
  return requirements
    .map((requirement) => String(requirement || "").trim())
    .filter(Boolean)
    .filter((requirement) => !hasEvidenceFor(item.resultSummary || "", requirement));
}

function validateItem(item) {
  const normalized = normalizeQueueItem(item);
  const summary = String(normalized.resultSummary || "");
  const findings = [];
  if (normalized.status === "done") {
    if (!summary.trim()) findings.push("DONE_WITHOUT_RESULT_SUMMARY");
    if (normalized.canWrite && !normalized.verifiedAt) findings.push("DONE_WITHOUT_VERIFIER");
    if (/I'll start|I'll begin|I will inspect|Evidence Needed|Need to inspect/i.test(summary)) findings.push("NON_FINAL_PLANNING_OUTPUT");
    if (/승인\s*(완료|반영|받음|득)|approval\s*(granted|complete)|approved/i.test(summary) && !normalized.humanApprovedAt) findings.push("APPROVAL_CLAIM_WITHOUT_HUMAN_FLAG");
    if (normalized.riskClass === "Red" && !normalized.humanApprovedAt) findings.push("RED_DONE_WITHOUT_HUMAN_APPROVAL");
    if ((normalized.workerClass === "executor" || normalized.canWrite) && /modified|changed|updated|수정|변경|추가/i.test(summary) && !/test|검증|node --|npm run|pytest|passed|통과/i.test(summary)) {
      findings.push("WRITE_CLAIM_WITHOUT_VERIFICATION");
    }
  }
  if (normalized.status === "ready_for_verification" && !summary.trim()) findings.push("READY_FOR_VERIFICATION_WITHOUT_RESULT_SUMMARY");
  const missingEvidence = (normalized.status === "done" || normalized.status === "ready_for_verification") && !normalized.verifiedAt
    ? missingRequiredEvidence(normalized)
    : [];
  if (missingEvidence.length) findings.push("MISSING_REQUIRED_EVIDENCE");
  return {
    id: normalized.id,
    title: normalized.title,
    assignee: normalized.assignee,
    status: normalized.status,
    riskClass: normalized.riskClass,
    workerClass: normalized.workerClass,
    valid: findings.length === 0,
    findings,
    missingEvidence,
  };
}

function main() {
  const id = getArg("id");
  const recentHours = Number(getArg("recent-hours", "0")) || 0;
  const cutoffMs = recentHours > 0 ? Date.now() - recentHours * 60 * 60 * 1000 : 0;
  const items = readQueue();
  const selected = (id ? items.filter((item) => item.id === id) : items.filter((item) => item.status === "done" || item.status === "blocked" || item.status === "ready_for_verification"))
    .filter((item) => {
      if (!cutoffMs) return true;
      const stamp = Date.parse(item.updatedAt || item.completedAt || item.createdAt || "");
      return Number.isFinite(stamp) && stamp >= cutoffMs;
    });
  const results = selected.map(validateItem);
  console.log(JSON.stringify({
    success: results.every((result) => result.valid),
    path: queuePath(),
    count: results.length,
    invalidCount: results.filter((result) => !result.valid).length,
    results,
  }, null, 2));
  if (results.some((result) => !result.valid)) process.exit(1);
}

if (require.main === module) main();

module.exports = { validateItem, missingRequiredEvidence, hasNoUnresolvedFailures, hasCommandEvidence, hasCurrentRunEvidence };
