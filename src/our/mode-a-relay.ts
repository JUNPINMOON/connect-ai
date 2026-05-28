import * as fs from "fs";
import * as path from "path";
import { appendAudit } from "./approval-queue";
import { createEnvPolicyRedactor } from "./env-policy";
import { evaluatePolicy } from "./policy-gate";

export interface RelayPrepareRequest {
    title: string;
    prompt: string;
    departmentId?: string;
    contextFiles?: string[];
}

export interface RelayPrepareResult {
    ok: boolean;
    relayId: string;
    mode: "observe";
    promptPath: string;
    resultPath: string;
    gateDecision: string;
    message: string;
}

function safeName(value: string): string {
    return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "relay";
}

export function prepareModeARelay(extensionRoot: string, storageRoot: string, request: RelayPrepareRequest): RelayPrepareResult {
    const redact = createEnvPolicyRedactor(extensionRoot);
    const relayId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${safeName(request.title)}`;
    const dir = path.join(storageRoot, "phase2", "relay", relayId);
    fs.mkdirSync(dir, { recursive: true });

    const gate = evaluatePolicy(extensionRoot, {
        action: "relay_prepare",
        departmentId: request.departmentId,
        risk: "medium",
        payload: { title: request.title, contextFiles: request.contextFiles || [] },
    });

    const prepared = [
        "# Claude Mode A Relay Prompt",
        "",
        `Title: ${redact(request.title)}`,
        `Department: ${request.departmentId || "n/a"}`,
        "",
        "## Instructions",
        "",
        "사용자가 직접 Claude 앱/Claude Code에 붙여넣는 Mode A 프롬프트입니다.",
        "이 파일은 자동 전송되지 않습니다.",
        "",
        "## Prompt",
        "",
        redact(request.prompt),
        "",
        "## Result Capture",
        "",
        "Claude 응답을 아래 result.md 또는 result.json으로 직접 저장하면 Hermes/Connect AI가 회수합니다.",
    ].join("\n");

    const promptPath = path.join(dir, "prompt.md");
    const resultPath = path.join(dir, "result.md");
    fs.writeFileSync(promptPath, prepared, "utf8");
    fs.writeFileSync(resultPath, "", "utf8");

    appendAudit(storageRoot, {
        type: "mode_a_relay_prepared",
        payloadHash: gate.payloadHash,
        decision: gate.decision,
        actor: "mode-a-relay",
        detail: { relayId, departmentId: request.departmentId, promptPath, resultPath },
    });

    return {
        ok: gate.decision !== "FORBIDDEN",
        relayId,
        mode: "observe",
        promptPath,
        resultPath,
        gateDecision: gate.decision,
        message: "prepared_for_human_tab_no_gui_automation",
    };
}
