"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// scripts/gate-check.ts
var fs3 = __toESM(require("fs"));
var os = __toESM(require("os"));
var path3 = __toESM(require("path"));

// src/our/approval-queue.ts
var fs2 = __toESM(require("fs"));
var path2 = __toESM(require("path"));

// src/our/policy-gate.ts
var crypto = __toESM(require("crypto"));
var fs = __toESM(require("fs"));
var path = __toESM(require("path"));
var FORBIDDEN_PATTERNS = [
  /\b(rm\s+-rf|rmdir\s+\/s|del\s+\/s|format\b|mkfs\b)\b/i,
  /\bgit\s+(reset\s+--hard|clean\s+-fdx|push\s+--force|branch\s+-D)\b/i,
  /\b(KIS|broker|order\s+placement|live\s+trade|token\s+refresh)\b/i,
  /(^|[\\\/])\.env(\.|$|[\\\/])/i,
  /\b(api[_-]?key|secret|password|refresh[_-]?token|access[_-]?token|cookie)\b/i
];
var SAFE_AUTO_ACTIONS = /* @__PURE__ */ new Set([
  "status",
  "artifacts",
  "validate",
  "search",
  "prepare",
  "risk_review",
  "relay_prepare",
  "pipeline_observe",
  "pipeline_stage",
  "registry_validate",
  "memory_read",
  "memory_write"
]);
function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return void 0;
  }
}
function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}
function hashPayload(payload) {
  return crypto.createHash("sha256").update(stableStringify(payload)).digest("hex");
}
function normalizeRisk(risk) {
  return risk || "low";
}
function evaluatePolicy(extensionRoot2, request) {
  const policyPath = path.join(extensionRoot2, "config", "tool-execution-policy.json");
  const policy = readJson(policyPath);
  const reasons = [];
  const risk = normalizeRisk(request.risk);
  const command = request.command || "";
  const payloadHash = hashPayload({
    action: request.action,
    departmentId: request.departmentId,
    toolId: request.toolId,
    risk,
    command,
    worker: request.worker,
    payload: request.payload,
    dryRun: request.dryRun !== false
  });
  if (!policy) reasons.push("tool_execution_policy_missing_or_invalid");
  if (policy && policy.mutable !== false) reasons.push("tool_execution_policy_mutable_not_false");
  if (FORBIDDEN_PATTERNS.some((pattern) => pattern.test(command) || pattern.test(stableStringify(request.payload)))) {
    reasons.push("hard_forbidden_pattern_detected");
    return { decision: "FORBIDDEN", risk, payloadHash, reasons, policyLoaded: !!policy };
  }
  if (request.departmentId === "stock-research" && request.action === "run") {
    reasons.push("stock_research_execution_requires_gate");
    return { decision: "APPROVAL", risk, payloadHash, reasons, policyLoaded: !!policy };
  }
  if (request.touchesSecrets || request.externalSend || request.mutatesOutsideProject) {
    reasons.push("secret_external_or_outside_mutation_requires_approval");
    return { decision: "APPROVAL", risk, payloadHash, reasons, policyLoaded: !!policy };
  }
  if (risk === "high") {
    reasons.push("high_risk_requires_approval");
    return { decision: "APPROVAL", risk, payloadHash, reasons, policyLoaded: !!policy };
  }
  if (!SAFE_AUTO_ACTIONS.has(request.action) && request.action !== "run") {
    reasons.push("action_not_in_auto_allowlist");
    return { decision: "APPROVAL", risk, payloadHash, reasons, policyLoaded: !!policy };
  }
  if (request.action === "run") {
    if (request.dryRun !== false) {
      reasons.push("run_is_dry_run_only");
      return { decision: "AUTO", risk, payloadHash, reasons, policyLoaded: !!policy };
    }
    if (!request.reversible) {
      reasons.push("non_dry_run_requires_reversibility");
      return { decision: "APPROVAL", risk, payloadHash, reasons, policyLoaded: !!policy };
    }
  }
  reasons.push("allowlist_auto");
  return { decision: "AUTO", risk, payloadHash, reasons, policyLoaded: !!policy };
}

// src/our/approval-queue.ts
function ensureDir(dir) {
  fs2.mkdirSync(dir, { recursive: true });
}
function appendJsonl(filePath, record) {
  ensureDir(path2.dirname(filePath));
  fs2.appendFileSync(filePath, `${JSON.stringify(record)}
`, "utf8");
}
function phase2StorageRoot(storageRoot2) {
  return path2.join(storageRoot2, "phase2");
}
function auditLogPath(storageRoot2) {
  return path2.join(phase2StorageRoot(storageRoot2), "audit-log.jsonl");
}
function appendAudit(storageRoot2, record) {
  appendJsonl(auditLogPath(storageRoot2), { ts: (/* @__PURE__ */ new Date()).toISOString(), ...record });
}

// scripts/gate-check.ts
function extensionRoot() {
  return path3.resolve(__dirname, "..");
}
function currentWindowsUser() {
  try {
    return process.env.CONNECT_AI_WINDOWS_USER || process.env.USERNAME || process.env.USER || os.userInfo().username || path3.basename(os.homedir());
  } catch {
    return process.env.CONNECT_AI_WINDOWS_USER || process.env.USERNAME || process.env.USER || path3.basename(os.homedir());
  }
}
function storageRoot() {
  if (process.env.APPDATA) {
    return path3.join(process.env.APPDATA, "Code", "User", "globalStorage", "connectailab.connect-ai-lab");
  }
  if (process.platform !== "win32") {
    const user = currentWindowsUser();
    const candidate = `/mnt/c/Users/${user}/AppData/Roaming/Code/User/globalStorage/connectailab.connect-ai-lab`;
    if (fs3.existsSync("/mnt/c")) return candidate;
  }
  return path3.join(os.homedir(), ".connect-ai", "globalStorage", "connectailab.connect-ai-lab");
}
function readStdin() {
  return new Promise((resolve2, reject) => {
    if (process.stdin.isTTY) {
      resolve2("");
      return;
    }
    let data = "";
    const timeoutMs = Number(process.env.CONNECT_AI_STDIN_TIMEOUT_MS || 5e3);
    const timer = setTimeout(() => resolve2(data), timeoutMs);
    const finish = (fn) => {
      clearTimeout(timer);
      fn();
    };
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => finish(() => resolve2(data)));
    process.stdin.on("error", (error) => finish(() => reject(error)));
  });
}
async function readRequest() {
  const raw = process.argv[2] || await readStdin();
  if (!raw.trim()) throw new Error("PolicyRequest JSON required as argv[2] or stdin");
  return JSON.parse(raw);
}
async function main() {
  try {
    const request = await readRequest();
    const result = evaluatePolicy(extensionRoot(), request);
    appendAudit(storageRoot(), {
      type: "gate_check_cli",
      payloadHash: result.payloadHash,
      decision: result.decision,
      actor: "hermes-cli",
      detail: { action: request.action, departmentId: request.departmentId, toolId: request.toolId }
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}
`);
    if (result.decision === "FORBIDDEN") process.exit(1);
    if (result.decision === "APPROVAL") process.exit(2);
    process.exit(0);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(`${JSON.stringify({ error: message }, null, 2)}
`);
    process.exit(3);
  }
}
void main();
