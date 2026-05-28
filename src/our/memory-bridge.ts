import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { appendAudit } from "./approval-queue";
import { createEnvPolicyRedactor } from "./env-policy";
import { evaluatePolicy, hashPayload, PolicyGateResult } from "./policy-gate";

export type MemoryWriteMode = "observe" | "live";
export type DecisionStatus = "proposed" | "accepted";
export type DurableNoteType = "project" | "agent" | "runbook" | "decision" | "tool" | "evidence" | "moc";
export type DurableNoteStatus = "active" | "draft" | "blocked" | "archived";

export interface MemoryPolicy {
    version?: number;
    mutable?: boolean;
    memoryRoot?: string;
    allowedSubdirs?: string[];
    liveSubdirs?: string[];
    observeSubdirs?: string[];
    forbiddenWrite?: string[];
    writeMode?: MemoryWriteMode;
    redact?: boolean;
}

interface VaultFilenameRule {
    id?: string;
    pattern?: string;
    suggestion?: string;
}

interface VaultWritePolicy {
    forbiddenFilenamePatterns?: VaultFilenameRule[];
}

export interface MemoryRootStatus {
    ok: boolean;
    policyPath: string;
    memoryRoot: string;
    exists: boolean;
    outsideRepo: boolean;
    noteCount: number;
    allowedSubdirs: string[];
    liveSubdirs: string[];
    observeSubdirs: string[];
    writeMode: MemoryWriteMode;
    warnings: string[];
}

export interface MemoryNote {
    relPath: string;
    fullPath: string;
    bytes: number;
    updatedAt: string;
}

export interface MemoryReadResult {
    relPath: string;
    fullPath: string;
    content: string;
    gate: PolicyGateResult;
}

export interface MemoryWriteResult {
    ok: boolean;
    mode: MemoryWriteMode;
    relPath: string;
    path: string;
    previewContent: string;
    gate: PolicyGateResult;
    wrote: boolean;
    reason?: string;
}

export interface DecisionNoteMeta {
    title: string;
    dept?: string;
    status?: DecisionStatus;
}

export interface DurableNoteMeta {
    relPath: string;
    title: string;
    type: DurableNoteType;
    status: DurableNoteStatus;
    tags?: string[];
    project: string;
    owner: string;
    source: string;
    related?: string[];
    links: string[];
    body: string;
}

const DEFAULT_MEMORY_ROOT = path.join(os.homedir(), "connect-ai-vault");
const DEFAULT_ALLOWED_SUBDIRS = ["", "00_MOC/", "decisions/", "runbooks/", "inbox/", "wiki/", "agent-guides/", "codex-memory/", "youtube/", "notes/", "ideas/", "references/"];
const FORBIDDEN_VAULT_PREFIXES = ["_company/", ".connect-ai-locks/"];

function readJson<T>(filePath: string): T | undefined {
    try {
        return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
    } catch {
        return undefined;
    }
}

function loadMemoryPolicy(extensionRoot: string): { policyPath: string; policy: MemoryPolicy } {
    const policyPath = path.join(extensionRoot, "config", "memory-policy.json");
    const policy = readJson<MemoryPolicy>(policyPath) || {};
    return { policyPath, policy };
}

function loadVaultWritePolicy(extensionRoot: string): VaultWritePolicy {
    const policyPath = path.join(extensionRoot, "config", "vault-write-policy.json");
    return readJson<VaultWritePolicy>(policyPath) || {};
}

function policyViolation(rule: string, detail: string, suggestion: string): string {
    return `이 write는 ${rule} 룰 위반: ${detail} — 대신 ${suggestion}`;
}

function normalizeDirForPolicy(value: string): string {
    if (value === "") return "";
    return value.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/?$/, "/");
}

function resolveRootPath(root: string): string {
    return path.resolve(root || DEFAULT_MEMORY_ROOT);
}

