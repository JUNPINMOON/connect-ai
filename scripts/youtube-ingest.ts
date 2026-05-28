import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";
import { appendAudit } from "../src/our/approval-queue";
import { createEnvPolicyRedactor } from "../src/our/env-policy";
import { createDecisionNote, createDurableNote } from "../src/our/memory-bridge";
import { evaluatePolicy, hashPayload } from "../src/our/policy-gate";

interface YtDlpInfo {
    title?: string;
    channel?: string;
    uploader?: string;
    view_count?: number;
    duration?: number;
    description?: string;
    upload_date?: string;
    tags?: string[];
    webpage_url?: string;
    requested_subtitles?: Record<string, unknown>;
    subtitles?: Record<string, unknown>;
    automatic_captions?: Record<string, unknown>;
}

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
        if (fs.existsSync("/mnt/c")) {
            return `/mnt/c/Users/${user}/AppData/Roaming/Code/User/globalStorage/connectailab.connect-ai-lab`;
        }
    }
    return path.join(os.homedir(), ".connect-ai", "globalStorage", "connectailab.connect-ai-lab");
}

function windowsPathToWsl(value: string): string {
    const match = value.match(/^([A-Za-z]):\\(.*)$/);
    if (!match) return value;
    return `/mnt/${match[1].toLowerCase()}/${match[2].replace(/\\/g, "/")}`;
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
}

function bridgeExtensionRoot(): string {
    const root = extensionRoot();
    if (process.platform === "win32") return root;
    const configRoot = path.join(root, "config");
    const memoryPolicyPath = path.join(configRoot, "memory-policy.json");
    if (!fs.existsSync(memoryPolicyPath)) return root;

    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-yt-root-"));
    registerTempCleanup(tmpRoot);
    const tmpConfigRoot = path.join(tmpRoot, "config");
    fs.mkdirSync(tmpConfigRoot, { recursive: true });
    for (const name of ["tool-execution-policy.json", "env-policy.json", "memory-policy.json"]) {
        const src = path.join(configRoot, name);
        if (fs.existsSync(src)) fs.copyFileSync(src, path.join(tmpConfigRoot, name));
    }
    const policyPath = path.join(tmpConfigRoot, "memory-policy.json");
    const policy = JSON.parse(fs.readFileSync(policyPath, "utf8")) as { memoryRoot?: string };
    if (policy.memoryRoot) {
        policy.memoryRoot = windowsPathToWsl(policy.memoryRoot);
        fs.writeFileSync(policyPath, JSON.stringify(policy, null, 2), "utf8");
    }
    return tmpRoot;
}

function findYtDlp(): string {
    // Set YTDLP_PATH for a custom binary; otherwise rely on PATH and common user-local installs.
    const candidates = [
        process.env.YTDLP_PATH,
        "yt-dlp",
        "yt-dlp.exe",
        path.join(os.homedir(), ".local", "bin", "yt-dlp"),
    ].filter(Boolean) as string[];
    for (const candidate of candidates) {
        const probe = spawnSync(candidate, ["--version"], { encoding: "utf8", timeout: 15000 });
        if (probe.status === 0) return candidate;
    }
    throw new Error("yt-dlp not found. Install yt-dlp or set YTDLP_PATH.");
}

function runYtDlp(binary: string, args: string[], timeout = 120000): string {
    const result = spawnSync(binary, args, { encoding: "utf8", timeout, maxBuffer: 20 * 1024 * 1024 });
    if (result.status !== 0) {
        throw new Error(`yt-dlp failed: ${(result.stderr || result.stdout || "unknown").slice(0, 1000)}`);
    }
    return result.stdout;
}

function cleanSubtitle(text: string): string {
    return text
        .replace(/\r/g, "")
        .replace(/^WEBVTT.*$/gmi, "")
        .replace(/^\d+$/gm, "")
        .replace(/^\d{2}:\d{2}:\d{2}[.,]\d{3}\s+-->\s+.*$/gm, "")
        .replace(/<[^>]+>/g, "")
        .replace(/\{\\an\d+\}/g, "")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .filter((line, index, lines) => index === 0 || line !== lines[index - 1])
        .join("\n")
        .slice(0, 3000);
}

function collectTranscript(workDir: string): string | null {
    const files = fs.readdirSync(workDir)
        .filter((name) => /\.(vtt|srt)$/i.test(name))
        .map((name) => path.join(workDir, name));
    for (const file of files) {
        const text = cleanSubtitle(fs.readFileSync(file, "utf8"));
        if (text.trim()) return text;
    }
    return null;
}

function publishDate(uploadDate?: string): string | undefined {
    if (!uploadDate || !/^\d{8}$/.test(uploadDate)) return uploadDate;
    return `${uploadDate.slice(0, 4)}-${uploadDate.slice(4, 6)}-${uploadDate.slice(6, 8)}`;
}

function slugifyTitle(title: string): string {
    const ascii = title.normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-").toLowerCase();
    return ascii.slice(0, 70) || "youtube-video";
}

function safeJoinInside(root: string, relPath: string): string {
    const full = path.resolve(root, relPath);
    const rel = path.relative(root, full);
    if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("resolved path escaped vault");
    return full;
}

function detectVisual(title: string, tags: string[], transcript: string | null): { needsVisual: boolean; reason: string | null } {
    if (!transcript) return { needsVisual: true, reason: "자막 없음" };
    const visualWords = ["tutorial", "review", "unboxing", "infographic", "shorts", "먹방", "브이로그"];
    const haystack = `${title} ${tags.join(" ")}`.toLowerCase();
    const match = visualWords.find((word) => haystack.includes(word.toLowerCase()));
    if (match) return { needsVisual: true, reason: "시각 콘텐츠 유형" };
    return { needsVisual: false, reason: null };
}

