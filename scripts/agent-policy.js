#!/usr/bin/env node
"use strict";

const AGENT_ROLES = {
  codex: {
    role: "implementer",
    workerClass: "executor",
    canWrite: true,
    canApprove: false,
    autoableRisk: ["Green", "Yellow"],
    label: "Codex Executor",
  },
  claude: {
    role: "implementer",
    workerClass: "executor",
    canWrite: true,
    canApprove: false,
    autoableRisk: ["Green", "Yellow"],
    label: "Claude Executor",
  },
  gemini: {
    role: "reviewer",
    workerClass: "reviewer",
    canWrite: false,
    canApprove: false,
    autoableRisk: ["Green"],
    label: "Gemini Reviewer",
  },
  antigravity: {
    role: "reviewer",
    workerClass: "reviewer",
    canWrite: false,
    canApprove: false,
    autoableRisk: ["Green"],
    label: "Antigravity Reviewer",
  },
  "local-llm": {
    role: "local-smoke",
    workerClass: "local-smoke",
    canWrite: false,
    canApprove: false,
    autoableRisk: ["Green"],
    label: "Local LLM Smoke",
  },
  hermes: {
    role: "researcher",
    workerClass: "observer",
    canWrite: false,
    canApprove: false,
    autoableRisk: [],
    label: "Hermes Observer",
  },
};

const TASK_ROLES = new Set(["implementer", "reviewer", "researcher", "verifier", "local-smoke"]);
const RISK_CLASSES = new Set(["Green", "Yellow", "Red"]);
const DEFAULT_EVIDENCE_REQUIRED = [
  "files changed or no-write confirmation",
  "commands run",
  "current-run expected tests/evidence",
  "unresolved failures",
];

function normalizeAssignee(value) {
  const assignee = String(value || "codex").toLowerCase();
  return AGENT_ROLES[assignee] ? assignee : "codex";
}

function normalizeTaskRole(value, fallback = "implementer") {
  const role = String(value || "").trim().toLowerCase();
  if (TASK_ROLES.has(role)) return role;
  return TASK_ROLES.has(fallback) ? fallback : "implementer";
}

function normalizeStringArray(value) {
  return (Array.isArray(value) ? value : [])
    .map((item) => String(item || "").trim())
    .filter(Boolean);
}

function arraysEqual(left = [], right = []) {
  if (left.length !== right.length) return false;
  return left.every((value, index) => String(value) === String(right[index]));
}

function normalizeNonNegativeInteger(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
}

function defaultStopCondition(item = {}) {
  if (item.role === "verifier") return "Stop after one read-only verdict; do not mutate source queue state.";
  return "Stop when retry budget is exhausted, a forbidden-path policy violation appears, required evidence is missing, or the same failure repeats.";
}

function defaultApprovalCondition(item = {}) {
  const risk = inferRiskClass(item);
  if (risk === "Red" || item.requiresHumanApproval || item.approvalRequired) {
    return "Human approval is required before execution.";
  }
  return "Human approval is required before credential access, deploy/external-send actions, direct vault write, risky write, or write-scope expansion.";
}

function defaultEvidenceRequired(item = {}) {
  if (item.role === "verifier") return ["검증 판정: accept|reject|needs_human", "근거", "누락 증거"];
  return DEFAULT_EVIDENCE_REQUIRED;
}

function defaultExpectedTests(item = {}) {
  if (item.role === "verifier") return ["read-only verifier verdict recorded"];
  if (inferRiskClass(item) === "Green") return ["read-only evidence report from worker"];
  return ["worker result includes files changed, commands run, current-run evidence, and unresolved failures"];
}

function defaultRollbackPath(item = {}) {
  if (inferRiskClass(item) === "Green") return "No file writes expected; discard worker report if evidence is insufficient.";
  const scope = normalizeStringArray(item.writeScope).length ? normalizeStringArray(item.writeScope) : normalizeStringArray(item.files);
  return scope.length
    ? `Revert scoped changes only: ${scope.join(", ")}`
    : "Block before execution if write scope is still ambiguous.";
}

function defaultExecutor(item = {}, assignee = item.assignee) {
  const normalized = normalizeAssignee(assignee);
  const role = AGENT_ROLES[normalized] || {};
  if (role.workerClass === "reviewer") return "read-only-reviewer";
  if (role.workerClass === "local-smoke") return "local-llm-smoke";
  if (role.workerClass === "observer") return "observer-only";
  return normalized;
}

