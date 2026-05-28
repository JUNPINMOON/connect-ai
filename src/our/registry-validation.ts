import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export interface RegistryValidationResult {
    ok: boolean;
    checkedAt: string;
    errors: string[];
    warnings: string[];
    memoryRoot?: {
        path: string;
        exists: boolean;
        outsideRepo: boolean;
        markdownCount: number;
    };
    files: Array<{
        path: string;
        exists: boolean;
        parseOk: boolean;
    }>;
}

interface ProjectRegistryLike {
    departments?: Array<{ id?: string; mutable?: boolean }>;
}

interface ToolRegistryLike {
    tools?: Array<{ id?: string; projectId?: string; mutable?: boolean; url?: string; host?: string; hostOverrideApproved?: boolean }>;
}

interface PortRegistryLike {
    ports?: Array<{ id?: string; host?: string; port?: number; mutable?: boolean; hostOverrideApproved?: boolean }>;
}

interface EnvPolicyLike {
    mutable?: boolean;
    departments?: Record<string, unknown>;
}

interface RuntimePolicyLike {
    host?: { defaultHostPolicy?: string; allowOverride?: boolean };
}

interface ModelPolicyLike {
    mutable?: boolean;
    guardrails?: { maxConcurrentWorkers?: number };
}

interface ToolExecutionPolicyLike {
    mutable?: boolean;
    tiers?: Record<string, unknown>;
}

interface MemoryPolicyLike {
    mutable?: boolean;
    memoryRoot?: string;
    allowedSubdirs?: string[];
    writeMode?: string;
    redact?: boolean;
}

interface PipelineLike {
    department?: string;
    stages?: Array<{ id?: string; risk?: string; worker?: string }>;
}

function readJson<T>(filePath: string, result: RegistryValidationResult): T | undefined {
    const exists = fs.existsSync(filePath);
    const record = { path: filePath, exists, parseOk: false };
    result.files.push(record);
    if (!exists) {
        result.errors.push(`missing file: ${filePath}`);
        return undefined;
    }
    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
        record.parseOk = true;
        return parsed;
    } catch (error) {
        result.errors.push(`invalid JSON: ${filePath} (${error instanceof Error ? error.message : String(error)})`);
        return undefined;
    }
}

function requireArray(value: unknown, name: string, result: RegistryValidationResult): boolean {
    if (Array.isArray(value)) return true;
    result.errors.push(`${name} must be an array`);
    return false;
}

function checkMutableFalse(items: Array<{ id?: string; mutable?: boolean }> | undefined, label: string, result: RegistryValidationResult): void {
    for (const item of items || []) {
        if (item.mutable !== false) {
            result.errors.push(`${label}:${item.id || "unknown"} must declare mutable:false`);
        }
    }
}

function hostFromUrl(url: string | undefined): string | undefined {
    if (!url) return undefined;
    try {
        return new URL(url).hostname;
    } catch {
        return undefined;
    }
}

