import * as fs from "fs";
import * as path from "path";

export interface EnvPolicyStatus {
    loaded: boolean;
    path: string;
    version?: number;
    mutable?: boolean;
    readableAllowCount: number;
    forbiddenNameWordsCount: number;
    forbiddenPrintCount: number;
    departmentPolicyCount: number;
    appliesToCount: number;
    warnings: string[];
}

interface EnvPolicy {
    version?: number;
    mutable?: boolean;
    appliesTo?: string[];
    global?: {
        readableAllow?: string[];
        forbiddenNameWords?: string[];
        forbiddenPrint?: string[];
    };
    departments?: Record<string, unknown>;
}

const FALLBACK_FORBIDDEN_WORDS = [
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
    "KIS",
];

function readJsonFile<T>(filePath: string): T | undefined {
    try {
        return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
    } catch {
        return undefined;
    }
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function globToRegExp(glob: string): RegExp {
    const body = glob.split("*").map(escapeRegExp).join(".*");
    return new RegExp(`^${body}$`, "i");
}

function arrayOfStrings(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function isSensitiveName(name: string, forbiddenWords: string[], forbiddenPrint: string[]): boolean {
    const upper = name.toUpperCase();
    if (forbiddenWords.some((word) => upper.includes(word.toUpperCase()))) return true;
    return forbiddenPrint.map(globToRegExp).some((pattern) => pattern.test(name));
}

function buildStatus(policyPath: string, policy: EnvPolicy | undefined): EnvPolicyStatus {
    const global = policy?.global || {};
    const warnings: string[] = [];
    if (!policy) warnings.push("env_policy_missing_or_invalid");
    if (policy?.mutable !== false) warnings.push("env_policy_mutable_not_false");

    return {
        loaded: !!policy,
        path: policyPath,
        version: policy?.version,
        mutable: policy?.mutable,
        readableAllowCount: arrayOfStrings(global.readableAllow).length,
        forbiddenNameWordsCount: arrayOfStrings(global.forbiddenNameWords).length,
        forbiddenPrintCount: arrayOfStrings(global.forbiddenPrint).length,
        departmentPolicyCount: policy?.departments ? Object.keys(policy.departments).length : 0,
        appliesToCount: arrayOfStrings(policy?.appliesTo).length,
        warnings,
    };
}

export function loadEnvPolicyStatus(extensionRoot: string): EnvPolicyStatus {
    const policyPath = path.join(extensionRoot, "config", "env-policy.json");
    const policy = readJsonFile<EnvPolicy>(policyPath);
    return buildStatus(policyPath, policy);
}

export function createEnvPolicyRedactor(extensionRoot: string): (value: unknown) => string {
    const policyPath = path.join(extensionRoot, "config", "env-policy.json");
    const policy = readJsonFile<EnvPolicy>(policyPath);
    const forbiddenWords = arrayOfStrings(policy?.global?.forbiddenNameWords);
    const forbiddenPrint = arrayOfStrings(policy?.global?.forbiddenPrint);
    const words = forbiddenWords.length ? forbiddenWords : FALLBACK_FORBIDDEN_WORDS;

    return (value: unknown): string => {
        let text = typeof value === "string" ? value : String(value);

        // Mask environment-style assignments without reading process.env values.
        text = text.replace(/\b([A-Za-z_][A-Za-z0-9_]{1,100})\b\s*([:=])\s*("[^"]*"|'[^']*'|[^\s,;}]+)/g, (match, name: string, separator: string) => {
            if (!isSensitiveName(name, words, forbiddenPrint)) return match;
            return `${name}${separator}***`;
        });

        // Mask standalone bearer/API-looking values that may appear without a variable name.
        text = text.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi, "Bearer ***");
        text = text.replace(/\b(?:sk-|sk_live_|sk_test_|gh[pousr]_|AIza|ya29\.)[A-Za-z0-9._-]{12,}\b/g, "***");

        return text;
    };
}