function isInside(child: string, parent: string): boolean {
    const rel = path.relative(path.resolve(parent), path.resolve(child));
    return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

function assertMemoryRootAllowed(extensionRoot: string, root: string): void {
    if (!fs.existsSync(root)) throw new Error(`memory_root_missing: ${root}`);
    if (!fs.statSync(root).isDirectory()) throw new Error(`memory_root_not_directory: ${root}`);
    if (isInside(root, extensionRoot)) throw new Error("memory_root_inside_repo_or_extension");
}

function withFileLock<T>(lockRoot: string, name: string, fn: () => T): T {
    fs.mkdirSync(lockRoot, { recursive: true });
    const lockPath = path.join(lockRoot, `${name}.lock`);
    const started = Date.now();
    let fd: number | undefined;
    while (Date.now() - started < 10000) {
        try {
            fd = fs.openSync(lockPath, "wx");
            fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
            break;
        } catch {
            try {
                const stat = fs.statSync(lockPath);
                if (Date.now() - stat.mtimeMs > 60000) fs.unlinkSync(lockPath);
            } catch { /* retry */ }
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
        }
    }
    if (fd === undefined) throw new Error(`memory_write_lock_timeout: ${lockPath}`);
    try {
        return fn();
    } finally {
        try { fs.closeSync(fd); } catch { /* ignore */ }
        try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
    }
}

function countMarkdownFiles(root: string): number {
    let count = 0;
    function walk(dir: string): void {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.name === ".obsidian") continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) count++;
        }
    }
    if (fs.existsSync(root)) walk(root);
    return count;
}

function normalizeRelPath(relPath: string): string {
    const cleaned = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
    if (!cleaned || path.isAbsolute(relPath) || cleaned.includes("\0")) throw new Error("invalid_memory_relpath");
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

function enforceDurableRelPathPolicy(extensionRoot: string, relPath: string): void {
    const policy = loadVaultWritePolicy(extensionRoot);
    for (const rule of policy.forbiddenFilenamePatterns || []) {
        if (!rule.pattern) continue;
        const regex = new RegExp(rule.pattern, "i");
        if (regex.test(relPath)) {
            throw new Error(policyViolation(
                rule.id || "filename",
                `${relPath} is not allowed by vault-write-policy.json`,
                rule.suggestion || "notes/, ideas/, references/ 또는 적절한 MOC/장기 노트 경로를 사용하세요."
            ));
        }
    }
}

function isAllowedSubdir(relPath: string, allowedSubdirs: string[]): boolean {
    const rel = relPath.replace(/\\/g, "/");
    const firstSlash = rel.indexOf("/");
    if (firstSlash === -1) return allowedSubdirs.includes("");
    return allowedSubdirs.some((dir) => dir !== "" && rel.startsWith(dir));
}

function startsWithPolicySubdir(relPath: string, subdirs: string[]): boolean {
    const rel = relPath.replace(/\\/g, "/");
    return subdirs.some((dir) => {
        if (!dir) return false;
        return rel.startsWith(dir);
    });
}

function effectiveWriteMode(rootStatus: MemoryRootStatus, relPath: string): MemoryWriteMode {
    if (rootStatus.liveSubdirs.length || rootStatus.observeSubdirs.length) {
        if (startsWithPolicySubdir(relPath, rootStatus.liveSubdirs)) return "live";
        if (startsWithPolicySubdir(relPath, rootStatus.observeSubdirs)) return "observe";
        return "observe";
    }
    return rootStatus.writeMode;
}

function resolveNotePath(extensionRoot: string, relPath: string): { rootStatus: MemoryRootStatus; relPath: string; fullPath: string } {
    const rootStatus = resolveMemoryRoot(extensionRoot);
    if (!rootStatus.ok) throw new Error(rootStatus.warnings.join(",") || "memory_root_invalid");
    const normalizedRel = normalizeRelPath(relPath);
    if (!isAllowedSubdir(normalizedRel, rootStatus.allowedSubdirs)) {
        throw new Error(`memory_subdir_not_allowed: ${normalizedRel}`);
    }
    const fullPath = path.resolve(rootStatus.memoryRoot, normalizedRel);
    if (!isInside(fullPath, rootStatus.memoryRoot)) throw new Error("outside_memory_root");
    return { rootStatus, relPath: normalizedRel, fullPath };
}

function walkNotes(root: string): MemoryNote[] {
    const notes: MemoryNote[] = [];
    function walk(dir: string): void {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.name === ".obsidian") continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(full);
                continue;
            }
            if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
            const stat = fs.statSync(full);
            notes.push({
                relPath: path.relative(root, full).split(path.sep).join("/"),
                fullPath: full,
                bytes: stat.size,
                updatedAt: stat.mtime.toISOString(),
            });
        }
    }
    walk(root);
    return notes.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

function slugifyTitle(title: string): string {
    const ascii = title.normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-").toLowerCase();
    return ascii || "decision";
}

