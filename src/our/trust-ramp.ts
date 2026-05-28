import * as fs from "fs";
import * as path from "path";
import { appendAudit } from "./approval-queue";

export type TrustMode = "observe" | "assist" | "auto";

export interface TrustStageState {
    id: string;
    mode: TrustMode;
    successStreak: number;
    failureCount: number;
    reviewerPassCount: number;
    lastUpdated: string;
}

export interface TrustRampState {
    version: number;
    stages: Record<string, TrustStageState>;
}

function statePath(storageRoot: string): string {
    return path.join(storageRoot, "phase2", "trust-ramp.json");
}

function readState(storageRoot: string): TrustRampState {
    try {
        return JSON.parse(fs.readFileSync(statePath(storageRoot), "utf8")) as TrustRampState;
    } catch {
        return { version: 1, stages: {} };
    }
}

function writeState(storageRoot: string, state: TrustRampState): void {
    fs.mkdirSync(path.dirname(statePath(storageRoot)), { recursive: true });
    fs.writeFileSync(statePath(storageRoot), JSON.stringify(state, null, 2), "utf8");
}

export function getTrustStage(storageRoot: string, stageId: string): TrustStageState {
    const state = readState(storageRoot);
    return state.stages[stageId] || {
        id: stageId,
        mode: "observe",
        successStreak: 0,
        failureCount: 0,
        reviewerPassCount: 0,
        lastUpdated: new Date().toISOString(),
    };
}

export function recordTrustOutcome(storageRoot: string, stageId: string, passed: boolean, reviewerPassed = false): TrustStageState {
    const state = readState(storageRoot);
    const current = getTrustStage(storageRoot, stageId);
    const next: TrustStageState = {
        ...current,
        successStreak: passed ? current.successStreak + 1 : 0,
        failureCount: passed ? current.failureCount : current.failureCount + 1,
        reviewerPassCount: reviewerPassed ? current.reviewerPassCount + 1 : current.reviewerPassCount,
        mode: passed ? current.mode : downgrade(current.mode),
        lastUpdated: new Date().toISOString(),
    };
    state.stages[stageId] = next;
    writeState(storageRoot, state);
    appendAudit(storageRoot, { type: "trust_ramp_outcome", actor: "trust-ramp", detail: next });
    return next;
}

export function canRequestPromotion(stage: TrustStageState, risk: string): boolean {
    return stage.successStreak >= 10 && stage.reviewerPassCount >= 3 && risk !== "high" && stage.mode !== "auto";
}

function downgrade(mode: TrustMode): TrustMode {
    if (mode === "auto") return "assist";
    if (mode === "assist") return "observe";
    return "observe";
}
