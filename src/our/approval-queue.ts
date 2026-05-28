import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { PolicyGateResult, PolicyRequest, hashPayload } from "./policy-gate";

export interface ApprovalRecord {
    type?: "approval";
    token: string;
    createdAt: string;
    used: boolean;
    payloadHash: string;
    request: PolicyRequest;
    decision: PolicyGateResult;
}

interface ApprovalUsedRecord {
    type: "approval_used";
    token: string;
    usedAt: string;
    payloadHash: string;
}

export interface AuditRecord {
    ts: string;
    type: string;
    payloadHash?: string;
    decision?: string;
    actor?: string;
    detail: unknown;
}

function ensureDir(dir: string): void {
    fs.mkdirSync(dir, { recursive: true });
}

function appendJsonl(filePath: string, record: unknown): void {
    ensureDir(path.dirname(filePath));
    fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, "utf8");
}

function readJsonl<T>(filePath: string): T[] {
    try {
        return fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as T);
    } catch {
        return [];
    }
}

export function phase2StorageRoot(storageRoot: string): string {
    return path.join(storageRoot, "phase2");
}

export function auditLogPath(storageRoot: string): string {
    return path.join(phase2StorageRoot(storageRoot), "audit-log.jsonl");
}

export function approvalQueuePath(storageRoot: string): string {
    return path.join(phase2StorageRoot(storageRoot), "approval-queue.jsonl");
}

export function appendAudit(storageRoot: string, record: Omit<AuditRecord, "ts">): void {
    appendJsonl(auditLogPath(storageRoot), { ts: new Date().toISOString(), ...record });
}

export function enqueueApproval(storageRoot: string, request: PolicyRequest, decision: PolicyGateResult): ApprovalRecord {
    const approvalPayloadHash = hashPayload(request.payload ?? request);
    const record: ApprovalRecord = {
        type: "approval",
        token: crypto.randomBytes(16).toString("hex"),
        createdAt: new Date().toISOString(),
        used: false,
        payloadHash: approvalPayloadHash,
        request,
        decision,
    };
    appendJsonl(approvalQueuePath(storageRoot), record);
    appendAudit(storageRoot, {
        type: "approval_enqueued",
        payloadHash: approvalPayloadHash,
        decision: decision.decision,
        actor: "policy-gate",
        detail: { action: request.action, departmentId: request.departmentId, toolId: request.toolId },
    });
    return record;
}

export function listApprovals(storageRoot: string): ApprovalRecord[] {
    const entries = readJsonl<ApprovalRecord | ApprovalUsedRecord>(approvalQueuePath(storageRoot));
    const usedTokens = new Set(entries.filter((entry): entry is ApprovalUsedRecord => entry.type === "approval_used").map((entry) => entry.token));
    return entries
        .filter((entry): entry is ApprovalRecord => entry.type !== "approval_used")
        .map((entry) => ({ ...entry, used: entry.used || usedTokens.has(entry.token) }));
}

export function consumeApproval(storageRoot: string, token: string, payload: unknown): { ok: boolean; reason: string } {
    const approvals = listApprovals(storageRoot);
    const record = approvals.find((item) => item.token === token);
    if (!record) return { ok: false, reason: "approval_token_not_found" };
    if (record.used) return { ok: false, reason: "approval_token_already_used" };
    if (record.payloadHash !== hashPayload(payload)) return { ok: false, reason: "approval_payload_hash_mismatch" };
    appendJsonl(approvalQueuePath(storageRoot), {
        type: "approval_used",
        token: record.token,
        usedAt: new Date().toISOString(),
        payloadHash: record.payloadHash,
    } satisfies ApprovalUsedRecord);
    appendAudit(storageRoot, {
        type: "approval_consumed",
        payloadHash: record.payloadHash,
        decision: record.decision.decision,
        actor: "user",
        detail: { token: `${token.slice(0, 6)}...` },
    });
    return { ok: true, reason: "approval_ok" };
}
