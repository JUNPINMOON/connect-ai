import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

export type PolicyDecision = "AUTO" | "APPROVAL" | "FORBIDDEN";
export type PolicyRisk = "low" | "medium" | "high";

export interface PolicyRequest {
    action: string;
    departmentId?: string;
    toolId?: string;
    risk?: PolicyRisk;
    command?: string;
    worker?: string;
    payload?: unknown;
    reversible?: boolean;
    dryRun?: boolean;
    externalSend?: boolean;
    touchesSecrets?: boolean;
    mutatesOutsideProject?: boolean;
    costEstimateUsd?: number;
}

export interface PolicyGateResult {
    decision: PolicyDecision;
    risk: PolicyRisk;
    payloadHash: string;
    reasons: string[];
    policyLoaded: boolean;
}

interface ToolExecutionPolicy {
    mutable?: boolean;
}

const FORBIDDEN_PATTERNS: RegExp[] = [
    /\b(rm\s+-rf|rmdir\s+\/s|del\s+\/s|format\b|mkfs\b)\b/i,
    /\bgit\s+(reset\s+--hard|clean\s+-fdx|push\s+--force|branch\s+-D)\b/i,
    /\b(KIS|broker|order\s+placement|live\s+trade|token\s+refresh)\b/i,
    /(^|[\\\/])\.env(\.|$|[\\\/])/i,
    /\b(api[_-]?key|secret|password|refresh[_-]?token|access[_-]?token|cookie)\b/i,
];

const SAFE_AUTO_ACTIONS = new Set([
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
    "memory_write",
]);

function readJson<T>(filePath: string): T | undefined {
    try {
        return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
    } catch {
        return undefined;
    }
}

function stableStringify(value: unknown): string {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

export function hashPayload(payload: unknown): string {
    return crypto.createHash("sha256").update(stableStringify(payload)).digest("hex");
}

function normalizeRisk(risk: PolicyRisk | undefined): PolicyRisk {
    return risk || "low";
}

export function evaluatePolicy(extensionRoot: string, request: PolicyRequest): PolicyGateResult {
    const policyPath = path.join(extensionRoot, "config", "tool-execution-policy.json");
    const policy = readJson<ToolExecutionPolicy>(policyPath);
    const reasons: string[] = [];
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
        dryRun: request.dryRun !== false,
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
