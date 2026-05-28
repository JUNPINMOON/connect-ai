import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { appendAudit } from "../src/our/approval-queue";
import { evaluatePolicy, PolicyRequest } from "../src/our/policy-gate";

function extensionRoot(): string {
    return path.resolve(__dirname, "..");
}

function currentWindowsUser(): string {
    try {
        return process.env.CONNECT_AI_WINDOWS_USER || process.env.USERNAME || process.env.USER || os.userInfo().username || path.basename(os.homedir());
    } catch {
        return process.env.CONNECT_AI_WINDOWS_USER || process.env.USERNAME || process.env.USER || path.basename(os.homedir());
    }
}

function storageRoot(): string {
    if (process.env.APPDATA) {
        return path.join(process.env.APPDATA, "Code", "User", "globalStorage", "connectailab.connect-ai-lab");
    }
    if (process.platform !== "win32") {
        const user = currentWindowsUser();
        const candidate = `/mnt/c/Users/${user}/AppData/Roaming/Code/User/globalStorage/connectailab.connect-ai-lab`;
        if (fs.existsSync("/mnt/c")) return candidate;
    }
    return path.join(os.homedir(), ".connect-ai", "globalStorage", "connectailab.connect-ai-lab");
}

function readStdin(): Promise<string> {
    return new Promise((resolve, reject) => {
        if (process.stdin.isTTY) {
            resolve("");
            return;
        }
        let data = "";
        const timeoutMs = Number(process.env.CONNECT_AI_STDIN_TIMEOUT_MS || 5000);
        const timer = setTimeout(() => resolve(data), timeoutMs);
        const finish = (fn: () => void) => {
            clearTimeout(timer);
            fn();
        };
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (chunk) => { data += chunk; });
        process.stdin.on("end", () => finish(() => resolve(data)));
        process.stdin.on("error", (error) => finish(() => reject(error)));
    });
}

async function readRequest(): Promise<PolicyRequest> {
    const raw = process.argv[2] || (await readStdin());
    if (!raw.trim()) throw new Error("PolicyRequest JSON required as argv[2] or stdin");
    return JSON.parse(raw) as PolicyRequest;
}

async function main(): Promise<void> {
    try {
        const request = await readRequest();
        const result = evaluatePolicy(extensionRoot(), request);
        appendAudit(storageRoot(), {
            type: "gate_check_cli",
            payloadHash: result.payloadHash,
            decision: result.decision,
            actor: "hermes-cli",
            detail: { action: request.action, departmentId: request.departmentId, toolId: request.toolId },
        });
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        if (result.decision === "FORBIDDEN") process.exit(1);
        if (result.decision === "APPROVAL") process.exit(2);
        process.exit(0);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stdout.write(`${JSON.stringify({ error: message }, null, 2)}\n`);
        process.exit(3);
    }
}

void main();
