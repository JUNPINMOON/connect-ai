import * as fs from "fs";
import * as path from "path";
import { appendAudit } from "./approval-queue";
import { evaluatePolicy, PolicyRisk } from "./policy-gate";
import { getTrustStage, recordTrustOutcome } from "./trust-ramp";

export interface PipelineStage {
    id: string;
    name?: string;
    worker?: string;
    inputs?: string[];
    output?: string;
    risk?: PolicyRisk;
    gate?: string;
    review?: unknown;
}

export interface PipelineSpec {
    department: string;
    root: string;
    risk: PolicyRisk;
    artifactsDir?: string;
    stages: PipelineStage[];
}

export interface PipelineRunResult {
    ok: boolean;
    runId: string;
    department: string;
    artifactDir: string;
    stages: Array<{
        id: string;
        decision: string;
        trustMode: string;
        outputPath: string;
        message: string;
    }>;
}

function readPipeline(filePath: string): PipelineSpec {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as PipelineSpec;
    if (!parsed.department || !Array.isArray(parsed.stages)) {
        throw new Error(`Invalid pipeline spec: ${filePath}`);
    }
    return parsed;
}

export function runPipelineObserve(extensionRoot: string, storageRoot: string, pipelineName: string): PipelineRunResult {
    const pipelinePath = path.join(extensionRoot, "pipelines", `${pipelineName}.pipeline.json`);
    const spec = readPipeline(pipelinePath);
    const runId = new Date().toISOString().replace(/[:.]/g, "-");
    const artifactDir = path.join(storageRoot, "phase2", "artifacts", spec.department, runId);
    fs.mkdirSync(artifactDir, { recursive: true });

    const stages = spec.stages.map((stage) => {
        const stageKey = `${spec.department}.${stage.id}`;
        const trust = getTrustStage(storageRoot, stageKey);
        const gate = evaluatePolicy(extensionRoot, {
            action: "pipeline_stage",
            departmentId: spec.department,
            risk: stage.risk || spec.risk || "low",
            worker: stage.worker,
            payload: { pipelineName, stageId: stage.id, mode: trust.mode },
            externalSend: /publish|send|upload/i.test(stage.id) || /APPROVAL/i.test(stage.gate || ""),
        });
        const outputPath = path.join(artifactDir, `${stage.id}.observe.json`);
        const record = {
            stage,
            trustMode: trust.mode,
            gate,
            observeOnly: true,
            note: "Phase 2 runner does not execute workers yet. It validates policy flow and artifact handoff only.",
        };
        fs.writeFileSync(outputPath, JSON.stringify(record, null, 2), "utf8");
        recordTrustOutcome(storageRoot, stageKey, gate.decision !== "FORBIDDEN", !!stage.review);
        appendAudit(storageRoot, {
            type: "pipeline_stage_observed",
            payloadHash: gate.payloadHash,
            decision: gate.decision,
            actor: "pipeline-runner",
            detail: { pipelineName, stageId: stage.id, worker: stage.worker, artifact: outputPath },
        });
        return {
            id: stage.id,
            decision: gate.decision,
            trustMode: trust.mode,
            outputPath,
            message: gate.decision === "FORBIDDEN" ? "blocked" : "observed_no_execution",
        };
    });

    const result: PipelineRunResult = {
        ok: stages.every((stage) => stage.decision !== "FORBIDDEN"),
        runId,
        department: spec.department,
        artifactDir,
        stages,
    };
    fs.writeFileSync(path.join(artifactDir, "pipeline-run.json"), JSON.stringify(result, null, 2), "utf8");
    return result;
}