async function main(): Promise<void> {
    try {
        const url = process.argv[2];
        if (!url) throw new Error("Usage: youtube-ingest.ts <YouTube URL>");
        const extRoot = bridgeExtensionRoot();
        const storeRoot = storageRoot();
        const redact = createEnvPolicyRedactor(extRoot);
        const ytDlp = findYtDlp();

        const metadata = JSON.parse(runYtDlp(ytDlp, ["--dump-json", "--skip-download", url])) as YtDlpInfo;
        const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-yt-"));
        try {
            runYtDlp(ytDlp, [
                "--write-sub",
                "--write-auto-sub",
                "--sub-lang", "ko,en",
                "--skip-download",
                "--output", path.join(workDir, "yt-%(id)s"),
                url,
            ], 180000);
        } catch {
            // Subtitle availability varies by video and YouTube response. Metadata ingest can still proceed.
        }
        let transcript = collectTranscript(workDir);
        if (!transcript) {
            try {
                runYtDlp(ytDlp, [
                    "--write-sub",
                    "--write-auto-sub",
                    "--sub-lang", "en",
                    "--skip-download",
                    "--output", path.join(workDir, "yt-%(id)s-en-fallback"),
                    url,
                ], 180000);
                transcript = collectTranscript(workDir);
            } catch {
                // Keep null transcript and route to visual inbox.
            }
        }
        fs.rmSync(workDir, { recursive: true, force: true });

        const tags = (metadata.tags || []).slice(0, 10);
        const subtitleLangs = Array.from(new Set([
            ...Object.keys(metadata.subtitles || {}),
            ...Object.keys(metadata.automatic_captions || {}),
        ])).slice(0, 20);
        const visual = detectVisual(metadata.title || "Untitled YouTube video", tags, transcript);
        const gate = evaluatePolicy(extRoot, {
            action: "pipeline_stage",
            departmentId: "youtube-intelligence",
            risk: "low",
            payload: { action: "ingest", url, title: metadata.title },
        });
        appendAudit(storeRoot, {
            type: "gate_check",
            payloadHash: gate.payloadHash,
            decision: gate.decision,
            actor: "youtube-ingest",
            detail: { action: "ingest", departmentId: "youtube-intelligence" },
        });
        if (gate.decision === "FORBIDDEN") throw new Error(`policy forbidden: ${gate.reasons.join(",")}`);
        if (gate.decision === "APPROVAL") throw new Error(`policy approval required: ${gate.payloadHash.slice(0, 8)}`);

        const result = {
            url,
            title: metadata.title || "Untitled YouTube video",
            channel: metadata.channel || metadata.uploader || null,
            viewCount: metadata.view_count ?? null,
            duration: metadata.duration ?? null,
            description: (metadata.description || "").slice(0, 500),
            publishDate: publishDate(metadata.upload_date),
            tags,
            hasSubtitles: subtitleLangs.length > 0,
            subtitleLangs,
            transcript,
            transcriptLength: transcript ? transcript.length : 0,
            needsVisual: visual.needsVisual,
            needsVisualReason: visual.reason,
            ingestAt: new Date().toISOString(),
        };

        const slug = slugifyTitle(result.title);
        let notePath: string;
        if (!result.needsVisual) {
            const body = [
                `- URL: ${result.url}`,
                `- Channel: ${result.channel || "n/a"}`,
                `- Views: ${result.viewCount ?? "n/a"}`,
                `- Duration: ${result.duration ?? "n/a"}`,
                `- Publish date: ${result.publishDate || "n/a"}`,
                `- Tags: ${result.tags.join(", ") || "n/a"}`,
                "",
                "## Transcript",
                "",
                result.transcript || "",
                "",
                "## Next",
                "- Claude가 이어서 트랜스크립트를 요약하고 훅/구간/콘텐츠 아이디어를 분석한다.",
            ].join("\n");
            const note = createDecisionNote(extRoot, storeRoot, { title: `yt-${slug}`, dept: "youtube-intelligence", status: "accepted" }, body);
            notePath = note.path;
        } else {
            const relPath = `inbox/yt-${slug}-NEEDS-VISUAL.md`;
            const content = redact([
                `# [화면 분석 필요] ${result.title}`,
                `- URL: ${result.url}`,
                `- 이유: ${result.needsVisualReason}`,
                "- 지시: Lilys.ai에서 수동 분석 후 이 파일에 결과 붙여넣기",
                "- status: pending",
                "- 관련: [[00_MOC/AI Agent OS]], [[Connect AI]]",
                "",
            ].join("\n"));
            const note = createDurableNote(extRoot, storeRoot, {
                relPath,
                title: `yt-${slug}-NEEDS-VISUAL`,
                type: "evidence",
                status: "draft",
                project: "Connect AI",
                owner: "youtube-ingest",
                source: "youtube-intelligence",
                links: ["[[00_MOC/AI Agent OS]]", "[[Connect AI]]"],
                body: content,
            });
            notePath = note.path || relPath;
        }

        appendAudit(storeRoot, {
            type: "youtube_ingest",
            payloadHash: hashPayload(result),
            decision: gate.decision,
            actor: "youtube-ingest",
            detail: { url, title: result.title, needsVisual: result.needsVisual, notePath },
        });
        process.stdout.write(`${JSON.stringify({ ...result, notePath }, null, 2)}\n`);
        process.exit(0);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stdout.write(`${JSON.stringify({ error: message }, null, 2)}\n`);
        process.exit(1);
    }
}

void main();
