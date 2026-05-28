export type DepartmentRisk = "low" | "medium" | "high";

export interface DepartmentCommandSpec {
    id: string;
    cwd: string;
    command: string;
}

export interface DepartmentSpec {
    id: string;
    name: string;
    role: string;
    root: string;
    risk: DepartmentRisk;
    mutable: boolean;
    approvalRequiredForRun: boolean;
    statusCommands?: DepartmentCommandSpec[];
    outputs?: string[];
    boundaries?: string[];
}

export interface ProjectRegistry {
    version: number;
    description?: string;
    departments: DepartmentSpec[];
}

export interface DepartmentStatus {
    spec: DepartmentSpec;
    rootExists: boolean;
    gitBranch?: string;
    gitDirtyCount?: number;
    gitStatusAvailable: boolean;
    latestModified?: string;
    outputs: Array<{
        path: string;
        exists: boolean;
        latestModified?: string;
    }>;
    warnings: string[];
}

export interface EnvPolicySummary {
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
