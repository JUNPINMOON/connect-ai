#!/usr/bin/env node
"use strict";

// Create read-only reviewer tasks for queue items waiting in ready_for_verification.
// Default mode is dry-run. Use --execute to enqueue reviewer tasks.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { AGENT_ROLES } = require("./agent-policy.js");
const { validateItem } = require("./result-validator.js");

const repoRoot = path.resolve(__dirname, "..");
const queueCli = path.join(__dirname, "agent-queue.js");
const DEFAULT_FORBIDDEN_PATHS = [
  "C:\\Users\\mjb58\\connect-ai-vault",
  "transport-audit",
  "swarm-status",
  "readiness",
  "dashboard/audit features",
];
const VERIFIER_VERDICT_LABEL_PATTERN = "(?:(?:검증|심사)\\s*(?:판정|결과)|(?:결과\\s*(?:판정|분류)|판정\\s*결과)|verification\\s*verdict|verdict)";
const VERIFIER_EVIDENCE_LABEL_PATTERN = "(?:근거|증거|evidence)";
const VERIFIER_MISSING_EVIDENCE_LABEL_PATTERN = "(?:누락\\s*증거|잔여\\s*위험(?:\\s*평가)?|missing\\s*evidence|unresolved\\s*failures?|residual\\s*risk)";
const VERIFIER_NEXT_ACTION_LABEL_PATTERN = "(?:권장\\s*다음\\s*조치|다음\\s*권장\\s*안전\\s*조치|next\\s*safe\\s*action|recommended\\s*next\\s*action)";
const VERIFIER_SECTION_LABELS_PATTERN = `(?:${VERIFIER_VERDICT_LABEL_PATTERN}|${VERIFIER_EVIDENCE_LABEL_PATTERN}|${VERIFIER_MISSING_EVIDENCE_LABEL_PATTERN}|${VERIFIER_NEXT_ACTION_LABEL_PATTERN})`;

