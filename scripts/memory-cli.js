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

// scripts/memory-cli.ts
var fs5 = __toESM(require("fs"));
var os2 = __toESM(require("os"));
var path5 = __toESM(require("path"));

// src/our/memory-bridge.ts
var fs4 = __toESM(require("fs"));
var os = __toESM(require("os"));
var path4 = __toESM(require("path"));

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

// src/our/env-policy.ts
var fs3 = __toESM(require("fs"));
var path3 = __toESM(require("path"));
var FALLBACK_FORBIDDEN_WORDS = [
  "KEY",
  "SECRET",
  "TOKEN",
  "PASSWORD",
  "PASS",
  "COOKIE",
  "SESSION",
  "AUTH",
  "CREDENTIAL",
  "PRIVATE",
  "CLIENT_SECRET",
  "REFRESH_TOKEN",
  "ACCESS_TOKEN",
  "ACCOUNT",
  "ORDER",
  "BROKER",
  "KIS"
];
function readJsonFile(filePath) {
  try {
    return JSON.parse(fs3.readFileSync(filePath, "utf8"));
  } catch {
    return void 0;
  }
}
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function globToRegExp(glob) {
  const body = glob.split("*").map(escapeRegExp).join(".*");
  return new RegExp(`^${body}$`, "i");
}
function arrayOfStrings(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}
function isSensitiveName(name, forbiddenWords, forbiddenPrint) {
  const upper = name.toUpperCase();
  if (forbiddenWords.some((word) => upper.includes(word.toUpperCase()))) return true;
  return forbiddenPrint.map(globToRegExp).some((pattern) => pattern.test(name));
}
function createEnvPolicyRedactor(extensionRoot2) {
  const policyPath = path3.join(extensionRoot2, "config", "env-policy.json");
  const policy = readJsonFile(policyPath);
  const forbiddenWords = arrayOfStrings(policy?.global?.forbiddenNameWords);
  const forbiddenPrint = arrayOfStrings(policy?.global?.forbiddenPrint);
  const words = forbiddenWords.length ? forbiddenWords : FALLBACK_FORBIDDEN_WORDS;
  return (value) => {
    let text = typeof value === "string" ? value : String(value);
    text = text.replace(/\b([A-Za-z_][A-Za-z0-9_]{1,100})\b\s*([:=])\s*("[^"]*"|'[^']*'|[^\s,;}]+)/g, (match, name, separator) => {
      if (!isSensitiveName(name, words, forbiddenPrint)) return match;
      return `${name}${separator}***`;
    });
    text = text.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi, "Bearer ***");
    text = text.replace(/\b(?:sk-|sk_live_|sk_test_|gh[pousr]_|AIza|ya29\.)[A-Za-z0-9._-]{12,}\b/g, "***");
    return text;
  };
}

