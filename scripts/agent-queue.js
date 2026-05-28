#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { AGENT_ROLES, canAssigneeRun, normalizeQueueItem, normalizeTaskRole } = require("./agent-policy.js");
const { validateItem } = require("./result-validator.js");
const envPaths = require("./env-paths.js");

const allowedAssignees = new Set(Object.keys(AGENT_ROLES));
const allowedStatuses = new Set(["queued", "copied", "running", "ready_for_verification", "done", "blocked"]);
const allowedPriorities = new Set(["P0", "P1", "P2"]);
const priorityRank = { P0: 0, P1: 1, P2: 2 };

function isWsl() {
  return process.platform === "linux" && fs.existsSync("/mnt/c");
}

function defaultStorageRoot() {
  if (process.env.CONNECT_AI_AGENT_QUEUE) return path.dirname(envPaths.toNative(process.env.CONNECT_AI_AGENT_QUEUE));
  return path.dirname(envPaths.agentQueuePath());
}

function queuePath() {
  return process.env.CONNECT_AI_AGENT_QUEUE ? envPaths.toNative(process.env.CONNECT_AI_AGENT_QUEUE) : path.join(defaultStorageRoot(), "agent-queue.json");
}

function lockPath() {
  return `${queuePath()}.lock`;
}

function eventLogPath() {
  return path.join(path.dirname(queuePath()), "agent-queue-events.jsonl");
}

function workerStatusPath() {
  return path.join(path.dirname(queuePath()), "worker-status.json");
}

function reportDir() {
  return path.join(path.dirname(queuePath()), "reports");
}

function redact(text, maxLen = 8000) {
  let value = String(text ?? "");
  value = value.replace(/\b((?:token|secret|password|passwd|api[_-]?key|client[_-]?secret|authorization|cookie|localStorage)\b\s*[:=]\s*)["']?[^"'\s,}]+/gi, "$1<redacted>");
  value = value.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi, "Bearer <redacted>");
  value = value.trim();
  return value.length > maxLen ? `${value.slice(0, maxLen)}\n...[truncated]` : value;
}

function queueBackupPath() {
  return `${queuePath()}.bak`;
}

function readQueue() {
  const file = queuePath();
  let rawText = "";
  try {
    rawText = fs.readFileSync(file, "utf8");
  } catch {
    return []; // 파일 자체가 없음 = 정상 초기상태
  }
  // 빈 파일이면 빈 큐
  if (!rawText.trim()) return [];
  try {
    const parsed = JSON.parse(rawText);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    // ★ 큐 파일이 손상됨. 빈 배열로 덮어쓰면 전체 유실되므로 백업에서 복구 시도.
    try {
      const bakText = fs.readFileSync(queueBackupPath(), "utf8");
      const bak = JSON.parse(bakText);
      if (Array.isArray(bak)) {
        // 손상본을 .corrupt로 보존하고 백업을 복구
        try { fs.copyFileSync(file, `${file}.corrupt-${Date.now()}`); } catch { /* */ }
        process.stderr.write(`[agent-queue] WARNING: queue file corrupted, recovered ${bak.length} items from backup\n`);
        return bak;
      }
    } catch { /* 백업도 없거나 깨짐 */ }
    // 복구 불가 — 손상본 보존 후 명확히 에러(빈 배열로 덮어쓰지 않음)
    try { fs.copyFileSync(file, `${file}.corrupt-${Date.now()}`); } catch { /* */ }
    throw new Error(`agent-queue: queue file is corrupted and no valid backup exists: ${file} (${e.message}). Corrupt copy saved.`);
  }
}

function writeQueue(items) {
  const file = queuePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const payload = `${JSON.stringify(items, null, 2)}\n`;
  // ★ 원자적 쓰기: temp에 쓰고 fsync 후 rename. 쓰기 도중 크래시해도 원본 보존.
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    const fd = fs.openSync(tmp, "w");
    try {
      fs.writeFileSync(fd, payload, "utf8");
      try { fs.fsyncSync(fd); } catch { /* fsync 미지원 환경 무시 */ }
    } finally {
      fs.closeSync(fd);
    }
    // 쓰기 직전의 유효한 원본을 백업으로 보존(다음 손상 시 복구용)
    try { if (fs.existsSync(file)) fs.copyFileSync(file, queueBackupPath()); } catch { /* */ }
    // 원자적 교체
    fs.renameSync(tmp, file);
    // 방금 성공적으로 쓴 최신 유효본도 백업에 반영(백업 최신성 향상)
    try { fs.copyFileSync(file, queueBackupPath()); } catch { /* */ }
  } catch (e) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* */ }
    throw e;
  }
}

function appendEvent(event) {
  try {
    const file = eventLogPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const payload = {
      ts: new Date().toISOString(),
      ...event,
    };
    fs.appendFileSync(file, `${JSON.stringify(payload)}\n`, "utf8");
  } catch {
    // Queue state is primary. Ledger writes are best-effort so coordination cannot stall.
  }
}