function kstDate(d: Date = new Date()): string {
    return d.toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
}

function yamlString(value: string): string {
    return `"${String(value || "").replace(/"/g, '\\"')}"`;
}

function cleanStringArray(values: unknown): string[] {
    return Array.isArray(values) ? values.map((value) => String(value).trim()).filter(Boolean) : [];
}

function durableTags(meta: DurableNoteMeta): string[] {
    const explicit = cleanStringArray(meta.tags);
    if (explicit.length) return explicit;
    return ["agent-os", meta.type].filter(Boolean);
}

function durableRelated(meta: DurableNoteMeta): string[] {
    const explicit = cleanStringArray(meta.related);
    if (explicit.length) return explicit;
    return cleanStringArray(meta.links);
}

function statusForDecision(status?: DecisionStatus): DurableNoteStatus {
    return status === "accepted" ? "active" : "draft";
}

function validateDurableMeta(meta: DurableNoteMeta, relPath: string): void {
    if (!["project", "agent", "runbook", "decision", "tool", "evidence", "moc"].includes(meta.type)) throw new Error("invalid_type");
    if (!["active", "draft", "blocked", "archived"].includes(meta.status)) throw new Error("invalid_status");
    if (!meta.project.trim()) throw new Error("project_required");
    if (!meta.owner.trim()) throw new Error("owner_required");
    if (!meta.source.trim()) throw new Error("source_required");
    if (!Array.isArray(meta.links) || meta.links.filter(Boolean).length === 0) throw new Error("required_links_missing");
    if (!durableTags(meta).length) throw new Error("required_tags_missing");
    if (!durableRelated(meta).length) throw new Error("required_related_missing");
    if (meta.type !== "moc" && !meta.links.some((link) => /\[\[00_MOC\//.test(link))) throw new Error("required_moc_link_missing");
    if (meta.type !== "moc" && !durableRelated(meta).some((link) => /\[\[00_MOC\//.test(link))) throw new Error("required_related_moc_link_missing");
    if (meta.type === "moc" && !relPath.startsWith("00_MOC/")) throw new Error("moc_must_live_under_00_MOC");
}

function durableMarkdown(meta: DurableNoteMeta): string {
    const now = new Date().toISOString();
    const links = meta.links.map((link) => `  - ${yamlString(link)}`);
    const tags = durableTags(meta).map((tag) => `  - ${yamlString(tag)}`);
    const related = durableRelated(meta).map((link) => `  - ${yamlString(link)}`);
    return [
        "---",
        `type: ${meta.type}`,
        `status: ${meta.status}`,
        "tags:",
        ...tags,
        `project: ${yamlString(meta.project)}`,
        `owner: ${yamlString(meta.owner)}`,
        `source: ${yamlString(meta.source)}`,
        `created: ${yamlString(now)}`,
        `updated: ${yamlString(now)}`,
        "related:",
        ...related,
        "links:",
        ...links,
        "---",
        "",
        meta.body.trim(),
        "",
    ].join("\n");
}

function decisionMarkdown(meta: DecisionNoteMeta, body: string): string {
    const now = new Date().toISOString();
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
        "- 결정:",
        "- 근거:",
        "- 관련: [[00_MOC/Decisions]], [[Connect AI]]",
        "",
        body.trim(),
        "",
    ].join("\n");
}

function rejectedWritesPath(storageRoot: string): string {
    return path.join(storageRoot, "rejected-writes", "rejected-writes.jsonl");
}

function appendRejectedWrite(storageRoot: string, detail: Record<string, unknown>): void {
    try {
        const file = rejectedWritesPath(storageRoot);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), actor: "memory-bridge", ...detail })}\n`, "utf8");
    } catch { /* rejection logging must not mask the original policy failure */ }
}

export function resolveMemoryRoot(extensionRoot: string): MemoryRootStatus {
    const { policyPath, policy } = loadMemoryPolicy(extensionRoot);
    const memoryRoot = resolveRootPath(policy.memoryRoot || DEFAULT_MEMORY_ROOT);
    const exists = fs.existsSync(memoryRoot) && fs.statSync(memoryRoot).isDirectory();
    const outsideRepo = !isInside(memoryRoot, extensionRoot);
    const allowedSubdirs = (policy.allowedSubdirs || DEFAULT_ALLOWED_SUBDIRS).map(normalizeDirForPolicy);
    const liveSubdirs = (policy.liveSubdirs || []).map(normalizeDirForPolicy);
    const observeSubdirs = (policy.observeSubdirs || []).map(normalizeDirForPolicy);
    const writeMode = policy.writeMode === "live" ? "live" : "observe";
    const warnings: string[] = [];

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
        warnings,
    };
}

export function listNotes(extensionRoot: string, storageRoot: string): MemoryNote[] {
    const rootStatus = resolveMemoryRoot(extensionRoot);
    if (!rootStatus.ok) throw new Error(rootStatus.warnings.join(",") || "memory_root_invalid");
    const gate = evaluatePolicy(extensionRoot, { action: "memory_read", payload: { op: "listNotes", root: rootStatus.memoryRoot } });
    const notes = gate.decision === "FORBIDDEN" ? [] : walkNotes(rootStatus.memoryRoot);
    appendAudit(storageRoot, {
        type: "memory_list_notes",
        payloadHash: gate.payloadHash,
        decision: gate.decision,
        actor: "memory-bridge",
        detail: { noteCount: notes.length, root: rootStatus.memoryRoot },
    });
    if (gate.decision === "FORBIDDEN") throw new Error("memory_read_forbidden");
    return notes;
}

export function readNote(extensionRoot: string, storageRoot: string, relPath: string): MemoryReadResult {
    const resolved = resolveNotePath(extensionRoot, relPath);
    const gate = evaluatePolicy(extensionRoot, { action: "memory_read", payload: { op: "readNote", relPath: resolved.relPath } });
    appendAudit(storageRoot, {
        type: "memory_read_note",
        payloadHash: gate.payloadHash,
        decision: gate.decision,
        actor: "memory-bridge",
        detail: { relPath: resolved.relPath },
    });
    if (gate.decision === "FORBIDDEN") throw new Error("memory_read_forbidden");
    return {
        relPath: resolved.relPath,
        fullPath: resolved.fullPath,
        content: fs.readFileSync(resolved.fullPath, "utf8"),
        gate,
    };
}

export function appendToNote(extensionRoot: string, storageRoot: string, relPath: string, text: string): MemoryWriteResult {
    const resolved = resolveNotePath(extensionRoot, relPath);
    assertMemoryRootAllowed(extensionRoot, resolved.rootStatus.memoryRoot);
    const mode = effectiveWriteMode(resolved.rootStatus, resolved.relPath);
    const redact = createEnvPolicyRedactor(extensionRoot);
    const previewContent = mode === "live" && fs.existsSync(resolved.fullPath)
        ? `${fs.readFileSync(resolved.fullPath, "utf8").replace(/\s*$/, "\n\n")}${redact(text).trim()}\n`
        : `${redact(text).trim()}\n`;
    const gate = evaluatePolicy(extensionRoot, {
        action: "memory_write",
        risk: "low",
        dryRun: mode !== "live",
        payload: { op: "appendToNote", relPath: resolved.relPath, contentHash: hashPayload(previewContent) },
    });
    const canWrite = gate.decision === "AUTO" && mode === "live";
    if (canWrite) {
        fs.mkdirSync(path.dirname(resolved.fullPath), { recursive: true });
        fs.appendFileSync(resolved.fullPath, `${redact(text).trim()}\n`, "utf8");
    }
    appendAudit(storageRoot, {
        type: "memory_append_note",
        payloadHash: gate.payloadHash,
        decision: gate.decision,
        actor: "memory-bridge",
        detail: { relPath: resolved.relPath, mode, wrote: canWrite, contentHash: hashPayload(previewContent) },
    });
    if (gate.decision === "FORBIDDEN") throw new Error("memory_write_forbidden");
    return { ok: true, mode, relPath: resolved.relPath, path: resolved.fullPath, previewContent, gate, wrote: canWrite };
}

export function createDurableNote(extensionRoot: string, storageRoot: string, meta: DurableNoteMeta): MemoryWriteResult {
    let normalizedRel = "";
    try {
        normalizedRel = normalizeRelPath(meta.relPath);
        enforceDurableRelPathPolicy(extensionRoot, normalizedRel);
        validateDurableMeta(meta, normalizedRel);
        const content = durableMarkdown(meta);
        const resolved = resolveNotePath(extensionRoot, normalizedRel);
        assertMemoryRootAllowed(extensionRoot, resolved.rootStatus.memoryRoot);
        const mode = effectiveWriteMode(resolved.rootStatus, resolved.relPath);
        const redact = createEnvPolicyRedactor(extensionRoot);
        const previewContent = redact(content);
        const gate = evaluatePolicy(extensionRoot, {
            action: "memory_write",
            risk: "low",
            dryRun: mode !== "live",
            payload: { op: "createDurableNote", relPath: resolved.relPath, contentHash: hashPayload(previewContent) },
        });
        const canWrite = gate.decision === "AUTO" && mode === "live";
        if (canWrite) {
            withFileLock(path.join(resolved.rootStatus.memoryRoot, ".connect-ai-locks"), "memory-write", () => {
                fs.mkdirSync(path.dirname(resolved.fullPath), { recursive: true });
                fs.writeFileSync(resolved.fullPath, previewContent, { encoding: "utf8", flag: "wx" });
            });
        }
        appendAudit(storageRoot, {
            type: "memory_durable_note",
            payloadHash: gate.payloadHash,
            decision: gate.decision,
            actor: "memory-bridge",
            detail: { relPath: resolved.relPath, mode, wrote: canWrite, contentHash: hashPayload(previewContent) },
        });
        if (gate.decision === "FORBIDDEN") throw new Error("memory_write_forbidden");
        return { ok: true, mode, relPath: resolved.relPath, path: resolved.fullPath, previewContent, gate, wrote: canWrite };
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        appendRejectedWrite(storageRoot, { relPath: normalizedRel || meta.relPath, reason });
        const gate = evaluatePolicy(extensionRoot, {
            action: "memory_write",
            risk: "low",
            dryRun: true,
            payload: { op: "createDurableNoteRejected", relPath: normalizedRel || meta.relPath, reason },
        });
        return {
            ok: false,
            mode: "observe",
            relPath: normalizedRel || meta.relPath,
            path: "",
            previewContent: "",
            gate,
            wrote: false,
            reason,
        };
    }
}

export function createDecisionNote(extensionRoot: string, storageRoot: string, meta: DecisionNoteMeta, body: string): MemoryWriteResult {
    let relPath = "";
    try {
        const datePart = kstDate();
        const monthPart = datePart.slice(0, 7);
        relPath = `decisions/${monthPart}/${slugifyTitle(meta.title)}.md`;
        enforceDurableRelPathPolicy(extensionRoot, relPath);
        const content = decisionMarkdown(meta, body);
        const resolved = resolveNotePath(extensionRoot, relPath);
        assertMemoryRootAllowed(extensionRoot, resolved.rootStatus.memoryRoot);
        const mode = effectiveWriteMode(resolved.rootStatus, resolved.relPath);
        const redact = createEnvPolicyRedactor(extensionRoot);
        const previewContent = redact(content);
        const gate = evaluatePolicy(extensionRoot, {
            action: "memory_write",
            risk: "low",
            dryRun: mode !== "live",
            payload: { op: "createDecisionNote", relPath: resolved.relPath, contentHash: hashPayload(previewContent) },
        });
        const canWrite = gate.decision === "AUTO" && mode === "live";
        if (canWrite) {
            withFileLock(path.join(resolved.rootStatus.memoryRoot, ".connect-ai-locks"), "memory-write", () => {
                fs.mkdirSync(path.dirname(resolved.fullPath), { recursive: true });
                fs.writeFileSync(resolved.fullPath, previewContent, { encoding: "utf8", flag: "wx" });
            });
        }
        appendAudit(storageRoot, {
            type: "memory_decision_note",
            payloadHash: gate.payloadHash,
            decision: gate.decision,
            actor: "memory-bridge",
            detail: { relPath: resolved.relPath, mode, wrote: canWrite, contentHash: hashPayload(previewContent) },
        });
        if (gate.decision === "FORBIDDEN") throw new Error("memory_write_forbidden");
        return { ok: true, mode, relPath: resolved.relPath, path: resolved.fullPath, previewContent, gate, wrote: canWrite };
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        appendRejectedWrite(storageRoot, { relPath, reason });
        const gate = evaluatePolicy(extensionRoot, {
            action: "memory_write",
            risk: "low",
            dryRun: true,
            payload: { op: "createDecisionNoteRejected", relPath, reason },
        });
        return {
            ok: false,
            mode: "observe",
            relPath,
            path: "",
            previewContent: "",
            gate,
            wrote: false,
            reason,
        };
    }
}