// src/our/memory-bridge.ts
var DEFAULT_MEMORY_ROOT = path4.join(os.homedir(), "connect-ai-vault");
var DEFAULT_ALLOWED_SUBDIRS = ["", "00_MOC/", "decisions/", "runbooks/", "inbox/", "wiki/", "agent-guides/", "codex-memory/", "youtube/"];
var FORBIDDEN_VAULT_PREFIXES = ["_company/", ".connect-ai-locks/"];
function readJson2(filePath) {
  try {
    return JSON.parse(fs4.readFileSync(filePath, "utf8"));
  } catch {
    return void 0;
  }
}
function loadMemoryPolicy(extensionRoot2) {
  const policyPath = path4.join(extensionRoot2, "config", "memory-policy.json");
  const policy = readJson2(policyPath) || {};
  return { policyPath, policy };
}
function loadVaultWritePolicy(extensionRoot2) {
  const policyPath = path4.join(extensionRoot2, "config", "vault-write-policy.json");
  return readJson2(policyPath) || {};
}
function policyViolation(rule, detail, suggestion) {
  return `\uC774 write\uB294 ${rule} \uB8F0 \uC704\uBC18: ${detail} \u2014 \uB300\uC2E0 ${suggestion}`;
}
function normalizeDirForPolicy(value) {
  if (value === "") return "";
  return value.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/?$/, "/");
}
function resolveRootPath(root) {
  return path4.resolve(root || DEFAULT_MEMORY_ROOT);
}
function isInside(child, parent) {
  const rel = path4.relative(path4.resolve(parent), path4.resolve(child));
  return rel === "" || !!rel && !rel.startsWith("..") && !path4.isAbsolute(rel);
}
function assertMemoryRootAllowed(extensionRoot2, root) {
  if (!fs4.existsSync(root)) throw new Error(`memory_root_missing: ${root}`);
  if (!fs4.statSync(root).isDirectory()) throw new Error(`memory_root_not_directory: ${root}`);
  if (isInside(root, extensionRoot2)) throw new Error("memory_root_inside_repo_or_extension");
}
function withFileLock(lockRoot, name, fn) {
  fs4.mkdirSync(lockRoot, { recursive: true });
  const lockPath = path4.join(lockRoot, `${name}.lock`);
  const started = Date.now();
  let fd;
  while (Date.now() - started < 1e4) {
    try {
      fd = fs4.openSync(lockPath, "wx");
      fs4.writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: (/* @__PURE__ */ new Date()).toISOString() }));
      break;
    } catch {
      try {
        const stat = fs4.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > 6e4) fs4.unlinkSync(lockPath);
      } catch {
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  if (fd === void 0) throw new Error(`memory_write_lock_timeout: ${lockPath}`);
  try {
    return fn();
  } finally {
    try {
      fs4.closeSync(fd);
    } catch {
    }
    try {
      fs4.unlinkSync(lockPath);
    } catch {
    }
  }
}
function countMarkdownFiles(root) {
  let count = 0;
  function walk(dir) {
    for (const entry of fs4.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".obsidian") continue;
      const full = path4.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) count++;
    }
  }
  if (fs4.existsSync(root)) walk(root);
  return count;
}
function normalizeRelPath(relPath) {
  const cleaned = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!cleaned || path4.isAbsolute(relPath) || cleaned.includes("\0")) throw new Error("invalid_memory_relpath");
  if (cleaned.split("/").includes("..")) throw new Error("outside_memory_root");
  if (cleaned === ".obsidian" || cleaned.startsWith(".obsidian/") || cleaned.includes("/.obsidian/")) {
    throw new Error("obsidian_internal_path_forbidden");
  }
  if (FORBIDDEN_VAULT_PREFIXES.some((prefix) => cleaned === prefix.slice(0, -1) || cleaned.startsWith(prefix))) {
    throw new Error("runtime_path_forbidden");
  }
  if (!cleaned.toLowerCase().endsWith(".md")) throw new Error("memory_note_must_be_markdown");
  return cleaned;
}
function enforceDurableRelPathPolicy(extensionRoot2, relPath) {
  const policy = loadVaultWritePolicy(extensionRoot2);
  for (const rule of policy.forbiddenFilenamePatterns || []) {
    if (!rule.pattern) continue;
    const regex = new RegExp(rule.pattern, "i");
    if (regex.test(relPath)) {
      throw new Error(policyViolation(
        rule.id || "filename",
        `${relPath} is not allowed by vault-write-policy.json`,
        rule.suggestion || "notes/, ideas/, references/ \uB610\uB294 \uC801\uC808\uD55C MOC/\uC7A5\uAE30 \uB178\uD2B8 \uACBD\uB85C\uB97C \uC0AC\uC6A9\uD558\uC138\uC694."
      ));
    }
  }
}
function isAllowedSubdir(relPath, allowedSubdirs) {
  const rel = relPath.replace(/\\/g, "/");
  const firstSlash = rel.indexOf("/");
  if (firstSlash === -1) return allowedSubdirs.includes("");
  return allowedSubdirs.some((dir) => dir !== "" && rel.startsWith(dir));
}
function startsWithPolicySubdir(relPath, subdirs) {
  const rel = relPath.replace(/\\/g, "/");
  return subdirs.some((dir) => {
    if (!dir) return false;
    return rel.startsWith(dir);
  });
}
function effectiveWriteMode(rootStatus, relPath) {
  if (rootStatus.liveSubdirs.length || rootStatus.observeSubdirs.length) {
    if (startsWithPolicySubdir(relPath, rootStatus.liveSubdirs)) return "live";
    if (startsWithPolicySubdir(relPath, rootStatus.observeSubdirs)) return "observe";
    return "observe";
  }
  return rootStatus.writeMode;
}
function resolveNotePath(extensionRoot2, relPath) {
  const rootStatus = resolveMemoryRoot(extensionRoot2);
  if (!rootStatus.ok) throw new Error(rootStatus.warnings.join(",") || "memory_root_invalid");
  const normalizedRel = normalizeRelPath(relPath);
  if (!isAllowedSubdir(normalizedRel, rootStatus.allowedSubdirs)) {
    throw new Error(`memory_subdir_not_allowed: ${normalizedRel}`);
  }
  const fullPath = path4.resolve(rootStatus.memoryRoot, normalizedRel);
  if (!isInside(fullPath, rootStatus.memoryRoot)) throw new Error("outside_memory_root");
  return { rootStatus, relPath: normalizedRel, fullPath };
}
function walkNotes(root) {
  const notes = [];
  function walk(dir) {
    for (const entry of fs4.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".obsidian") continue;
      const full = path4.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
      const stat = fs4.statSync(full);
      notes.push({
        relPath: path4.relative(root, full).split(path4.sep).join("/"),
        fullPath: full,
        bytes: stat.size,
        updatedAt: stat.mtime.toISOString()
      });
    }
  }
  walk(root);
  return notes.sort((a, b) => a.relPath.localeCompare(b.relPath));
}
function slugifyTitle(title) {
  const ascii = title.normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-").toLowerCase();
  return ascii || "decision";
}
function kstDate(d = /* @__PURE__ */ new Date()) {
  return d.toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
}
function yamlString(value) {
  return `"${String(value || "").replace(/"/g, '\\"')}"`;
}
function statusForDecision(status) {
  return status === "accepted" ? "active" : "draft";
}
function decisionMarkdown(meta, body) {
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const title = meta.title.trim() || "Decision";
  return [
    "---",
    "type: decision",
    `status: ${statusForDecision(meta.status)}`,
    `project: ${yamlString("Connect AI")}`,
    `owner: ${yamlString("memory-bridge")}`,
    `source: ${yamlString(meta.dept || "connect-ai")}`,
    `created: ${yamlString(now)}`,
    `updated: ${yamlString(now)}`,
    "links:",
    `  - ${yamlString("[[00_MOC/Decisions]]")}`,
    `  - ${yamlString("[[Connect AI]]")}`,
    `decision_status: ${meta.status || "proposed"}`,
    `dept: ${meta.dept || "n/a"}`,
    "tags: [decision]",
    "---",
    `# ${title}`,
    "- \uACB0\uC815:",
    "- \uADFC\uAC70:",
    "- \uAD00\uB828: [[00_MOC/Decisions]], [[Connect AI]]",
    "",
    body.trim(),
    ""
  ].join("\n");
}
function rejectedWritesPath(storageRoot2) {
  return path4.join(storageRoot2, "rejected-writes", "rejected-writes.jsonl");
}
function appendRejectedWrite(storageRoot2, detail) {
  try {
    const file = rejectedWritesPath(storageRoot2);
    fs4.mkdirSync(path4.dirname(file), { recursive: true });
    fs4.appendFileSync(file, `${JSON.stringify({ ts: (/* @__PURE__ */ new Date()).toISOString(), actor: "memory-bridge", ...detail })}
`, "utf8");
  } catch {
  }
}
function resolveMemoryRoot(extensionRoot2) {
  const { policyPath, policy } = loadMemoryPolicy(extensionRoot2);
  const memoryRoot = resolveRootPath(policy.memoryRoot || DEFAULT_MEMORY_ROOT);
  const exists = fs4.existsSync(memoryRoot) && fs4.statSync(memoryRoot).isDirectory();
  const outsideRepo = !isInside(memoryRoot, extensionRoot2);
  const allowedSubdirs = (policy.allowedSubdirs || DEFAULT_ALLOWED_SUBDIRS).map(normalizeDirForPolicy);
  const liveSubdirs = (policy.liveSubdirs || []).map(normalizeDirForPolicy);
  const observeSubdirs = (policy.observeSubdirs || []).map(normalizeDirForPolicy);
  const writeMode = policy.writeMode === "live" ? "live" : "observe";
  const warnings = [];
  if (!policy.memoryRoot) warnings.push("memory_policy_default_root_used");
  if (policy.mutable !== false) warnings.push("memory_policy_mutable_not_false");
  if (!exists) warnings.push("memory_root_missing");
  if (!outsideRepo) warnings.push("memory_root_must_be_outside_repo");
  if (!allowedSubdirs.includes("decisions/")) warnings.push("memory_policy_missing_decisions_subdir");
  return {
    ok: exists && outsideRepo && policy.mutable === false,
    policyPath,
    memoryRoot,
    exists,
    outsideRepo,
    noteCount: exists ? countMarkdownFiles(memoryRoot) : 0,
    allowedSubdirs,
    liveSubdirs,
    observeSubdirs,
    writeMode,
    warnings
  };
}
function listNotes(extensionRoot2, storageRoot2) {
  const rootStatus = resolveMemoryRoot(extensionRoot2);
  if (!rootStatus.ok) throw new Error(rootStatus.warnings.join(",") || "memory_root_invalid");
  const gate = evaluatePolicy(extensionRoot2, { action: "memory_read", payload: { op: "listNotes", root: rootStatus.memoryRoot } });
  const notes = gate.decision === "FORBIDDEN" ? [] : walkNotes(rootStatus.memoryRoot);
  appendAudit(storageRoot2, {
    type: "memory_list_notes",
    payloadHash: gate.payloadHash,
    decision: gate.decision,
    actor: "memory-bridge",
    detail: { noteCount: notes.length, root: rootStatus.memoryRoot }
  });
  if (gate.decision === "FORBIDDEN") throw new Error("memory_read_forbidden");
  return notes;
}
function readNote(extensionRoot2, storageRoot2, relPath) {
  const resolved = resolveNotePath(extensionRoot2, relPath);
  const gate = evaluatePolicy(extensionRoot2, { action: "memory_read", payload: { op: "readNote", relPath: resolved.relPath } });
  appendAudit(storageRoot2, {
    type: "memory_read_note",
    payloadHash: gate.payloadHash,
    decision: gate.decision,
    actor: "memory-bridge",
    detail: { relPath: resolved.relPath }
  });
  if (gate.decision === "FORBIDDEN") throw new Error("memory_read_forbidden");
  return {
    relPath: resolved.relPath,
    fullPath: resolved.fullPath,
    content: fs4.readFileSync(resolved.fullPath, "utf8"),
    gate
  };
}
function createDecisionNote(extensionRoot2, storageRoot2, meta, body) {
  let relPath = "";
  try {
    const datePart = kstDate();
    const monthPart = datePart.slice(0, 7);
    relPath = `decisions/${monthPart}/${slugifyTitle(meta.title)}.md`;
    enforceDurableRelPathPolicy(extensionRoot2, relPath);
    const content = decisionMarkdown(meta, body);
    const resolved = resolveNotePath(extensionRoot2, relPath);
    assertMemoryRootAllowed(extensionRoot2, resolved.rootStatus.memoryRoot);
    const mode = effectiveWriteMode(resolved.rootStatus, resolved.relPath);
    const redact = createEnvPolicyRedactor(extensionRoot2);
    const previewContent = redact(content);
    const gate = evaluatePolicy(extensionRoot2, {
      action: "memory_write",
      risk: "low",
      dryRun: mode !== "live",
      payload: { op: "createDecisionNote", relPath: resolved.relPath, contentHash: hashPayload(previewContent) }
    });
    const canWrite = gate.decision === "AUTO" && mode === "live";
    if (canWrite) {
      withFileLock(path4.join(resolved.rootStatus.memoryRoot, ".connect-ai-locks"), "memory-write", () => {
        fs4.mkdirSync(path4.dirname(resolved.fullPath), { recursive: true });
        fs4.writeFileSync(resolved.fullPath, previewContent, { encoding: "utf8", flag: "wx" });
      });
    }
    appendAudit(storageRoot2, {
      type: "memory_decision_note",
      payloadHash: gate.payloadHash,
      decision: gate.decision,
      actor: "memory-bridge",
      detail: { relPath: resolved.relPath, mode, wrote: canWrite, contentHash: hashPayload(previewContent) }
    });
    if (gate.decision === "FORBIDDEN") throw new Error("memory_write_forbidden");
    return { ok: true, mode, relPath: resolved.relPath, path: resolved.fullPath, previewContent, gate, wrote: canWrite };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    appendRejectedWrite(storageRoot2, { relPath, reason });
    const gate = evaluatePolicy(extensionRoot2, {
      action: "memory_write",
      risk: "low",
      dryRun: true,
      payload: { op: "createDecisionNoteRejected", relPath, reason }
    });
    return {
      ok: false,
      mode: "observe",
      relPath,
      path: "",
      previewContent: "",
      gate,
      wrote: false,
      reason
    };
  }
}