function readWorkerStatus() {
  try {
    const parsed = JSON.parse(fs.readFileSync(workerStatusPath(), "utf8") || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeWorkerStatus(status) {
  const file = workerStatusPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(status, null, 2)}\n`, "utf8");
}

function updateWorkerStatus(assignee, patch) {
  if (!allowedAssignees.has(assignee)) return;
  const role = AGENT_ROLES[assignee] || {};
  const status = readWorkerStatus();
  status[assignee] = {
    agent: assignee,
    workerClass: role.workerClass || "worker",
    label: role.label || assignee,
    status: "idle",
    phase: "idle",
    message: "",
    taskId: "",
    taskTitle: "",
    updatedAt: new Date().toISOString(),
    ...status[assignee],
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  writeWorkerStatus(status);
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// 락 stale 판정: 같은 호스트면 pid 생존 확인, 크로스 플랫폼(WSL<->Windows)이라
// pid를 신뢰할 수 없으면 나이(age) 기준으로 회수. 둘 다 만족 못 하면 보존.
const LOCK_STALE_MS = 60000; // 60초 이상 된 락은 죽은 것으로 간주(크로스 플랫폼 안전장치)

function lockOwnerAlive(meta) {
  if (!meta || typeof meta.pid !== "number") return false;
  // host가 다르면(WSL vs Windows) pid 비교 무의미 → 살아있다고 단정 못 함
  if (meta.host && meta.host !== lockHostId()) return false;
  try {
    process.kill(meta.pid, 0); // 신호 0 = 존재 확인만
    return true;
  } catch (e) {
    return e.code === "EPERM"; // 권한오류면 존재는 함
  }
}

function lockHostId() {
  // WSL과 Windows를 구분하는 안정적 식별자
  return process.platform === "linux"
    ? `wsl:${process.env.WSL_DISTRO_NAME || "linux"}`
    : `win:${process.env.COMPUTERNAME || "windows"}`;
}

function tryReclaimStaleLock(file) {
  try {
    const raw = fs.readFileSync(file, "utf8");
    const meta = JSON.parse(raw);
    const ageMs = Date.now() - (meta.ts ? new Date(meta.ts).getTime() : 0);
    const sameHost = meta.host === lockHostId();
    // 같은 호스트: pid 죽었으면 회수. 다른 호스트/불명: 나이로 회수.
    const ownerDead = sameHost ? !lockOwnerAlive(meta) : true;
    if (ownerDead && ageMs > LOCK_STALE_MS) {
      fs.unlinkSync(file);
      return true; // 회수함
    }
    // 같은 호스트인데 pid가 죽었으면 나이 무관 즉시 회수
    if (sameHost && !lockOwnerAlive(meta)) {
      fs.unlinkSync(file);
      return true;
    }
  } catch {
    // 락 파일이 깨졌더라도 오래된 파일이면 죽은 락으로 간주해 회수한다.
    // 방금 생성 중인 lock과 경합하지 않도록 mtime이 충분히 오래된 경우만 삭제.
    try {
      const stat = fs.statSync(file);
      if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
        fs.unlinkSync(file);
        return true;
      }
    } catch {
      // 사라진 lock이면 다음 루프에서 재시도한다.
    }
  }
  return false;
}

function withQueueLock(fn) {
  const file = lockPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const started = Date.now();
  let fd = null;
  let reclaimAttempted = false;
  while (Date.now() - started < 10000) { // 타임아웃 5s -> 10s
    try {
      fd = fs.openSync(file, "wx");
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, host: lockHostId(), ts: new Date().toISOString() }));
      break;
    } catch {
      // 락이 막혀있으면 stale 여부 확인 후 회수 시도
      if (tryReclaimStaleLock(file)) {
        continue; // 회수 성공 → 즉시 재시도
      }
      // 한 번은 강제로 stale 검사(첫 충돌 직후)
      if (!reclaimAttempted) { reclaimAttempted = true; tryReclaimStaleLock(file); }
      sleep(50);
    }
  }
  if (fd === null) {
    // 마지막 시도: 명백히 죽은 락이면 강제 회수 후 1회 재시도
    if (tryReclaimStaleLock(file)) {
      try {
        fd = fs.openSync(file, "wx");
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, host: lockHostId(), ts: new Date().toISOString() }));
      } catch { /* 그래도 실패 */ }
    }
    if (fd === null) throw new Error(`agent queue lock timeout: ${file}`);
  }
  try {
    return fn();
  } finally {
    try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(file); } catch {}
  }
}

function cliError(message, exitCode = 2) {
  const error = new Error(message);
  error.exitCode = exitCode;
  return error;
}

function printCliError(error) {
  console.error(error.message || String(error));
  process.exit(error.exitCode || 1);
}

function canForcePolicyBypass(reason) {
  return !new Set(["FORBIDDEN_WRITE_SCOPE", "HUMAN_APPROVAL_REQUIRED", "INCOMPLETE_AUTOMATION_CONTRACT"]).has(String(reason || ""));
}

function policyBlockSummary(prefix, allowed) {
  const missing = Array.isArray(allowed?.missingContractFields) && allowed.missingContractFields.length
    ? `: missing ${allowed.missingContractFields.join(", ")}`
    : "";
  return `${prefix}: ${allowed.reason}${missing}`;
}

function failureFingerprint(summary = "") {
  const text = String(summary || "").trim();
  if (!text) return "";
  const tokens = [...text.matchAll(/\b[A-Z][A-Z0-9_]{3,}\b/g)]
    .map((match) => match[0])
    .filter((token) => !new Set(["BLOCKED", "READY_FOR_VERIFICATION", "DONE", "FAILED", "ERROR", "EXIT"]).has(token));
  if (tokens.length) return tokens[0];
  return text.toLowerCase().replace(/\s+/g, " ").slice(0, 180);
}

function recordBlockedFailure(item) {
  const failure = failureFingerprint(item.resultSummary);
  if (!failure) return;
  const previous = item.lastFailureFingerprint || "";
  item.lastFailureFingerprint = failure;
  item.failureRepeatCount = previous === failure
    ? Math.max(1, Number(item.failureRepeatCount) || 1) + 1
    : 1;
  if (item.failureRepeatCount >= 2) {
    item.circuitBreaker = {
      open: true,
      reason: "SAME_FAILURE_REPEATED",
      failure,
      repeatCount: item.failureRepeatCount,
      openedAt: new Date().toISOString(),
    };
    if (!/CIRCUIT_BREAKER/i.test(item.resultSummary || "")) {
      item.resultSummary = redact(`CIRCUIT_BREAKER: Same failure repeated twice (${failure}). ${item.resultSummary || ""}`, 3000);
    }
  }
}

function getArg(name, fallback = "") {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return fallback;
  return process.argv[idx + 1] || fallback;
}

function getMultiArg(name) {
  const values = [];
  for (let i = 0; i < process.argv.length; i += 1) {
    if (process.argv[i] === `--${name}` && process.argv[i + 1]) values.push(process.argv[i + 1]);
  }
  return values;
}

function getOptionalBooleanArg(name) {
  const value = getArg(name);
  if (!value) {
    return process.argv.includes(`--${name}`) ? true : undefined;
  }
  if (/^(true|1|yes|y)$/i.test(value)) return true;
  if (/^(false|0|no|n)$/i.test(value)) return false;
  return undefined;
}

function getOptionalIntegerArg(name) {
  const value = getArg(name);
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parsePrompt() {
  const promptFile = getArg("prompt-file");
  if (promptFile) return fs.readFileSync(promptFile, "utf8");
  return getArg("prompt");
}

function addItem() {
  let result;
  try {
    result = withQueueLock(() => {
    const now = new Date().toISOString();
    const assignee = getArg("assignee", "codex").toLowerCase();
    const priority = getArg("priority", "P1").toUpperCase();
    const risk = getArg("risk") || getArg("risk-class");
    const explicitRole = getArg("role");
    const writeScope = getMultiArg("write-scope").map((f) => redact(f, 220)).slice(0, 20);
    const forbiddenPaths = getMultiArg("forbidden-path").map((f) => redact(f, 220)).slice(0, 20);
    const expectedTests = [
      ...getMultiArg("expected-test"),
      ...getMultiArg("expected-tests"),
    ].map((value) => redact(value, 500)).slice(0, 20);
    const evidenceRequired = [
      ...getMultiArg("evidence-required"),
      ...getMultiArg("evidence"),
    ].map((value) => redact(value, 500)).slice(0, 20);
    const retryBudget = getOptionalIntegerArg("retry-budget");
    const canWrite = getOptionalBooleanArg("can-write");
    const approvalRequired = getOptionalBooleanArg("approval-required");
    const allowedAssigneeArgs = getMultiArg("allowed-assignee");
    const draft = {
      id: getArg("id") || `aq-${now.replace(/[-:.TZ]/g, "").slice(0, 14)}-${crypto.randomBytes(3).toString("hex")}`,
      title: redact(getArg("title", "Untitled task"), 180),
      assignee: allowedAssignees.has(assignee) ? assignee : "codex",
      status: "queued",
      priority: allowedPriorities.has(priority) ? priority : "P1",
      files: getMultiArg("file").map((f) => redact(f, 220)).slice(0, 20),
      prompt: redact(parsePrompt(), 12000),
      resultSummary: "",
      createdAt: now,
      updatedAt: now,
    };
    if (risk) {
      draft.risk = redact(risk, 60);
      draft.riskClass = redact(risk, 60);
    }
    if (writeScope.length) {
      draft.writeScope = writeScope;
      draft.explicitWriteScope = true;
    }
    if (forbiddenPaths.length) draft.forbiddenPaths = forbiddenPaths;
    if (expectedTests.length) draft.expectedTests = expectedTests;
    if (evidenceRequired.length) draft.evidenceRequired = evidenceRequired;
    if (getArg("rollback-path")) draft.rollbackPath = redact(getArg("rollback-path"), 1000);
    if (getArg("stop-condition")) draft.stopCondition = redact(getArg("stop-condition"), 1000);
    if (getArg("approval-condition")) draft.approvalCondition = redact(getArg("approval-condition"), 1000);
    if (getArg("executor")) draft.executor = redact(getArg("executor"), 120);
    if (getArg("reviewer")) draft.reviewer = redact(getArg("reviewer"), 120);
    if (getArg("intent")) draft.intent = redact(getArg("intent"), 120);
    if (explicitRole) draft.role = normalizeTaskRole(explicitRole, (AGENT_ROLES[draft.assignee] || {}).role);
    if (getArg("worker-class")) draft.workerClass = redact(getArg("worker-class"), 80);
    if (getArg("token-budget")) draft.tokenBudget = redact(getArg("token-budget"), 80);
    if (retryBudget !== undefined) draft.retryBudget = retryBudget;
    if (canWrite !== undefined) draft.canWrite = canWrite;
    if (approvalRequired !== undefined) draft.approvalRequired = approvalRequired;
    if (allowedAssigneeArgs.length) draft.allowedAssignees = allowedAssigneeArgs.map((value) => redact(value, 80));
    if (getArg("agent-os-status")) draft.agentOsStatus = redact(getArg("agent-os-status"), 80);
    const item = normalizeQueueItem(draft);
    if (!item.prompt) {
      throw cliError("agent-queue add requires --prompt or --prompt-file", 2);
    }
    const queue = readQueue();
    queue.push(item);
    writeQueue(queue);
    appendEvent({
      type: "task.added",
      id: item.id,
      assignee: item.assignee,
      status: item.status,
      priority: item.priority,
      title: item.title,
    });
    return { success: true, path: queuePath(), item };
    });
  } catch (error) {
    printCliError(error);
  }
  console.log(JSON.stringify(result, null, 2));
}

function updateItem() {
  const id = getArg("id");
  if (!id) {
    console.error("agent-queue update requires --id");
    process.exit(2);
  }
  let result;
  try {
    result = withQueueLock(() => {
    const queue = readQueue();
    const item = queue.find((q) => q.id === id);
    if (!item) {
      throw cliError(`agent-queue item not found: ${id}`, 1);
    }
    const status = getArg("status");
    const resultSummary = getArg("result-summary");
    const humanApproved = process.argv.includes("--human-approved");
    const verified = process.argv.includes("--verified");

    // === Hermes 환각 견제 가드 ===
    // 사람 승인이 필요한 작업(Decision request / 고위험 프로젝트)을 LLM이 임의로
    // done 처리하는 것을 차단한다. 이번에 Hermes가 "사용자 승인 반영 완료"라고
    // 환각으로 적고 주식 harness를 무단 변경한 사고를 막기 위함.
    const titleText = String(item.title || "");
    const needsHumanApproval =
      /^Decision request:/i.test(titleText) ||
      /승인\s*(요청|필요|대기|반영|처리|결정)|사용자\s*승인|human\s+approval|approval\s*(request|required|gate|decision)|harness|baseline|protected[_-]?paths|broker|order|live[_-]?trade/i.test(titleText);
    const claimsApproval = /승인\s*(반영|완료|받음|득)|approved|approval\s*(granted|complete)|사용자가?\s*승인/i.test(String(resultSummary || ""));

    if (status === "done" && needsHumanApproval && !humanApproved) {
      return {
        success: false,
        blocked_by_guard: true,
        __exitCode: 3,
        reason: "HUMAN_APPROVAL_REQUIRED",
        message: "이 작업은 사람 승인이 필요합니다. --human-approved 플래그 없이는 done 처리할 수 없습니다. (Hermes 환각 견제)",
        title: item.title,
        hint: "사람이 직접 검토 후, 승인 시에만 '--human-approved'를 붙여 실행하세요.",
      };
    }
    if (claimsApproval && !humanApproved) {
      return {
        success: false,
        blocked_by_guard: true,
        __exitCode: 3,
        reason: "FABRICATED_APPROVAL_DETECTED",
        message: "result-summary가 사용자 승인을 주장하지만 --human-approved 플래그가 없습니다. LLM이 승인을 환각했을 가능성. 차단됨.",
        title: item.title,
      };
    }
    // === 가드 끝 ===

    if (status) item.status = allowedStatuses.has(status) ? status : item.status;
    if (resultSummary) item.resultSummary = redact(resultSummary, 3000);
    if (humanApproved) item.humanApprovedAt = new Date().toISOString();
    if (verified) item.verifiedAt = new Date().toISOString();
    const normalizedBeforeClose = normalizeQueueItem(item);
    if (item.status === "done" && !verified) {
      item.status = "ready_for_verification";
      item.resultSummary = `READY_FOR_VERIFICATION: ${item.resultSummary || "Worker reported success; separate verifier must confirm before DONE."}`;
    }
    if (item.status === "ready_for_verification") item.agentOsStatus = "READY_FOR_VERIFICATION";
    else if (item.status === "done") item.agentOsStatus = "DONE";
    else if (item.status === "blocked") item.agentOsStatus = "BLOCKED";
    else if (item.status === "running") item.agentOsStatus = "RUNNING";
    else if (item.status === "queued") item.agentOsStatus = "QUEUED";
    else if (item.status === "copied") item.agentOsStatus = "COPIED";
    item.updatedAt = new Date().toISOString();
    if (item.status === "done" || item.status === "blocked") item.completedAt = item.updatedAt;
    if (item.status === "ready_for_verification") delete item.completedAt;
    if (item.status === "blocked") recordBlockedFailure(item);
    Object.assign(item, normalizeQueueItem(item));
    const validation = item.status === "done" || item.status === "ready_for_verification"
      ? validateItem(item)
      : { valid: true, findings: [], missingEvidence: [] };
    const evidenceBlocked = validation.findings.includes("MISSING_REQUIRED_EVIDENCE");
    if (evidenceBlocked) {
      const previousSummary = item.resultSummary || "";
      item.status = "blocked";
      item.agentOsStatus = "BLOCKED";
      item.resultSummary = redact(`BLOCKED: Missing required evidence: ${validation.missingEvidence.join(", ")}. Previous summary: ${previousSummary}`, 3000);
      item.completedAt = item.updatedAt;
      Object.assign(item, normalizeQueueItem(item));
    }
    writeQueue(queue);
    if (item.status === "done" || item.status === "blocked" || item.status === "ready_for_verification") {
      updateWorkerStatus(item.assignee, {
        status: item.status,
        phase: item.status,
        message: item.resultSummary || `${item.status}: ${item.title}`,
        taskId: item.id,
        taskTitle: item.title,
      });
    }
    appendEvent({
      type: "task.updated",
      id: item.id,
      assignee: item.assignee,
      status: item.status,
      priority: item.priority,
      resultSummary: item.resultSummary ? redact(item.resultSummary, 500) : "",
    });
    if (evidenceBlocked) {
      return {
        success: false,
        path: queuePath(),
        reason: "MISSING_REQUIRED_EVIDENCE",
        missingEvidence: validation.missingEvidence,
        item,
      };
    }
    return { success: true, path: queuePath(), item };
    });
  } catch (error) {
    printCliError(error);
  }
  const exitCode = result && result.__exitCode ? result.__exitCode : 0;
  if (result && result.__exitCode) delete result.__exitCode;
  console.log(JSON.stringify(result, null, 2));
  if (exitCode) process.exit(exitCode);
}

function listItems() {
  const status = getArg("status");
  let items = readQueue();
  if (status) items = items.filter((item) => item.status === status);
  console.log(JSON.stringify({ success: true, path: queuePath(), count: items.length, items }, null, 2));
}

function getItem() {
  const id = getArg("id");
  if (!id) {
    console.error("agent-queue get requires --id");
    process.exit(2);
  }
  const items = readQueue();
  const item = items.find((q) => q.id === id);
  if (!item) {
    console.error(`agent-queue item not found: ${id}`);
    process.exit(1);
  }
  // Return compact view with redacted sensitive fields
  const compactItem = {
    id: item.id,
    title: item.title,
    assignee: item.assignee,
    status: item.status,
    priority: item.priority,
    files: Array.isArray(item.files) ? item.files : [],
    resultSummary: item.resultSummary || "",
    createdAt: item.createdAt || "",
    updatedAt: item.updatedAt || item.createdAt || "",
  };
  if (item.claimedBy) compactItem.claimedBy = item.claimedBy;
  if (item.claimedAt) compactItem.claimedAt = item.claimedAt;
  if (item.completedAt) compactItem.completedAt = item.completedAt;
  if (item.workerClass) compactItem.workerClass = item.workerClass;
  compactItem.role = item.role || (AGENT_ROLES[item.assignee] || {}).role || "";
  if (item.riskClass) compactItem.riskClass = item.riskClass;
  if (item.risk) compactItem.risk = item.risk;
  if (item.executor) compactItem.executor = item.executor;
  if (item.reviewer) compactItem.reviewer = item.reviewer;
  if (item.intent) compactItem.intent = item.intent;
  if (item.writeScope) compactItem.writeScope = item.writeScope;
  if (item.explicitWriteScope) compactItem.explicitWriteScope = item.explicitWriteScope;
  if (item.forbiddenPaths) compactItem.forbiddenPaths = item.forbiddenPaths;
  if (item.expectedTests) compactItem.expectedTests = item.expectedTests;
  if (item.rollbackPath) compactItem.rollbackPath = item.rollbackPath;
  if (item.stopCondition) compactItem.stopCondition = item.stopCondition;
  if (item.approvalCondition) compactItem.approvalCondition = item.approvalCondition;
  if (item.evidenceRequired) compactItem.evidenceRequired = item.evidenceRequired;
  if (item.tokenBudget) compactItem.tokenBudget = item.tokenBudget;
  if (item.retryBudget !== undefined) compactItem.retryBudget = item.retryBudget;
  if (item.runAttempts !== undefined) compactItem.runAttempts = item.runAttempts;
  if (item.agentOsStatus) compactItem.agentOsStatus = item.agentOsStatus;
  if (item.requiresHumanApproval) compactItem.requiresHumanApproval = item.requiresHumanApproval;
  
  console.log(JSON.stringify({ success: true, path: queuePath(), item: compactItem }, null, 2));
}

function claimItem() {
  let result;
  try {
    result = withQueueLock(() => {
    const assignee = getArg("assignee", "").toLowerCase();
    const worker = redact(getArg("worker", assignee || "worker"), 120);
    const requestedId = getArg("id", "");
    if (!allowedAssignees.has(assignee)) {
      throw cliError("agent-queue claim requires --assignee codex|claude|hermes|gemini|antigravity|local-llm", 2);
    }
    const queue = readQueue();
    // Prioritize copied tasks over queued tasks to prevent deadlocks
    const candidates = queue
      .filter((item) => item.assignee === assignee && (item.status === "copied" || item.status === "queued"))
      .filter((item) => !requestedId || item.id === requestedId)
      .sort((a, b) => {
        // Copied tasks always come before queued tasks
        if (a.status === "copied" && b.status !== "copied") return -1;
        if (a.status !== "copied" && b.status === "copied") return 1;
        const byPriority = (priorityRank[a.priority] ?? 9) - (priorityRank[b.priority] ?? 9);
        if (byPriority !== 0) return byPriority;
        return String(a.createdAt || "").localeCompare(String(b.createdAt || ""));
      });
    const item = candidates[0];
    if (!item) {
      return { success: true, path: queuePath(), claimed: false, item: null, message: requestedId ? `No queued or copied task ${requestedId} for ${assignee}.` : `No queued or copied task for ${assignee}.` };
    }
    const previousStatus = item.status;
    const allowed = canAssigneeRun(item, assignee);
    const force = process.argv.includes("--force");
    if (!allowed.ok && (!force || !canForcePolicyBypass(allowed.reason))) {
      item.status = "blocked";
      item.resultSummary = policyBlockSummary("Claim blocked by policy", allowed);
      item.updatedAt = new Date().toISOString();
      item.completedAt = item.updatedAt;
      Object.assign(item, normalizeQueueItem(item));
      writeQueue(queue);
      updateWorkerStatus(assignee, {
        status: "blocked",
        phase: "policy",
        message: item.resultSummary,
        taskId: item.id,
        taskTitle: item.title,
      });
      return { success: false, path: queuePath(), claimed: false, blocked: true, reason: allowed.reason, missingContractFields: allowed.missingContractFields || [], item };
    }
    item.status = "running";
    item.runAttempts = (Number.isFinite(Number(item.runAttempts)) ? Math.max(0, Math.floor(Number(item.runAttempts))) : 0) + 1;
    item.claimedBy = worker;
    item.claimedAt = new Date().toISOString();
    item.updatedAt = item.claimedAt;
    Object.assign(item, normalizeQueueItem(item));
    if (previousStatus === "copied") {
      item.recoveredFromStatus = "copied";
    }
    writeQueue(queue);
    updateWorkerStatus(assignee, {
      status: "running",
      phase: "claimed",
      message: `Running ${item.priority} ${item.title}`,
      taskId: item.id,
      taskTitle: item.title,
      claimedBy: worker,
    });
    appendEvent({
      type: previousStatus === "copied" ? "task.copied_claimed" : "task.claimed",
      id: item.id,
      assignee: item.assignee,
      status: item.status,
      priority: item.priority,
      worker,
    });
    return { success: true, path: queuePath(), claimed: true, item };
    });
  } catch (error) {
    printCliError(error);
  }
  console.log(JSON.stringify(result, null, 2));
}

function claimCopiedItem() {
  let result;
  try {
    result = withQueueLock(() => {
    const assignee = getArg("assignee", "").toLowerCase();
    const worker = redact(getArg("worker", assignee || "worker"), 120);
    if (!allowedAssignees.has(assignee)) {
      throw cliError("agent-queue claim-copied requires --assignee codex|claude|hermes|gemini|antigravity|local-llm", 2);
    }
    const queue = readQueue();
    const candidates = queue
      .filter((item) => item.assignee === assignee && item.status === "copied")
      .sort((a, b) => {
        const byPriority = (priorityRank[a.priority] ?? 9) - (priorityRank[b.priority] ?? 9);
        if (byPriority !== 0) return byPriority;
        return String(a.createdAt || "").localeCompare(String(b.createdAt || ""));
      });
    const item = candidates[0];
    if (!item) {
      return { success: true, path: queuePath(), claimed: false, item: null, message: `No copied task for ${assignee}.` };
    }
    const allowed = canAssigneeRun(item, assignee);
    const force = process.argv.includes("--force");
    if (!allowed.ok && (!force || !canForcePolicyBypass(allowed.reason))) {
      item.status = "blocked";
      item.resultSummary = policyBlockSummary("Claim-copied blocked by policy", allowed);
      item.updatedAt = new Date().toISOString();
      item.completedAt = item.updatedAt;
      Object.assign(item, normalizeQueueItem(item));
      writeQueue(queue);
      updateWorkerStatus(assignee, {
        status: "blocked",
        phase: "policy",
        message: item.resultSummary,
        taskId: item.id,
        taskTitle: item.title,
      });
      appendEvent({
        type: "task.claim_copied_blocked",
        id: item.id,
        assignee: item.assignee,
        status: item.status,
        priority: item.priority,
        worker,
        reason: allowed.reason,
      });
      return { success: false, path: queuePath(), claimed: false, blocked: true, reason: allowed.reason, missingContractFields: allowed.missingContractFields || [], item };
    }
    item.status = "running";
    item.runAttempts = (Number.isFinite(Number(item.runAttempts)) ? Math.max(0, Math.floor(Number(item.runAttempts))) : 0) + 1;
    item.claimedBy = worker;
    item.claimedAt = new Date().toISOString();
    item.updatedAt = item.claimedAt;
    Object.assign(item, normalizeQueueItem(item));
    writeQueue(queue);
    updateWorkerStatus(assignee, {
      status: "running",
      phase: "claimed",
      message: `Running copied task ${item.title}`,
      taskId: item.id,
      taskTitle: item.title,
      claimedBy: worker,
    });
    appendEvent({
      type: "task.copied_claimed",
      id: item.id,
      assignee: item.assignee,
      status: item.status,
      priority: item.priority,
      worker,
    });
    return { success: true, path: queuePath(), claimed: true, item };
    });
  } catch (error) {
    printCliError(error);
  }
  console.log(JSON.stringify(result, null, 2));
}

function hasResidualRisk(item) {
  if (!item || item.status !== "done") return false;
  if (item.assignee === "hermes" && /^Decision request:/i.test(String(item.title || ""))) return false;
  const summary = String(item.resultSummary || "");
  if (!summary) return false;
  return /READY WITH RISKS|남은\s*리스크|리스크\s*\d+건|residual\s+risk|remaining\s+risk|follow-?up|후속|판단\s*필요|명령\s*필요/i.test(summary);
}

function decisionMarker(sourceTaskId) {
  return `[decision-source:${sourceTaskId}]`;
}

function hasDecisionRequestTask(items, sourceTaskId) {
  const marker = decisionMarker(sourceTaskId);
  return items.some((item) => String(item.prompt || "").includes(marker) || String(item.resultSummary || "").includes(marker));
}

function buildDecisionRequests(items) {
  return items
    .filter(hasResidualRisk)
    .map((item) => ({
      sourceTaskId: item.id,
      sourceTitle: item.title,
      sourceAssignee: item.assignee,
      priority: item.priority === "P0" ? "P0" : "P1",
      reason: "completed_task_reported_residual_risk",
      alreadyEscalated: hasDecisionRequestTask(items, item.id),
      resultSummary: redact(item.resultSummary || "", 700),
    }));
}

function createDecisionRequestTask(request, worker) {
  const now = new Date().toISOString();
  const marker = decisionMarker(request.sourceTaskId);
  return {
    id: `aq-${now.replace(/[-:.TZ]/g, "").slice(0, 14)}-${crypto.randomBytes(3).toString("hex")}`,
    title: `Decision request: ${request.sourceTitle}`,
    assignee: "hermes",
    role: "researcher",
    stopCondition: "Stop after reporting the decision request; do not create implementation work.",
    approvalCondition: "Human approval is required before converting this decision request into execution.",
    evidenceRequired: ["source task id", "residual risk summary", "requested human decision"],
    status: "queued",
    priority: request.priority,
    files: [],
    prompt: redact([
      `${marker}`,
      "A completed worker task reported residual risks or follow-up uncertainty.",
      "Report this to the user and ask for the next command before creating more implementation work.",
      `Source task: ${request.sourceTaskId} - ${request.sourceTitle}`,
      `Source assignee: ${request.sourceAssignee}`,
      `Summary: ${request.resultSummary}`,
      `Escalated by: ${worker}`,
    ].join("\n"), 12000),
    resultSummary: "",
    createdAt: now,
    updatedAt: now,
  };
}

function autoEscalateDecisionRequests(items, decisionRequests, worker) {
  const escalated = [];
  for (const request of decisionRequests) {
    if (hasDecisionRequestTask(items, request.sourceTaskId)) continue;
    const item = createDecisionRequestTask(request, worker);
    items.push(item);
    escalated.push(item);
    appendEvent({
      type: "decision_request.enqueued",
      id: item.id,
      sourceTaskId: request.sourceTaskId,
      assignee: item.assignee,
      status: item.status,
      priority: item.priority,
      title: item.title,
    });
  }
  return escalated;
}

function summarizeQueue(items) {
  const statusCounts = Object.fromEntries([...allowedStatuses].map((status) => [status, 0]));
  const assigneeCounts = Object.fromEntries([...allowedAssignees].map((assignee) => [assignee, 0]));
  const priorityCounts = Object.fromEntries([...allowedPriorities].map((priority) => [priority, 0]));
  for (const item of items) {
    if (allowedStatuses.has(item.status)) statusCounts[item.status] += 1;
    if (allowedAssignees.has(item.assignee)) assigneeCounts[item.assignee] += 1;
    if (allowedPriorities.has(item.priority)) priorityCounts[item.priority] += 1;
  }

  const byPriorityThenTime = (a, b) => {
    const byPriority = (priorityRank[a.priority] ?? 9) - (priorityRank[b.priority] ?? 9);
    if (byPriority !== 0) return byPriority;
    return String(a.createdAt || "").localeCompare(String(b.createdAt || ""));
  };

  const compact = (item) => ({
    id: item.id,
    title: item.title,
    assignee: item.assignee,
    status: item.status,
    priority: item.priority,
    files: Array.isArray(item.files) ? item.files : [],
    resultSummary: item.resultSummary || "",
    updatedAt: item.updatedAt || item.createdAt || "",
    workerClass: item.workerClass || (AGENT_ROLES[item.assignee] || {}).workerClass || "",
    role: item.role || (AGENT_ROLES[item.assignee] || {}).role || "",
    stopCondition: item.stopCondition || "",
    approvalCondition: item.approvalCondition || "",
    evidenceRequired: Array.isArray(item.evidenceRequired) ? item.evidenceRequired : [],
    riskClass: item.riskClass || "",
    requiresHumanApproval: Boolean(item.requiresHumanApproval),
  });

  const queued = items.filter((item) => item.status === "queued").sort(byPriorityThenTime).map(compact);
  const copied = items.filter((item) => item.status === "copied").sort(byPriorityThenTime).map(compact);
  const running = items.filter((item) => item.status === "running").sort(byPriorityThenTime).map(compact);
  const blocked = items.filter((item) => item.status === "blocked").sort(byPriorityThenTime).map(compact);
  const readyForVerification = items.filter((item) => item.status === "ready_for_verification").sort(byPriorityThenTime).map(compact);
  const done = items.filter((item) => item.status === "done").sort(byPriorityThenTime).map(compact);
  const decisionRequests = buildDecisionRequests(items);

  const nextActions = [];
  if (copied.length) {
    nextActions.push("URGENT: Hermes/Codex: recover copied tasks so copied prompt handoffs do not become invisible (deadlock risk).");
  }
  if (blocked.length) {
    nextActions.push("Human/Hermes: resolve blocked task reasons before dispatching dependent work.");
  }
  if (running.some((item) => item.assignee === "hermes")) {
    nextActions.push("Hermes: finish the running aggregation task and record this report as resultSummary.");
  }
  if (readyForVerification.length) {
    nextActions.push("Verifier: inspect READY_FOR_VERIFICATION tasks, rerun expected tests, then mark DONE with --verified only if evidence passes.");
  }
  for (const request of decisionRequests) {
    nextActions.push(`Hermes: report residual risk from ${request.sourceTaskId} and ask the user for the next command.`);
  }
  for (const item of queued.slice(0, 3)) {
    nextActions.push(`${item.assignee}: claim ${item.priority} ${item.id} - ${item.title}`);
  }
  if (!nextActions.length) {
    nextActions.push("Hermes: queue the next wave from the latest completed result summaries.");
  }

  return {
    generatedAt: new Date().toISOString(),
    total: items.length,
    statusCounts,
    assigneeCounts,
    agentRoles: Object.fromEntries(Object.entries(AGENT_ROLES).map(([agent, role]) => [agent, role.workerClass])),
    priorityCounts,
    done,
    blocked,
    readyForVerification,
    running,
    copied,
    queued,
    decisionRequests,
    nextActions,
  };
}

function writeReplanReport(summary, worker) {
  const dir = reportDir();
  fs.mkdirSync(dir, { recursive: true });
  const stamp = summary.generatedAt.replace(/[-:.TZ]/g, "").slice(0, 14);
  const file = path.join(dir, `agent-queue-replan-${stamp}.json`);
  fs.writeFileSync(file, `${JSON.stringify({ worker, summary }, null, 2)}\n`, "utf8");
  return file;
}

function replanQueue() {
  const worker = redact(getArg("worker", "hermes"), 120);
  const autoEscalateRisks = process.argv.includes("--auto-escalate-risks");
  let escalated = [];
  let summary;
  if (autoEscalateRisks) {
    summary = withQueueLock(() => {
      const items = readQueue();
      const firstSummary = summarizeQueue(items);
      escalated = autoEscalateDecisionRequests(items, firstSummary.decisionRequests, worker);
      if (escalated.length) writeQueue(items);
      return summarizeQueue(items);
    });
  } else {
    summary = summarizeQueue(readQueue());
  }
  const reportPath = writeReplanReport(summary, worker);
  appendEvent({
    type: "queue.replanned",
    worker,
    total: summary.total,
    statusCounts: summary.statusCounts,
    reportPath,
    decisionRequestCount: summary.decisionRequests.length,
    escalatedCount: escalated.length,
  });
  console.log(JSON.stringify({ success: true, path: queuePath(), reportPath, escalated, summary }, null, 2));
}

function usage() {
  console.log(`Usage:
  node scripts/agent-queue.js list [--status queued]
  node scripts/agent-queue.js add --assignee codex|claude|hermes|gemini|antigravity|local-llm --title "..." --prompt "..." [--role implementer|reviewer|researcher|verifier|local-smoke] [--stop-condition "..."] [--approval-condition "..."] [--evidence-required "..."] [--priority P0|P1|P2] [--file path] [--write-scope path] [--forbidden-path path]
  node scripts/agent-queue.js add --assignee codex --title "..." --prompt-file prompt.txt
  node scripts/agent-queue.js claim --assignee codex|claude|hermes|gemini|antigravity|local-llm [--worker name]
  node scripts/agent-queue.js claim-copied --assignee codex|claude|hermes|gemini|antigravity|local-llm [--worker name]
  node scripts/agent-queue.js update --id aq-... --status running|ready_for_verification|done|blocked [--result-summary "..."] [--verified]
  node scripts/agent-queue.js replan [--worker hermes] [--auto-escalate-risks]

Queue path: ${queuePath()}`);
}

const command = process.argv[2];
if (command === "list") listItems();
else if (command === "get") getItem();
else if (command === "add") addItem();
else if (command === "claim") claimItem();
else if (command === "claim-copied") claimCopiedItem();
else if (command === "update") updateItem();
else if (command === "replan") replanQueue();
else usage();