function getArg(name, fallback = "") {
  const idx = process.argv.indexOf(`--${name}`);
  return idx === -1 ? fallback : (process.argv[idx + 1] || fallback);
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function redact(text, maxLen = 8000) {
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

function markerFor(id) {
  return `[verify-source:${id}]`;
}

function sourceIdFromText(text) {
  const match = String(text || "").match(/\[verify-source:([^\]\s]+)\]/);
  return match ? match[1] : "";
}

function exactVerdictToken(value) {
  const token = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  if (token === "reject") return "reject";
  if (token === "needs_human") return "needs_human";
  if (token === "accept") return "accept";
  return "";
}

function verdictFromSummary(summary) {
  const text = String(summary || "");
  const verdictLine = new RegExp(`(?:^|\\n|Output:\\s*)\\s*(?:#+\\s*)?(?:\\d+[.)]?\\s*)?${VERIFIER_VERDICT_LABEL_PATTERN}\\s*[:：]\\s*([^\\r\\n]*)`, "i").exec(text);
  if (!verdictLine) return "";
  const inline = exactVerdictToken(verdictLine[1]);
  if (inline) return inline;
  const afterLine = text.slice(verdictLine.index + verdictLine[0].length);
  const nextNonEmpty = afterLine.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  return exactVerdictToken(nextNonEmpty);
}

function hasSectionLabel(text, labelPattern) {
  return new RegExp(`(?:^|\\n)\\s*(?:#+\\s*)?(?:\\d+[.)]?\\s*)?${labelPattern}\\s*(?:[:：]|\\n)`, "i").test(String(text || ""));
}

function sectionContent(text, labelPattern) {
  const source = String(text || "");
  const match = new RegExp(`(?:^|\\n)\\s*(?:#+\\s*)?(?:\\d+[.)]?\\s*)?${labelPattern}\\s*(?:[:：]|\\n)`, "i").exec(source);
  if (!match) return "";
  const start = match.index + match[0].length;
  const rest = source.slice(start);
  const next = rest.search(new RegExp(`\\n\\s*(?:#+\\s*)?(?:\\d+[.)]?\\s*)?${VERIFIER_SECTION_LABELS_PATTERN}\\s*(?:[:：]|\\n)`, "i"));
  return (next === -1 ? rest : rest.slice(0, next)).trim();
}

function hasSectionContent(text, labelPattern) {
  return Boolean(hasSectionLabel(text, labelPattern) && sectionContent(text, labelPattern));
}

function hasVerifierRequiredEvidence(item) {
  const text = String(item?.resultSummary || "");
  return Boolean(
    verdictFromSummary(text)
    && hasSectionContent(text, VERIFIER_EVIDENCE_LABEL_PATTERN)
    && hasSectionContent(text, VERIFIER_MISSING_EVIDENCE_LABEL_PATTERN)
  );
}

function isReviewer(item) {
  const role = AGENT_ROLES[item.assignee] || {};
  return role.workerClass === "reviewer";
}

function isVerifierTask(item) {
  return Boolean(item && isReviewer(item) && item.role === "verifier" && item.intent === "verification");
}

function timestampMs(value) {
  const ms = Date.parse(String(value || ""));
  return Number.isFinite(ms) ? ms : 0;
}

function latestTimestampMs(item, fields) {
  return Math.max(0, ...fields.map((field) => timestampMs(item?.[field])));
}

function sourceUpdatedMs(source) {
  return latestTimestampMs(source, ["updatedAt", "completedAt", "createdAt"]);
}

function verifierEvidenceMs(verifier) {
  return latestTimestampMs(verifier, ["verifiedAt", "updatedAt", "completedAt", "createdAt"]);
}

function isFreshForSource(verifier, source) {
  const sourceMs = sourceUpdatedMs(source);
  if (!sourceMs) return true;
  return verifierEvidenceMs(verifier) >= sourceMs;
}

function priorityFor(item) {
  return ["P0", "P1", "P2"].includes(item.priority) ? item.priority : "P1";
}

function listLines(values) {
  const list = Array.isArray(values) ? values : (values ? [values] : []);
  return list.length ? list.map((value) => `- ${value}`).join("\n") : "- (not specified)";
}

function isInsidePath(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

function defaultEvidenceRoots() {
  return [
    repoRoot,
    path.join(os.homedir(), "connect-ai-runtime", "company"),
  ];
}

function isSensitiveEvidencePath(file) {
  const normalized = String(file || "").replace(/\\/g, "/");
  if (normalized.includes("/.git/") || normalized.includes("/node_modules/")) return true;
  if (/(^|\/)\.env($|[./])/.test(normalized)) return true;
  if (/(secret|token|credential|cookie|authorization|password|passwd)/i.test(normalized)) return true;
  if (normalized.toLowerCase().includes("/connect-ai-vault/")) return true;
  return false;
}

function trimCandidatePath(value) {
  return String(value || "").trim().replace(/[),.;\]]+$/g, "");
}

