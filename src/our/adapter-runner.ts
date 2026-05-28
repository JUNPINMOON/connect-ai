import { appendAudit, enqueueApproval } from "./approval-queue";
import { inspectRegisteredDepartments } from "./department-registry";
import { DepartmentStatus } from "./department-types";
import { evaluatePolicy, PolicyGateResult, PolicyRisk } from "./policy-gate";

export interface AdapterRunResult {
    ok: boolean;
    mode: "status" | "artifacts" | "validate" | "run";
    departmentId: string;
    dryRun: boolean;
    gate: PolicyGateResult;
    approvalToken?: string;
    message: string;
    status?: DepartmentStatus;
}

function findDepartment(extensionRoot: string, departmentId: string): DepartmentStatus | undefined {
    return inspectRegisteredDepartments(extensionRoot).find((status) => status.spec.id === departmentId);
}

function riskOf(status: DepartmentStatus | undefined): PolicyRisk {
    return status?.spec.risk || "low";
}

export function adapterStatus(extensionRoot: string, storageRoot: string, departmentId: string): AdapterRunResult {
    const status = findDepartment(extensionRoot, departmentId);
    const gate = evaluatePolicy(extensionRoot, { action: "status", departmentId, risk: riskOf(status), payload: { departmentId } });
    appendAudit(storageRoot, { type: "adapter_status", payloadHash: gate.payloadHash, decision: gate.decision, actor: "adapter-runner", detail: { departmentId } });
    return { ok: !!status && gate.decision !== "FORBIDDEN", mode: "status", departmentId, dryRun: true, gate, message: status ? "status_ready" : "department_not_found", status };
}

export function adapterArtifacts(extensionRoot: string, storageRoot: string, departmentId: string): AdapterRunResult {
    const status = findDepartment(extensionRoot, departmentId);
    const gate = evaluatePolicy(extensionRoot, { action: "artifacts", departmentId, risk: riskOf(status), payload: { outputs: status?.outputs || [] } });
    appendAudit(storageRoot, { type: "adapter_artifacts", payloadHash: gate.payloadHash, decision: gate.decision, actor: "adapter-runner", detail: { departmentId, outputs: status?.outputs?.length || 0 } });
    return { ok: !!status && gate.decision !== "FORBIDDEN", mode: "artifacts", departmentId, dryRun: true, gate, message: status ? "artifacts_ready" : "department_not_found", status };
}

export function adapterValidate(extensionRoot: string, storageRoot: string, departmentId: string): AdapterRunResult {
    const status = findDepartment(extensionRoot, departmentId);
    const gate = evaluatePolicy(extensionRoot, { action: "validate", departmentId, risk: riskOf(status), payload: { warnings: status?.warnings || [] } });
    appendAudit(storageRoot, { type: "adapter_validate", payloadHash: gate.payloadHash, decision: gate.decision, actor: "adapter-runner", detail: { departmentId, warnings: status?.warnings || [] } });
    return { ok: !!status && gate.decision !== "FORBIDDEN" && !status.warnings.includes("root_missing"), mode: "validate", departmentId, dryRun: true, gate, message: status ? "validate_completed" : "department_not_found", status };
}

export function adapterRun(extensionRoot: string, storageRoot: string, departmentId: string, dryRun = true): AdapterRunResult {
    const status = findDepartment(extensionRoot, departmentId);
    const gate = evaluatePolicy(extensionRoot, {
        action: "run",
        departmentId,
        risk: riskOf(status),
        dryRun,
        reversible: false,
        payload: { departmentId, dryRun, approvalRequiredForRun: status?.spec.approvalRequiredForRun },
    });

    appendAudit(storageRoot, { type: "adapter_run_requested", payloadHash: gate.payloadHash, decision: gate.decision, actor: "adapter-runner", detail: { departmentId, dryRun } });

    if (gate.decision === "FORBIDDEN") {
        return { ok: false, mode: "run", departmentId, dryRun, gate, message: "forbidden_blocked_in_code", status };
    }
    if (gate.decision === "APPROVAL") {
        const approval = enqueueApproval(storageRoot, { action: "run", departmentId, risk: riskOf(status), dryRun, payload: { departmentId, dryRun } }, gate);
        return { ok: false, mode: "run", departmentId, dryRun, gate, approvalToken: approval.token, message: "approval_required_no_execution", status };
    }

    return { ok: true, mode: "run", departmentId, dryRun, gate, message: dryRun ? "dry_run_only_no_command_executed" : "run_allowed_but_no_executor_implemented", status };
}