// scripts/memory-cli.ts
function extensionRoot() {
  return path5.resolve(__dirname, "..");
}
function windowsPathToWsl(value) {
  const match = value.match(/^([A-Za-z]):\\(.*)$/);
  if (!match) return value;
  return `/mnt/${match[1].toLowerCase()}/${match[2].replace(/\\/g, "/")}`;
}
function currentWindowsUser() {
  try {
    return process.env.CONNECT_AI_WINDOWS_USER || process.env.USERNAME || process.env.USER || os2.userInfo().username || path5.basename(os2.homedir());
  } catch {
    return process.env.CONNECT_AI_WINDOWS_USER || process.env.USERNAME || process.env.USER || path5.basename(os2.homedir());
  }
}
function registerTempCleanup(tmpRoot) {
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try {
      fs5.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
    }
  };
  process.once("exit", cleanup);
  process.once("SIGINT", () => {
    cleanup();
    process.exit(130);
  });
  process.once("SIGTERM", () => {
    cleanup();
    process.exit(143);
  });
  process.once("uncaughtException", (error) => {
    cleanup();
    throw error;
  });
  process.once("unhandledRejection", (reason) => {
    cleanup();
    throw reason instanceof Error ? reason : new Error(String(reason));
  });
}
function bridgeExtensionRoot() {
  const root = extensionRoot();
  if (process.platform === "win32") return root;
  const configRoot = path5.join(root, "config");
  const memoryPolicyPath = path5.join(configRoot, "memory-policy.json");
  if (!fs5.existsSync(memoryPolicyPath)) return root;
  const tmpRoot = fs5.mkdtempSync(path5.join(os2.tmpdir(), "connect-ai-cli-root-"));
  registerTempCleanup(tmpRoot);
  const tmpConfigRoot = path5.join(tmpRoot, "config");
  fs5.mkdirSync(tmpConfigRoot, { recursive: true });
  for (const name of ["tool-execution-policy.json", "env-policy.json", "memory-policy.json"]) {
    const src = path5.join(configRoot, name);
    if (fs5.existsSync(src)) fs5.copyFileSync(src, path5.join(tmpConfigRoot, name));
  }
  const tmpMemoryPolicyPath = path5.join(tmpConfigRoot, "memory-policy.json");
  const policy = JSON.parse(fs5.readFileSync(tmpMemoryPolicyPath, "utf8"));
  if (policy.memoryRoot) {
    policy.memoryRoot = windowsPathToWsl(policy.memoryRoot);
    fs5.writeFileSync(tmpMemoryPolicyPath, JSON.stringify(policy, null, 2), "utf8");
  }
  return tmpRoot;
}
function storageRoot() {
  if (process.env.APPDATA) {
    return path5.join(process.env.APPDATA, "Code", "User", "globalStorage", "connectailab.connect-ai-lab");
  }
  if (process.platform !== "win32") {
    const user = currentWindowsUser();
    const candidate = `/mnt/c/Users/${user}/AppData/Roaming/Code/User/globalStorage/connectailab.connect-ai-lab`;
    if (fs5.existsSync("/mnt/c")) return candidate;
  }
  return path5.join(os2.homedir(), ".connect-ai", "globalStorage", "connectailab.connect-ai-lab");
}
function usage() {
  throw new Error("Usage: memory-cli.ts list | read <relPath> | write-decision <title> <body>");
}
async function main() {
  try {
    const command = process.argv[2];
    const extRoot = bridgeExtensionRoot();
    const storeRoot = storageRoot();
    if (command === "list") {
      process.stdout.write(`${JSON.stringify(listNotes(extRoot, storeRoot), null, 2)}
`);
      return;
    }
    if (command === "read") {
      const relPath = process.argv[3];
      if (!relPath) usage();
      process.stdout.write(readNote(extRoot, storeRoot, relPath).content);
      return;
    }
    if (command === "write-decision") {
      const title = process.argv[3];
      const body = process.argv[4];
      if (!title || !body) usage();
      const result = createDecisionNote(extRoot, storeRoot, { title, dept: "connect-ai", status: "accepted" }, body);
      process.stdout.write(`${JSON.stringify(result, null, 2)}
`);
      return;
    }
    usage();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(`${JSON.stringify({ error: message }, null, 2)}
`);
    process.exit(1);
  }
}
void main();