function evidencePathCandidates(item) {
  const candidates = [];
  for (const file of Array.isArray(item.files) ? item.files : []) candidates.push(file);
  const text = `${item.resultSummary || ""}\n${item.prompt || ""}`;
  for (const match of text.match(/[A-Za-z]:\\[^\r\n"'<>|]+/g) || []) candidates.push(trimCandidatePath(match));
  for (const match of text.match(/\/mnt\/[a-z]\/[^\r\n"'<>|]+/g) || []) candidates.push(trimCandidatePath(match));
  return [...new Set(candidates.map(trimCandidatePath).filter(Boolean))];
}

function allowedEvidencePath(file, evidenceRoots) {
  const full = path.resolve(file);
  if (isSensitiveEvidencePath(full)) return false;
  const ext = path.extname(full).toLowerCase();
  if (![".js", ".ts", ".json", ".log", ".txt", ".md", ".ps1", ".yaml", ".yml"].includes(ext)) return false;
  if (!evidenceRoots.some((root) => isInsidePath(full, root))) return false;
  try {
    return fs.existsSync(full) && fs.statSync(full).isFile();
  } catch {
    return false;
  }
}

function collectEvidenceSnippets(item, options = {}) {
  const evidenceRoots = (options.evidenceRoots || defaultEvidenceRoots()).map((root) => path.resolve(String(root)));
  const maxFiles = Number(options.maxEvidenceFiles || 6);
  const maxBytes = Number(options.maxEvidenceBytes || 2500);
  const snippets = [];
  for (const candidate of evidencePathCandidates(item)) {
    if (snippets.length >= maxFiles) break;
    if (!allowedEvidencePath(candidate, evidenceRoots)) continue;
    const full = path.resolve(candidate);
    try {
      const stat = fs.statSync(full);
      const content = fs.readFileSync(full, "utf8");
      const limited = content.length > maxBytes ? `${content.slice(0, maxBytes)}\n...[truncated ${stat.size} bytes]` : content;
      snippets.push([
        `### ${full}`,
        "```text",
        redact(limited, maxBytes + 200),
        "```",
      ].join("\n"));
    } catch {
      // Evidence snippets are best-effort; the verifier still receives the source summary.
    }
  }
  return snippets.join("\n\n");
}

function buildVerificationPrompt(item, options = {}) {
  const files = Array.isArray(item.files) && item.files.length
    ? item.files.map((file) => `- ${file}`).join("\n")
    : "- (no explicit files listed)";
  const writeScope = listLines(item.writeScope);
  const expectedTests = listLines(item.expectedTests);
  const evidencePack = collectEvidenceSnippets(item, options);
  return [
    markerFor(item.id),
    "You are a Connect AI read-only verifier.",
    "Do not edit, create, delete, move, send, deploy, authenticate, approve, or mutate queue state.",
    "Do not claim the source task is done unless evidence proves it.",
    "Review the worker result and return Korean markdown with:",
    "1. 검증 판정: accept / reject / needs_human",
    "2. 근거",
    "3. 누락 증거",
    "4. 권장 다음 조치",
    "Use these exact heading labels; do not rename them:",
    "검증 판정: accept|reject|needs_human",
    "근거:",
    "누락 증거:",
    "권장 다음 조치:",
    "",
    `Source task id: ${item.id}`,
    `Source assignee: ${item.assignee}`,
    `Source title: ${item.title}`,
    `Source priority: ${item.priority}`,
    `Source status: ${item.status}`,
    "",
    "Source queue contract:",
    `riskClass: ${item.riskClass || item.risk || "(not specified)"}`,
    `executor: ${item.executor || "(not specified)"}`,
    `reviewer: ${item.reviewer || "(not specified)"}`,
    `rollbackPath: ${item.rollbackPath || "(not specified)"}`,
    "writeScope:",
    writeScope,
    "expectedTests:",
    expectedTests,
    "",
    "Files / write scope:",
    files,
    "",
    "Worker result summary:",
    redact(item.resultSummary || "", 5000),
    ...(evidencePack ? [
      "",
      "Verifier evidence pack:",
      evidencePack,
    ] : []),
  ].join("\n");
}

function selectReviewer(item, index) {
  const requested = getArg("reviewer", "").toLowerCase();
  if (requested === "gemini" || requested === "antigravity") return requested;
  return index % 2 === 0 ? "gemini" : "antigravity";
}

function isUnverifiedDoneCandidate(item) {
  if (!item || item.status !== "done" || item.verifiedAt) return false;
  const validation = validateItem(item);
  return !validation.valid;
}

function verifierDispatchState(queue, sourceOrId) {
  const source = typeof sourceOrId === "object" ? sourceOrId : { id: sourceOrId };
  const sourceId = source.id || "";
  const marker = markerFor(sourceId);
  let blockedWithoutVerdict = 0;
  for (const item of queue) {
    const text = `${item.prompt || ""}\n${item.resultSummary || ""}`;
    if (!text.includes(marker)) continue;
    const verdict = verdictFromSummary(item.resultSummary || "");
    const fresh = isFreshForSource(item, source);
    if (verdict && item.verifiedAt && isVerifierTask(item) && fresh && hasVerifierRequiredEvidence(item)) return { skip: true, reason: "verdict_exists", blockedWithoutVerdict };
    if (isVerifierTask(item) && fresh && ["queued", "copied", "running", "ready_for_verification"].includes(item.status)) {
      return { skip: true, reason: "active_verifier_exists", blockedWithoutVerdict };
    }
    if (
      isVerifierTask(item)
      && fresh
      && (item.status === "blocked" || item.status === "done")
      && !(verdict && hasVerifierRequiredEvidence(item))
    ) blockedWithoutVerdict += 1;
  }
  if (blockedWithoutVerdict >= 2) return { skip: true, reason: "verifier_circuit_breaker", blockedWithoutVerdict };
  return { skip: false, reason: "", blockedWithoutVerdict };
}

function plannedDispatches(queue) {
  const includeUnverifiedDone = hasFlag("include-unverified-done");
  const ready = queue.filter((item) => item.status === "ready_for_verification" || (includeUnverifiedDone && isUnverifiedDoneCandidate(item)));
  const max = Number(getArg("max", "20")) || 20;
  const plans = [];
  for (const item of ready) {
    if (verifierDispatchState(queue, item).skip) continue;
    const reviewer = selectReviewer(item, plans.length);
    plans.push({
      sourceId: item.id,
      reviewer,
      priority: priorityFor(item),
      title: `Verification request: ${item.title}`,
      prompt: buildVerificationPrompt(item),
      files: Array.isArray(item.files) ? item.files : [],
      sourceStatus: item.status,
    });
    if (plans.length >= max) break;
  }
  return plans;
}

function verificationEvidence(queue) {
  return queue
    .filter((item) => item.status === "done" && item.verifiedAt && isVerifierTask(item) && hasVerifierRequiredEvidence(item))
    .map((item) => {
      const sourceId = sourceIdFromText(`${item.prompt || ""}\n${item.resultSummary || ""}`);
      const verdict = verdictFromSummary(item.resultSummary || "");
      return {
        sourceId,
        verifierId: item.id,
        reviewer: item.assignee,
        verdict,
        resultSummary: item.resultSummary || "",
        verifiedAt: item.verifiedAt || "",
        updatedAt: item.updatedAt || item.completedAt || item.createdAt || "",
      };
    })
    .filter((item) => item.sourceId && item.verdict)
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

function closureSummary(source, evidence) {
  const verdictLabel = evidence.verdict === "accept" ? "ACCEPT" : evidence.verdict === "reject" ? "REJECT" : "NEEDS_HUMAN";
  return redact([
    `VERIFIER_${verdictLabel}: ${evidence.reviewer} reviewed ${source.id}.`,
    `Verifier task: ${evidence.verifierId}`,
    `Source task: ${source.id} - ${source.title}`,
    "",
    "Verifier evidence:",
    evidence.resultSummary,
  ].join("\n"), 3000);
}

function plannedClosures(queue) {
  const evidenceBySource = new Map();
  for (const evidence of verificationEvidence(queue)) {
    if (!evidenceBySource.has(evidence.sourceId)) evidenceBySource.set(evidence.sourceId, evidence);
  }
  return queue
    .filter((item) => item.status === "ready_for_verification" || (item.status === "done" && !item.verifiedAt && evidenceBySource.has(item.id)))
    .map((source) => {
      const evidence = evidenceBySource.get(source.id);
      if (!evidence || !isFreshForSource(evidence, source)) return null;
      const targetStatus = evidence.verdict === "accept" ? "done" : "blocked";
      return {
        sourceId: source.id,
        sourceTitle: source.title,
        verifierId: evidence.verifierId,
        reviewer: evidence.reviewer,
        verdict: evidence.verdict,
        targetStatus,
        resultSummary: closureSummary(source, evidence),
      };
    })
    .filter(Boolean);
}

function enqueuePlan(plan) {
  const promptFile = path.join(os.tmpdir(), `connect-ai-verify-${process.pid}-${Date.now()}-${plan.sourceId}.txt`);
  fs.writeFileSync(promptFile, plan.prompt, "utf8");
  try {
    const args = [
      "add",
      "--assignee", plan.reviewer,
      "--priority", plan.priority,
      "--title", plan.title,
      "--prompt-file", promptFile,
      "--risk", "Green",
      "--risk-class", "Green",
      "--executor", "none",
      "--reviewer", plan.reviewer,
      "--intent", "verification",
      "--role", "verifier",
      "--worker-class", "reviewer",
      "--stop-condition", "Stop after one read-only verdict; do not mutate source queue state.",
      "--approval-condition", "Human approval is required before any write, credential access, external send, or source task approval beyond explicit verifier verdict.",
      "--can-write", "false",
      "--approval-required", "false",
      "--write-scope", "read-only",
      ...DEFAULT_FORBIDDEN_PATHS.flatMap((forbidden) => ["--forbidden-path", forbidden]),
      "--expected-test", "reviewer returns explicit 검증 판정: accept|reject|needs_human",
      "--evidence-required", "검증 판정: accept|reject|needs_human",
      "--evidence-required", "근거",
      "--evidence-required", "누락 증거",
      "--rollback-path", "delete verifier queue item before execution",
      "--token-budget", "medium",
      "--retry-budget", "0",
      "--agent-os-status", "QUEUED",
      "--allowed-assignee", plan.reviewer,
    ];
    for (const file of plan.files.slice(0, 20)) args.push("--file", file);
    return runQueue(args);
  } finally {
    try { fs.unlinkSync(promptFile); } catch { /* best effort */ }
  }
}

function main() {
  const execute = hasFlag("execute");
  const listed = runQueue(["list"]);
  if (hasFlag("apply")) {
    const closures = plannedClosures(listed.items || []);
    const applied = [];
    if (execute) {
      for (const plan of closures) {
        const args = [
          "update",
          "--id", plan.sourceId,
          "--status", plan.targetStatus,
          "--result-summary", plan.resultSummary,
        ];
        if (plan.targetStatus === "done") args.push("--verified");
        const updated = runQueue(args);
        applied.push({
          id: updated.item.id,
          status: updated.item.status,
          verifiedAt: updated.item.verifiedAt || "",
          verifierId: plan.verifierId,
          verdict: plan.verdict,
        });
      }
    }
    console.log(JSON.stringify({
      success: true,
      mode: execute ? "apply-execute" : "apply-dry-run",
      queuePath: listed.path,
      readyForVerificationCount: (listed.items || []).filter((item) => item.status === "ready_for_verification").length,
      plannedCount: closures.length,
      plans: closures.map((plan) => ({
        sourceId: plan.sourceId,
        verifierId: plan.verifierId,
        reviewer: plan.reviewer,
        verdict: plan.verdict,
        targetStatus: plan.targetStatus,
      })),
      applied,
    }, null, 2));
    return;
  }
  const plans = plannedDispatches(listed.items || []);
  const enqueued = [];
  if (execute) {
    for (const plan of plans) {
      enqueued.push(enqueuePlan(plan).item);
    }
  }
  console.log(JSON.stringify({
    success: true,
    mode: execute ? "execute" : "dry-run",
    queuePath: listed.path,
    readyForVerificationCount: (listed.items || []).filter((item) => item.status === "ready_for_verification").length,
    plannedCount: plans.length,
      plans: plans.map((plan) => ({
        sourceId: plan.sourceId,
        sourceStatus: plan.sourceStatus,
        reviewer: plan.reviewer,
        priority: plan.priority,
        title: plan.title,
      })),
    enqueued: enqueued.map((item) => ({
      id: item.id,
      assignee: item.assignee,
      status: item.status,
      title: item.title,
    })),
  }, null, 2));
}

if (require.main === module) main();

module.exports = {
  buildVerificationPrompt,
  collectEvidenceSnippets,
  hasVerifierRequiredEvidence,
  markerFor,
  plannedClosures,
  plannedDispatches,
  sourceIdFromText,
  verdictFromSummary,
  verifierDispatchState,
  verificationEvidence,
};