function isInside(child: string, parent: string): boolean {
    const rel = path.relative(path.resolve(parent), path.resolve(child));
    return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

function countMarkdownFilesOutsideObsidian(root: string): number {
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

export function validateRegistries(extensionRoot: string): RegistryValidationResult {
    const configRoot = path.join(extensionRoot, "config");
    const result: RegistryValidationResult = {
        ok: false,
        checkedAt: new Date().toISOString(),
        errors: [],
        warnings: [],
        memoryRoot: undefined,
        files: [],
    };

    const project = readJson<ProjectRegistryLike>(path.join(configRoot, "project-registry.json"), result);
    const tool = readJson<ToolRegistryLike>(path.join(configRoot, "tool-registry.json"), result);
    const port = readJson<PortRegistryLike>(path.join(configRoot, "port-registry.json"), result);
    const envPolicy = readJson<EnvPolicyLike>(path.join(configRoot, "env-policy.json"), result);
    const runtimePolicy = readJson<RuntimePolicyLike>(path.join(configRoot, "runtime-policy.json"), result);
    const modelPolicy = readJson<ModelPolicyLike>(path.join(configRoot, "model-policy.json"), result);
    const toolExecutionPolicy = readJson<ToolExecutionPolicyLike>(path.join(configRoot, "tool-execution-policy.json"), result);
    const memoryPolicy = readJson<MemoryPolicyLike>(path.join(configRoot, "memory-policy.json"), result);

    const schemaRoot = path.join(configRoot, "schemas");
    for (const schemaName of ["project-registry.schema.json", "tool-registry.schema.json", "port-registry.schema.json", "env-policy.schema.json", "model-policy.schema.json", "tool-execution-policy.schema.json", "memory-policy.schema.json"]) {
        if (!fs.existsSync(path.join(schemaRoot, schemaName))) {
            result.warnings.push(`schema file missing: config/schemas/${schemaName}`);
        }
    }

    if (project && requireArray(project.departments, "project-registry.departments", result)) {
        checkMutableFalse(project.departments, "department", result);
    }
    if (tool && requireArray(tool.tools, "tool-registry.tools", result)) {
        checkMutableFalse(tool.tools, "tool", result);
    }
    if (port && requireArray(port.ports, "port-registry.ports", result)) {
        checkMutableFalse(port.ports, "port", result);
    }
    if (envPolicy?.mutable !== false) {
        result.errors.push("env-policy.mutable must be false");
    }
    if (modelPolicy?.mutable !== false) {
        result.errors.push("model-policy.mutable must be false");
    }
    if (toolExecutionPolicy?.mutable !== false) {
        result.errors.push("tool-execution-policy.mutable must be false");
    }
    if (memoryPolicy?.mutable !== false) {
        result.errors.push("memory-policy.mutable must be false");
    }
    if (!toolExecutionPolicy?.tiers?.AUTO || !toolExecutionPolicy?.tiers?.APPROVAL || !toolExecutionPolicy?.tiers?.FORBIDDEN) {
        result.errors.push("tool-execution-policy must define AUTO, APPROVAL, and FORBIDDEN tiers");
    }
    if (memoryPolicy) {
        const memoryRoot = path.resolve(memoryPolicy.memoryRoot || path.join(os.homedir(), "connect-ai-vault"));
        const exists = fs.existsSync(memoryRoot) && fs.statSync(memoryRoot).isDirectory();
        const outsideRepo = !isInside(memoryRoot, extensionRoot);
        const markdownCount = exists ? countMarkdownFilesOutsideObsidian(memoryRoot) : 0;
        result.memoryRoot = { path: memoryRoot, exists, outsideRepo, markdownCount };
        if (!exists) result.errors.push(`memory-policy memoryRoot missing: ${memoryRoot}`);
        if (!outsideRepo) result.errors.push("memory-policy memoryRoot must be outside the extension/repo root");
        if (memoryPolicy.writeMode !== "observe" && memoryPolicy.writeMode !== "live") {
            result.errors.push("memory-policy.writeMode must be observe or live");
        }
        if (memoryPolicy.redact !== true) result.errors.push("memory-policy.redact must be true");
        if (!Array.isArray(memoryPolicy.allowedSubdirs) || !memoryPolicy.allowedSubdirs.includes("decisions/")) {
            result.errors.push("memory-policy.allowedSubdirs must include decisions/");
        }
    }
    if ((modelPolicy?.guardrails?.maxConcurrentWorkers || 1) > 3) {
        result.warnings.push("model-policy maxConcurrentWorkers is above the recommended cap of 3");
    }

    const departmentIds = new Set((project?.departments || []).map((department) => department.id).filter(Boolean));
    const envDepartmentIds = new Set(Object.keys(envPolicy?.departments || {}));

    for (const toolSpec of tool?.tools || []) {
        if (toolSpec.projectId && !departmentIds.has(toolSpec.projectId)) {
            result.errors.push(`tool ${toolSpec.id || "unknown"} references missing projectId ${toolSpec.projectId}`);
        }
    }

    for (const departmentId of departmentIds) {
        if (!envDepartmentIds.has(String(departmentId))) {
            result.warnings.push(`env-policy missing department policy for ${departmentId}`);
        }
    }

    const seenPorts = new Set<string>();
    for (const portSpec of port?.ports || []) {
        const key = `${portSpec.host || "unknown"}:${portSpec.port}`;
        if (seenPorts.has(key)) result.errors.push(`duplicate port registry entry: ${key}`);
        seenPorts.add(key);
    }

    const defaultHost = runtimePolicy?.host?.defaultHostPolicy || "127.0.0.1";
    for (const toolSpec of tool?.tools || []) {
        const host = toolSpec.host || hostFromUrl(toolSpec.url);
        if (host && host !== defaultHost && toolSpec.hostOverrideApproved !== true) {
            result.errors.push(`tool ${toolSpec.id || "unknown"} host ${host} needs hostOverrideApproved:true`);
        }
    }
    for (const portSpec of port?.ports || []) {
        if (portSpec.host && portSpec.host !== defaultHost && portSpec.hostOverrideApproved !== true) {
            result.errors.push(`port ${portSpec.id || "unknown"} host ${portSpec.host} needs hostOverrideApproved:true`);
        }
    }

    const pipelineRoot = path.join(extensionRoot, "pipelines");
    if (fs.existsSync(pipelineRoot)) {
        for (const name of fs.readdirSync(pipelineRoot).filter((entry) => entry.endsWith(".pipeline.json"))) {
            const pipeline = readJson<PipelineLike>(path.join(pipelineRoot, name), result);
            if (!pipeline) continue;
            if (!pipeline.department || !departmentIds.has(pipeline.department)) {
                result.errors.push(`pipeline ${name} references missing department ${pipeline.department || "unknown"}`);
            }
            if (!Array.isArray(pipeline.stages) || pipeline.stages.length === 0) {
                result.errors.push(`pipeline ${name} must include at least one stage`);
            }
        }
    } else {
        result.warnings.push("pipelines directory missing");
    }

    result.ok = result.errors.length === 0;
    return result;
}

export function formatRegistryValidationMarkdown(result: RegistryValidationResult, redact: (value: unknown) => string = String): string {
    const lines = [
        "# Connect AI Registry Validation",
        "",
        `Checked: ${result.checkedAt}`,
        `Status: ${result.ok ? "PASS" : "FAIL"}`,
        "",
        "## Files",
        "",
    ];

    for (const file of result.files) {
        lines.push(`- ${file.exists ? "OK" : "MISSING"} ${file.parseOk ? "JSON OK" : "JSON NOT OK"} \`${redact(file.path)}\``);
    }

    lines.push("", "## Errors", "");
    if (result.errors.length) {
        result.errors.forEach((error) => lines.push(`- ${redact(error)}`));
    } else {
        lines.push("- none");
    }

    lines.push("", "## Warnings", "");
    if (result.warnings.length) {
        result.warnings.forEach((warning) => lines.push(`- ${redact(warning)}`));
    } else {
        lines.push("- none");
    }

    if (result.memoryRoot) {
        lines.push("", "## Memory Root", "");
        lines.push(`- path: \`${redact(result.memoryRoot.path)}\``);
        lines.push(`- exists: \`${result.memoryRoot.exists}\``);
        lines.push(`- outsideRepo: \`${result.memoryRoot.outsideRepo}\``);
        lines.push(`- markdownCount: \`${result.memoryRoot.markdownCount}\``);
    }

    return lines.join("\n");
}