function defaultReviewer(item = {}, assignee = item.assignee) {
  const normalized = normalizeAssignee(assignee);
  if (["gemini", "antigravity"].includes(normalized)) return normalized;
  return inferRiskClass(item) === "Green" ? "gemini-or-antigravity-read-only" : "separate-verifier-required";
}

function inferRiskClass(item = {}) {
  const explicit = String(item.riskClass || "");
  if (RISK_CLASSES.has(explicit)) return explicit;
  const title = String(item.title || "");
  if (/\bRed\b|Decision request:|승인\s*(요청|필요|대기)|harness\s*승인/i.test(title)) return "Red";
  if (/\bYellow\b/i.test(title)) return "Yellow";
  if (/\bGreen\b/i.test(title)) return "Green";
  const text = `${item.title || ""}\n${item.prompt || ""}\n${(item.files || []).join("\n")}`;
  if (isVerificationRequestText(text) && isReadOnlyText(text)) return "Green";
  if (/Decision request:|승인|approval|human[-_\s]?approved|harness|baseline|protected[_-\s]?paths|broker|order|live[-_\s]?trade|token|secret|credential|deploy|send|gmail|google sheets|결제|배포|발송|주문|잔고/i.test(text)) {
    return "Red";
  }
  if (isReadOnlyText(text) && !hasWriteIntentText(text)) return "Green";
  if (/edit|implement|modify|write|파일\s*수정|구현|수정|생성|테스트\s*추가|refactor/i.test(text)) {
    return "Yellow";
  }
  return isReadOnlyText(text) ? "Green" : "Yellow";
}

function isReadOnlyText(text) {
  return /read-?only|읽기\s*전용|파일\s*수정\s*금지|수정\s*금지|do not edit|do not modify|review|audit|검토|감사|분석/i.test(String(text || ""));
}

function hasWriteIntentText(text) {
  const value = String(text || "");
  return /(?:^|\n|[^\w])(?:implement|create|write|build|fix|refactor|add|modify|edit)\b|구현|생성|작성|수정해|유지보수|만들어|추가해|리팩터/i.test(value);
}

function isVerificationRequestText(text) {
  return /Verification request:|\[verify-source:[^\]]+\]|검증\s*요청/i.test(String(text || ""));
}

function defaultAllowedAssignees(item = {}) {
  const riskClass = inferRiskClass(item);
  if (riskClass === "Red") return [];
  if (riskClass === "Green") return ["codex", "claude", "gemini", "antigravity", "local-llm"];
  return ["codex", "claude"];
}

function normalizeContractPath(value) {
  return String(value || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/\/$/g, "")
    .toLowerCase();
}

function pathsOverlap(target, forbidden) {
  const candidate = normalizeContractPath(target);
  const blocked = normalizeContractPath(forbidden);
  if (!candidate || !blocked || candidate === "read-only") return false;
  if (blocked.includes("/") || /^[a-z]:/i.test(blocked)) {
    return candidate === blocked ||
      candidate.startsWith(`${blocked}/`) ||
      blocked.startsWith(`${candidate}/`);
  }
  return candidate.includes(blocked);
}

function forbiddenPathViolations(item = {}) {
  const targets = (Array.isArray(item.writeScope) && item.writeScope.length ? item.writeScope : item.files || [])
    .map(String)
    .filter(Boolean);
  const forbidden = (Array.isArray(item.forbiddenPaths) ? item.forbiddenPaths : [])
    .map(String)
    .filter(Boolean);
  const violations = [];
  for (const target of targets) {
    for (const blocked of forbidden) {
      if (pathsOverlap(target, blocked)) {
        violations.push({ target, forbidden: blocked });
      }
    }
  }
  return violations;
}

function explicitContractFlag(item = {}, primary, legacy, fallback) {
  if (item[primary] !== undefined) return Boolean(item[primary]);
  if (legacy && item[legacy] !== undefined) return Boolean(item[legacy]);
  return Boolean(fallback);
}

