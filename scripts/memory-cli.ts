import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createDecisionNote, listNotes, readNote } from "../src/our/memory-bridge";

function extensionRoot(): string {
    return path.resolve(__dirname, "..");
}

function windowsPathToWsl(value: string): string {
    const match = value.match(/^([A-Za-z]):\\(.*)$/);
    if (!match) return value;
    return `/mnt/${match[1].toLowerCase()}/${match[2].replace(/\\/g, "/")}`;
}

function currentWindowsUser(): string {
    try {
        return process.env.CONNECT_AI_WINDOWS_USER || process.env.USERNAME || process.env.USER || os.userInfo().username || path.basename(os.homedir());
    } catch {
        return process.env.CONNECT_AI_WINDOWS_USER || process.env.USERNAME || process.env.USER || path.basename(os.homedir());
    }
}

function registerTempCleanup(tmpRoot: string): void {
    let cleaned = false;
    const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ }
    };
    process.once("exit", cleanup);
    process.once("SIGINT", () => { cleanup(); process.exit(130); });
    process.once("SIGTERM", () => { cleanup(); process.exit(143); });
    process.once("uncaughtException", (error) => { cleanup(); throw error; });
    process.once("unhandledRejection", (reason) => {
        cleanup();
        throw reason instanceof Error ? reason : new Error(String(reason));
    });
}

function bridgeExtensionRoot(): string {
    const root = extensionRoot();
    if (process.platform === "win32") return root;

    const configRoot = path.join(root, "config");
    const memoryPolicyPath = path.join(configRoot, "memory-policy.json");
    if (!fs.existsSync(memoryPolicyPath)) return root;

    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-cli-root-"));
    registerTempCleanup(tmpRoot);
    const tmpConfigRoot = path.join(tmpRoot, "config");
    fs.mkdirSync(tmpConfigRoot, { recursive: true });

    for (const name of ["tool-execution-policy.json", "env-policy.json", "memory-policy.json"]) {
        const src = path.join(configRoot, name);
        if (fs.existsSync(src)) fs.copyFileSync(src, path.join(tmpConfigRoot, name));
    }

    const tmpMemoryPolicyPath = path.join(tmpConfigRoot, "memory-policy.json");
    const policy = JSON.parse(fs.readFileSync(tmpMemoryPolicyPath, "utf8")) as { memoryRoot?: string };
    if (policy.memoryRoot) {
        policy.memoryRoot = windowsPathToWsl(policy.memoryRoot);
        fs.writeFileSync(tmpMemoryPolicyPath, JSON.stringify(policy, null, 2), "utf8");
    }
    return tmpRoot;
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

function usage(): never {
    throw new Error("Usage: memory-cli.ts list | read <relPath> | write-decision <title> <body>");
}

async function main(): Promise<void> {
    try {
        const command = process.argv[2];
        const extRoot = bridgeExtensionRoot();
        const storeRoot = storageRoot();

        if (command === "list") {
            process.stdout.write(`${JSON.stringify(listNotes(extRoot, storeRoot), null, 2)}\n`);
            return;
        }

        if (command === "read") {
            const relPath = process.argv[3];
            if (!relPath) usage();
            process.stdout.write(readNote(extRoot, storeRoot, relPath).content);
            return;
        }

        if (command === "write-decision") {
            const title = process.argv[3];
            const body = process.argv[4];
            if (!title || !body) usage();
            const result = createDecisionNote(extRoot, storeRoot, { title, dept: "connect-ai", status: "accepted" }, body);
            process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
            return;
        }

        usage();
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stdout.write(`${JSON.stringify({ error: message }, null, 2)}\n`);
        process.exit(1);
    }
}

void main();
