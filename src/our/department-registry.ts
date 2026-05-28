import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";
import { DepartmentSpec, DepartmentStatus, EnvPolicySummary, ProjectRegistry } from "./department-types";

const DEFAULT_REGISTRY: ProjectRegistry = {
    version: 1,
    description: "Fallback read-only registry bundled in code.",
    departments: [],
};

function readJsonFile<T>(filePath: string, fallback: T): T {
    try {
        const raw = fs.readFileSync(filePath, "utf8");
        return JSON.parse(raw) as T;
    } catch {
        return fallback;
    }
}

function safeStat(filePath: string): fs.Stats | undefined {
    try {
        return fs.statSync(filePath);
    } catch {
        return undefined;
    }
}

function latestMtimeInDirectory(dir: string, maxFiles = 250): Date | undefined {
    const pending = [dir];
    let checked = 0;
    let latest: Date | undefined;

    while (pending.length && checked < maxFiles) {
        const current = pending.shift();
        if (!current) continue;

        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(current, { withFileTypes: true });
        } catch {
            continue;
        }

        for (const entry of entries) {
            if (checked >= maxFiles) break;
            if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "__pycache__") continue;

            const full = path.join(current, entry.name);
            const stat = safeStat(full);
            checked += 1;
            if (stat && (!latest || stat.mtime > latest)) latest = stat.mtime;
            if (entry.isDirectory()) pending.push(full);
        }
    }

    return latest;
}

function runGit(root: string, args: string[]): string | undefined {
    const result = spawnSync("git", ["-C", root, ...args], {
        encoding: "utf8",
        timeout: 5000,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    if (result.error || result.status !== 0) return undefined;
    return (result.stdout || "").trim();
}

function inspectDepartment(spec: DepartmentSpec): DepartmentStatus {
    const rootExists = !!safeStat(spec.root)?.isDirectory();
    const warnings: string[] = [];
    let gitBranch: string | undefined;
    let gitDirtyCount: number | undefined;
    let gitStatusAvailable = false;
    let latestModified: string | undefined;

    if (!rootExists) {
        warnings.push("root_missing");
    } else {
        const branch = runGit(spec.root, ["branch", "--show-current"]);
        const status = runGit(spec.root, ["status", "--short"]);
        gitStatusAvailable = branch !== undefined || status !== undefined;
        gitBranch = branch || undefined;
        gitDirtyCount = status ? status.split(/\r?\n/).filter(Boolean).length : 0;
        latestModified = latestMtimeInDirectory(spec.root)?.toISOString();
        if (gitDirtyCount && gitDirtyCount > 0) warnings.push("dirty_worktree");
        if (!gitStatusAvailable) warnings.push("git_status_unavailable");
    }

    const outputs = (spec.outputs || []).map((relativeOutput) => {
        const full = path.resolve(spec.root, relativeOutput);
        const stat = safeStat(full);
        const nestedLatest = stat?.isDirectory() ? latestMtimeInDirectory(full, 100) : stat?.mtime;
        return {
            path: relativeOutput,
            exists: !!stat,
            latestModified: nestedLatest?.toISOString(),
        };
    });

    if (spec.risk === "high") warnings.push("high_risk_read_only");
    if (spec.mutable) warnings.push("mutable_registry_entry");

    return {
        spec,
        rootExists,
        gitBranch,
        gitDirtyCount,
        gitStatusAvailable,
        latestModified,
        outputs,
        warnings,
    };
}

export function loadProjectRegistry(extensionRoot: string): ProjectRegistry {
    const registryPath = path.join(extensionRoot, "config", "project-registry.json");
    const registry = readJsonFile<ProjectRegistry>(registryPath, DEFAULT_REGISTRY);
    return {
        ...registry,
        departments: Array.isArray(registry.departments) ? registry.departments : [],
    };
}

export function inspectRegisteredDepartments(extensionRoot: string): DepartmentStatus[] {
    const registry = loadProjectRegistry(extensionRoot);
    return registry.departments.map(inspectDepartment);
}

export function formatDepartmentStatusMarkdown(statuses: DepartmentStatus[], envPolicy?: EnvPolicySummary, redact: (value: unknown) => string = String): string {
    const lines: string[] = [
        "# Connect AI Department Registry Status",
        "",
        `Generated: ${new Date().toISOString()}`,
        "",
        "This report is read-only. It does not run department commands, call external APIs, or modify linked projects.",
        "",
        "## Safety Policy",
        "",
        `- env-policy loaded: \`${envPolicy?.loaded ?? false}\``,
        `- env-policy mutable: \`${envPolicy?.mutable ?? "n/a"}\``,
        `- readable allow patterns: \`${envPolicy?.readableAllowCount ?? 0}\``,
        `- forbidden name words: \`${envPolicy?.forbiddenNameWordsCount ?? 0}\``,
        `- forbidden print patterns: \`${envPolicy?.forbiddenPrintCount ?? 0}\``,
        `- department env policies: \`${envPolicy?.departmentPolicyCount ?? 0}\``,
        `- redaction surfaces: \`${envPolicy?.appliesToCount ?? 0}\``,
        `- env-policy warnings: ${envPolicy?.warnings?.length ? envPolicy.warnings.map(redact).join(", ") : "-"}`,
        "",
        "| Department | Risk | Root | Git | Dirty | Outputs | Warnings |",
        "|---|---:|---|---|---:|---:|---|",
    ];

    for (const status of statuses) {
        const outputCount = status.outputs.filter((output) => output.exists).length;
        const git = status.gitStatusAvailable ? (status.gitBranch || "detached/unknown") : "n/a";
        lines.push([
            status.spec.name,
            status.spec.risk,
            status.rootExists ? "OK" : "MISSING",
            git,
            String(status.gitDirtyCount ?? 0),
            `${outputCount}/${status.outputs.length}`,
            status.warnings.map(redact).join(", ") || "-",
        ].map((cell) => String(cell).replace(/\|/g, "\\|")).join(" | ").replace(/^/, "| ").replace(/$/, " |"));
    }

    lines.push("");
    for (const status of statuses) {
        lines.push(`## ${status.spec.name}`);
        lines.push("");
        lines.push(`- id: \`${status.spec.id}\``);
        lines.push(`- role: ${status.spec.role}`);
        lines.push(`- root: \`${redact(status.spec.root)}\``);
        lines.push(`- risk: \`${status.spec.risk}\``);
        lines.push(`- mutable: \`${status.spec.mutable}\``);
        lines.push(`- approvalRequiredForRun: \`${status.spec.approvalRequiredForRun}\``);
        lines.push(`- latestModified: ${status.latestModified || "n/a"}`);
        if (status.spec.boundaries?.length) {
            lines.push(`- boundaries: ${status.spec.boundaries.join("; ")}`);
        }
        if (status.outputs.length) {
            lines.push("- outputs:");
            for (const output of status.outputs) {
                lines.push(`  - ${output.exists ? "OK" : "MISSING"} \`${output.path}\`${output.latestModified ? ` (${output.latestModified})` : ""}`);
            }
        }
        lines.push("");
    }

    return lines.join("\n");
}