function normalizeQueueItem(item = {}) {
  const assignee = normalizeAssignee(item.assignee);
  const assigneeRole = AGENT_ROLES[assignee];
  const riskClass = inferRiskClass(item);
  const allowedAssignees = Array.isArray(item.allowedAssignees) && item.allowedAssignees.length
    ? item.allowedAssignees.map(normalizeAssignee).filter((value, index, arr) => arr.indexOf(value) === index)
    : defaultAllowedAssignees({ ...item, riskClass });
  const files = Array.isArray(item.files) ? item.files : [];
  const writeScope = Array.isArray(item.writeScope) ? item.writeScope : (riskClass === "Green" && files.length === 0 ? ["read-only"] : files);
  const explicitWriteScope = Boolean(
    item.explicitWriteScope ||
    item.writeScopeExplicit ||
    (Array.isArray(item.writeScope) && (!Array.isArray(item.files) || item.files.length === 0 || !arraysEqual(item.writeScope, item.files)))
  );
  const explicitExpectedTests = explicitContractFlag(item, "explicitExpectedTests", "expectedTestsExplicit", normalizeStringArray(item.expectedTests).length);
  const explicitRollbackPath = explicitContractFlag(item, "explicitRollbackPath", "rollbackPathExplicit", String(item.rollbackPath || "").trim());
  const explicitExecutor = explicitContractFlag(item, "explicitExecutor", "executorExplicit", String(item.executor || "").trim());
  const explicitReviewer = explicitContractFlag(item, "explicitReviewer", "reviewerExplicit", String(item.reviewer || "").trim());
  const forbiddenPaths = Array.isArray(item.forbiddenPaths) ? item.forbiddenPaths : [];
  const retryBudget = item.retryBudget === undefined ? undefined : normalizeNonNegativeInteger(item.retryBudget, 0);
  const runAttempts = normalizeNonNegativeInteger(item.runAttempts ?? item.attempts ?? item.executionAttempts, 0);
  return {
    ...item,
    assignee,
    role: normalizeTaskRole(item.role, assigneeRole.role),
    workerClass: item.workerClass || assigneeRole.workerClass,
    riskClass,
    allowedAssignees,
    requiresHumanApproval: Boolean(item.requiresHumanApproval || item.approvalRequired || riskClass === "Red"),
    canWrite: item.canWrite !== undefined ? Boolean(item.canWrite) : Boolean(assigneeRole.canWrite && riskClass !== "Green"),
    writeScope,
    explicitWriteScope,
    explicitExpectedTests,
    explicitRollbackPath,
    explicitExecutor,
    explicitReviewer,
    forbiddenPaths,
    expectedTests: normalizeStringArray(item.expectedTests).length ? normalizeStringArray(item.expectedTests) : defaultExpectedTests({ ...item, riskClass, role: normalizeTaskRole(item.role, assigneeRole.role) }),
    rollbackPath: String(item.rollbackPath || "").trim() || defaultRollbackPath({ ...item, riskClass, writeScope, files }),
    executor: String(item.executor || "").trim() || defaultExecutor({ ...item, riskClass }, assignee),
    reviewer: String(item.reviewer || "").trim() || defaultReviewer({ ...item, riskClass }, assignee),
    ...(retryBudget === undefined ? {} : { retryBudget }),
    runAttempts,
    stopCondition: String(item.stopCondition || "").trim() || defaultStopCondition({ ...item, role: normalizeTaskRole(item.role, assigneeRole.role), riskClass }),
    approvalCondition: String(item.approvalCondition || "").trim() || defaultApprovalCondition({ ...item, riskClass }),
    evidenceRequired: normalizeStringArray(item.evidenceRequired).length ? normalizeStringArray(item.evidenceRequired) : defaultEvidenceRequired({ ...item, role: normalizeTaskRole(item.role, assigneeRole.role) }),
  };
}

function retryBudgetExceeded(item = {}) {
  const retryBudget = item.retryBudget;
  if (retryBudget === undefined) return false;
  const runAttempts = normalizeNonNegativeInteger(item.runAttempts ?? item.attempts ?? item.executionAttempts, 0);
  return runAttempts > normalizeNonNegativeInteger(retryBudget, 0);
}

function missingAutomationContractFields(item = {}) {
  const missing = [];
  if (!String(item.risk || item.riskClass || "").trim()) missing.push("risk");
  if (!normalizeStringArray(item.writeScope).length) missing.push("writeScope");
  if (!normalizeStringArray(item.expectedTests).length || item.explicitExpectedTests === false) missing.push("expectedTests");
  if (!String(item.rollbackPath || "").trim() || item.explicitRollbackPath === false) missing.push("rollbackPath");
  if (!String(item.executor || "").trim() || item.explicitExecutor === false) missing.push("executor");
  if (!String(item.reviewer || "").trim() || item.explicitReviewer === false) missing.push("reviewer");
  return missing;
}

function hasAutomationContract(item = {}) {
  return missingAutomationContractFields(item).length === 0;
}

function canAssigneeRun(item = {}, assignee = item.assignee) {
  const normalized = normalizeQueueItem({ ...item, assignee });
  const role = AGENT_ROLES[normalizeAssignee(assignee)];
  if (!role) return { ok: false, reason: "UNKNOWN_ASSIGNEE" };
  if (normalized.circuitBreaker && normalized.circuitBreaker.open !== false) {
    return {
      ok: false,
      reason: "CIRCUIT_BREAKER_OPEN",
      circuitBreaker: normalized.circuitBreaker,
    };
  }
  if (retryBudgetExceeded(normalized)) {
    return {
      ok: false,
      reason: "RETRY_BUDGET_EXHAUSTED",
      retryBudget: normalized.retryBudget,
      runAttempts: normalized.runAttempts,
    };
  }
  const forbiddenViolations = normalized.canWrite || normalized.explicitWriteScope ? forbiddenPathViolations(normalized) : [];
  if (forbiddenViolations.length) return { ok: false, reason: "FORBIDDEN_WRITE_SCOPE", violations: forbiddenViolations };
  const hasHumanApproval = Boolean(normalized.humanApprovedAt);
  if (normalized.requiresHumanApproval || normalized.riskClass === "Red") {
    if (!hasHumanApproval) return { ok: false, reason: "HUMAN_APPROVAL_REQUIRED" };
    if (role.workerClass !== "executor") return { ok: false, reason: "HUMAN_APPROVED_RED_REQUIRES_EXECUTOR" };
    if (!["codex", "claude"].includes(normalizeAssignee(assignee))) return { ok: false, reason: "HUMAN_APPROVED_RED_ASSIGNEE_NOT_ALLOWED" };
    return { ok: true, reason: "HUMAN_APPROVED_RED_OK" };
  }
  if (normalized.status === "queued" || normalized.status === "copied") {
    const missingContractFields = missingAutomationContractFields(item);
    if (missingContractFields.length) {
      return {
        ok: false,
        reason: "INCOMPLETE_AUTOMATION_CONTRACT",
        missingContractFields,
      };
    }
  }
  if (!normalized.allowedAssignees.includes(normalizeAssignee(assignee))) {
    return { ok: false, reason: "ASSIGNEE_NOT_ALLOWED" };
  }
  if (role.workerClass === "reviewer" && !isReadOnlyText(`${normalized.title || ""}\n${normalized.prompt || ""}`)) {
    return { ok: false, reason: "REVIEWER_REQUIRES_READ_ONLY_TASK" };
  }
  if (!role.autoableRisk.includes(normalized.riskClass)) {
    return { ok: false, reason: "RISK_NOT_AUTOABLE_FOR_ROLE" };
  }
  return { ok: true, reason: "OK" };
}

function scopesConflict(a = {}, b = {}) {
  const aScopes = (a.writeScope && a.writeScope.length ? a.writeScope : a.files || []).map(String).filter(Boolean);
  const bScopes = (b.writeScope && b.writeScope.length ? b.writeScope : b.files || []).map(String).filter(Boolean);
  const aBroadWrite = !aScopes.length && (a.canWrite || inferRiskClass(a) === "Yellow");
  const bBroadWrite = !bScopes.length && (b.canWrite || inferRiskClass(b) === "Yellow");
  if (aBroadWrite || bBroadWrite) return true;
  if (!aScopes.length || !bScopes.length) return false;
  return aScopes.some((left) => bScopes.some((right) => {
    const l = left.toLowerCase();
    const r = right.toLowerCase();
    if (l === r || l.startsWith(`${r}\\`) || r.startsWith(`${l}\\`) || l.startsWith(`${r}/`) || r.startsWith(`${l}/`)) return true;
    const leftDir = l.includes("/") || l.includes("\\") ? l.replace(/[\\/][^\\/]*$/, "") : "";
    const rightDir = r.includes("/") || r.includes("\\") ? r.replace(/[\\/][^\\/]*$/, "") : "";
    return Boolean(leftDir && rightDir && leftDir === rightDir);
  }));
}

module.exports = {
  AGENT_ROLES,
  RISK_CLASSES,
  TASK_ROLES,
  canAssigneeRun,
  defaultApprovalCondition,
  defaultAllowedAssignees,
  defaultEvidenceRequired,
  defaultStopCondition,
  forbiddenPathViolations,
  inferRiskClass,
  isVerificationRequestText,
  isReadOnlyText,
  hasAutomationContract,
  missingAutomationContractFields,
  normalizeAssignee,
  normalizeNonNegativeInteger,
  normalizeTaskRole,
  normalizeQueueItem,
  retryBudgetExceeded,
  scopesConflict,
};
