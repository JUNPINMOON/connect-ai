#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const envPaths = require("./env-paths.js");
const { writeDurableNote } = require("./vault-writer.js");

const repoRoot = envPaths.repoRoot();
const nodeBin = process.execPath || "node";

function vaultRoot() {
  return envPaths.vaultRoot();
}

function companyDir() {
  return envPaths.companyDir();
}

function writerStorageRoot() {
  return path.resolve(path.dirname(envPaths.agentQueuePath()), "..");
}

function redact(text) {
  return String(text || "")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi, "Bearer ***")
    .replace(/\b(idToken|accessToken|refreshToken|password|cookie|authorization)\b(\s*[:=]\s*)("[^"]+"|'[^']+'|[^\s,;}]+)/gi, "$1$2***")
    .replace(/\b(?:sk-|gh[pousr]_|ya29\.)[A-Za-z0-9._-]{12,}\b/g, "***");
}

function parseJson(text) {
  return JSON.parse(String(text || "").trim());
}

function runCli(scriptName, args = [], options = {}) {
  return new Promise((resolve) => {
    const child = execFile(
      nodeBin,
      [path.join(__dirname, scriptName), ...args],
      {
        cwd: repoRoot,
        env: process.env,
        maxBuffer: 30 * 1024 * 1024,
        windowsHide: true,
        ...options,
      },
      (error, stdout, stderr) => {
        const exitCode = error
          ? (typeof error.status === "number" ? error.status : (typeof child.exitCode === "number" ? child.exitCode : 1))
          : 0;
        resolve({
          exitCode,
          stdout,
          stderr,
          text: stdout || stderr || (error ? error.message : ""),
          ok: exitCode === 0,
        });
      }
    );
    if (options.stdin !== undefined && child.stdin) child.stdin.end(options.stdin);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runJsonStep(state, scriptName, args) {
  const result = await runCli(scriptName, args);
  if (!result.ok) throw new Error(`${state}_failed: ${redact(result.stderr || result.stdout || result.text)}`);
  const envelope = parseJson(result.text);
  if (!envelope.success) throw new Error(`${state}_failed: ${redact(envelope.error || result.text)}`);
  return envelope;
}

function safeName(value) {
  return String(value || "youtube")
    .normalize("NFKD")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "")
    .replace(/\s+/g, "-")
    .slice(0, 80) || "youtube";
}

function readLilysSummary(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!Array.isArray(parsed)) return { oneLine: "", points: [], transcriptAvailable: false };
    const textItems = parsed
      .flatMap((item) => [item.title, ...(Array.isArray(item.content) ? item.content : [])])
      .filter(Boolean)
      .map((item) => String(item).replace(/<[^>]+>/g, "").replace(/!\[image\]\([^)]+\)/g, "").trim())
      .filter(Boolean);
    return {
      oneLine: textItems.slice(0, 2).join(" ").slice(0, 500),
      points: textItems.slice(2, 8),
      transcriptAvailable: textItems.length > 0,
    };
  } catch {
    return { oneLine: "", points: [], transcriptAvailable: false };
  }
}

function lilysJsonLooksUseful(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return false;
  const summary = readLilysSummary(filePath);
  return summary.transcriptAvailable && (summary.oneLine.length > 0 || summary.points.length > 0);
}

function normalizeYoutubeUrl(value) {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.replace(/^www\./, "");
    let id = "";
    if (host === "youtu.be") id = parsed.pathname.split("/").filter(Boolean)[0] || "";
    if (host.endsWith("youtube.com")) id = parsed.searchParams.get("v") || "";
    if (id) return `youtube:${id}`;
  } catch {
  }
  return String(value || "").trim().replace(/[?&]si=[^&]+/i, "");
}

function youtubeIdFromUrl(value) {
  const normalized = normalizeYoutubeUrl(value);
  return normalized.startsWith("youtube:") ? normalized.slice("youtube:".length) : safeName(normalized);
}

function processedDir() {
  return path.join(companyDir(), "youtube", "processed");
}

function legacyProcessedDir() {
  return path.join(vaultRoot(), "youtube", "processed");
}

function processedPathFor(url, baseDir = processedDir()) {
  return path.join(baseDir, `${safeName(youtubeIdFromUrl(url))}.json`);
}

function readProcessed(url) {
  for (const baseDir of [processedDir(), legacyProcessedDir()]) {
    const markerPath = processedPathFor(url, baseDir);
    try {
      return {
        marker_path: markerPath,
        marker_location: baseDir === processedDir() ? "runtime" : "legacy_vault",
        marker: JSON.parse(fs.readFileSync(markerPath, "utf8")),
      };
    } catch {
      // Continue through the compatibility search path.
    }
  }
  return null;
}

function writeProcessed(url, data) {
  const markerPath = processedPathFor(url);
  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  const marker = {
    video_id: youtubeIdFromUrl(url),
    original_url: url,
    updated_at: new Date().toISOString(),
    ...data,
  };
  fs.writeFileSync(markerPath, JSON.stringify(marker, null, 2), "utf8");
  return markerPath;
}

function extractFrontmatterValue(content, key) {
  const match = content.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  if (!match) return null;
  const raw = match[1].trim();
  try {
    return JSON.parse(raw);
  } catch {
    return raw.replace(/^["']|["']$/g, "");
  }
}

function findExistingIngest(url, videoId) {
  const processed = readProcessed(url);
  if (processed?.marker) {
    return {
      ...processed.marker,
      marker_path: processed.marker_path,
      source: processed.marker.source || "processed-cache",
      matched_by: "processed_cache",
      existing_video_id: processed.marker.video_id || videoId,
    };
  }

  const contentDir = path.join(vaultRoot(), "youtube", "content");
  if (!fs.existsSync(contentDir)) return null;
  const normalizedUrl = normalizeYoutubeUrl(url);
  const requestedVideoId = String(videoId || "");
  const canonicalVideoId = youtubeIdFromUrl(url);
  const candidateVideoIds = [...new Set([requestedVideoId, canonicalVideoId].filter(Boolean))];
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(fullPath);
      if (entry.isFile()) files.push(fullPath);
    }
  };
  walk(contentDir);

  for (const filePath of files.filter((file) => file.endsWith(".youtube.md"))) {
    const content = fs.readFileSync(filePath, "utf8");
    const noteUrl = extractFrontmatterValue(content, "url") || extractFrontmatterValue(content, "original_url");
    const noteVideoId = extractFrontmatterValue(content, "video_id");
    const digestMatch = content.match(/Lilys:\s*(https:\/\/lilys\.ai\/digest\/\S+)/);
    const source = extractFrontmatterValue(content, "source") || null;
    if (
      (noteUrl && normalizeYoutubeUrl(noteUrl) === normalizedUrl) ||
      (noteVideoId && candidateVideoIds.includes(noteVideoId))
    ) {
      const stem = path.basename(filePath, ".youtube.md");
      const jsonPath = files.find((file) => path.basename(file) === `${stem}.lilys-export.json`) || null;
      const prettyPath = files.find((file) => path.basename(file) === `${stem}.lilys-export.pretty.json`) || null;
      if (jsonPath && !lilysJsonLooksUseful(jsonPath)) continue;
      return {
        note_path: filePath,
        file_path: jsonPath,
        pretty_file_path: prettyPath,
        digest_url: digestMatch?.[1] || null,
        source,
        matched_by: noteUrl && normalizeYoutubeUrl(noteUrl) === normalizedUrl ? "url" : "video_id",
        existing_video_id: noteVideoId || stem,
      };
    }
  }

  for (const candidateVideoId of candidateVideoIds) {
    const jsonPath = files.find((file) => path.basename(file) === `${candidateVideoId}.lilys-export.json`) || null;
    const prettyPath = files.find((file) => path.basename(file) === `${candidateVideoId}.lilys-export.pretty.json`) || null;
    if (jsonPath || prettyPath) {
      if (jsonPath && !lilysJsonLooksUseful(jsonPath)) continue;
      return {
        note_path: null,
        file_path: jsonPath,
        pretty_file_path: prettyPath,
        digest_url: null,
        source: "lilys",
        matched_by: candidateVideoId === canonicalVideoId ? "url_video_id_json" : "video_id_json",
        existing_video_id: candidateVideoId,
      };
    }
  }

  return null;
}

async function exportWithRetry(digestUrl, videoId) {
  let lastError = null;
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    try {
      const exported = await runJsonStep("export_json", "lilys-cli.js", ["export-json", digestUrl, videoId]);
      const summary = readLilysSummary(exported.data?.file_path);
      if (summary.transcriptAvailable) return { exported, summary, attempts: attempt };
      lastError = new Error("export_empty_or_transcript_unavailable");
    } catch (error) {
      lastError = error;
    }
    if (attempt < 12) await sleep(5000);
  }
  throw lastError || new Error("export_retry_exhausted");
}

function writeYoutubeNote({ url, videoId, title, source, digestUrl, jsonPath, fallbackPath }) {
  const relPath = `youtube/content/${safeName(videoId)}.youtube.md`;
  const summary = jsonPath ? readLilysSummary(jsonPath) : { oneLine: "", points: [], transcriptAvailable: false };
  const body = [
    `# ${title || videoId}`,
    "",
    "## Metadata",
    `video_id: ${JSON.stringify(videoId)}`,
    `url: ${JSON.stringify(url)}`,
    `original_url: ${JSON.stringify(url)}`,
    `title: ${JSON.stringify(title || videoId)}`,
    `ingested: ${new Date().toISOString()}`,
    `source: ${JSON.stringify(source)}`,
    `digest_url: ${JSON.stringify(digestUrl || "")}`,
    "ingest_state: \"created_or_refreshed\"",
    "",
    "## 한줄 요약",
    summary.oneLine || "(요약 생성 대기)",
    "",
    "## 핵심 포인트",
    ...(summary.points.length ? summary.points.map((point) => `- ${point}`) : ["- (핵심 포인트 생성 대기)"]),
    "",
    "## 원본 파일",
    jsonPath ? `- JSON: ${jsonPath}` : "",
    fallbackPath ? `- Fallback: ${fallbackPath}` : "",
    digestUrl ? `- Lilys: ${digestUrl}` : "",
    "",
    "## 연관 노트",
    "- [[Connect AI]]",
    "- [[유튜브]]",
    "- [[Hermes]]",
    "- [[00_MOC/AI Agent OS]]",
    "- [[00_MOC/Tools]]",
    "",
  ].filter((line) => line !== "").join("\n");
  const result = writeDurableNote({
    memoryRoot: vaultRoot(),
    storageRoot: writerStorageRoot(),
    relPath,
    title: title || videoId,
    type: "evidence",
    status: "active",
    project: "Connect AI",
    owner: "lilys-ingest",
    source,
    links: ["[[00_MOC/AI Agent OS]]", "[[00_MOC/Tools]]"],
    body,
  });
  if (!result.ok) throw new Error(`vault_writer_rejected: ${result.reason}`);
  return { notePath: result.path, relPath: result.relPath, transcriptAvailable: summary.transcriptAvailable };
}

function markProcessedFromExisting(url, existing) {
  return writeProcessed(url, {
    source: existing.source || "existing",
    state: "reused_existing_ingest",
    note_path: existing.note_path || null,
    file_path: existing.file_path || null,
    pretty_file_path: existing.pretty_file_path || null,
    digest_url: existing.digest_url || null,
    matched_by: existing.matched_by || "unknown",
  });
}

async function fallbackYtDlp(url) {
  const result = await runCli("youtube-ingest.js", [url]);
  if (!result.ok) {
    if (/EEXIST: file already exists/i.test(result.text)) {
      return { source: "yt-dlp", existing_note: true, raw_output: redact(result.text).slice(0, 4000) };
    }
    throw new Error(`fallback_ytdlp_failed: ${redact(result.stderr || result.stdout || result.text)}`);
  }
  return { source: "yt-dlp", raw_output: redact(result.text).slice(0, 4000) };
}

async function main() {
  const [url, requestedVideoId] = process.argv.slice(2);
  if (!url) {
    console.error(JSON.stringify({ success: false, error: "URL is required", data: null }, null, 2));
    process.exit(1);
  }
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch (error) {
    console.error(JSON.stringify({ success: false, error: error.message, data: null }, null, 2));
    process.exit(1);
  }
  const videoId = requestedVideoId || safeName(parsedUrl.searchParams.get("v") || path.basename(parsedUrl.pathname));
  const states = [];
  const startedAt = new Date().toISOString();

  try {
    states.push("S0 reuse_check");
    const existing = findExistingIngest(url, videoId);
    if (existing) {
      console.log(JSON.stringify({
        success: true,
        error: null,
        data: {
          source: existing.source || "existing",
          state: "reused_existing_ingest",
          states,
          original_url: url,
          digest_url: existing.digest_url,
          file_path: existing.file_path,
          pretty_file_path: existing.pretty_file_path,
          video_id: videoId,
          existing_video_id: existing.existing_video_id,
          note_path: existing.note_path,
          matched_by: existing.matched_by,
          already_processed: true,
          marker_path: existing.marker_path || markProcessedFromExisting(url, existing),
          started_at: startedAt,
        },
      }, null, 2));
      return;
    }

    states.push("S1 session_check");
    const session = await runJsonStep("session_check", "lilys-cli.js", ["session-check"]);
    if (session.data?.action_required !== "none") {
      states.push("S2 ensure_login");
      const login = await runJsonStep("ensure_login", "lilys-cli.js", ["ensure-login"]);
      if (login.data?.action_required !== "none") throw new Error("login_required");
    }

    states.push("S3 url_submit");
    const submit = await runJsonStep("url_submit", "lilys-cli.js", ["submit-url", url]);
    const digestUrl = submit.data?.digest_url;
    if (!digestUrl) throw new Error("submit_failed: digest_url_missing");

    states.push("S4 wait_processing");
    if (!submit.data?.ready) throw new Error("processing_timeout");

    states.push("S5 export_json");
    try {
      const { exported, attempts } = await exportWithRetry(digestUrl, videoId);
      states.push("S6 save_to_vault");
      const note = writeYoutubeNote({
        url,
        videoId,
        title: submit.data?.title,
        source: "lilys",
        digestUrl,
        jsonPath: exported.data?.file_path,
      });
      const markerPath = writeProcessed(url, {
        source: "lilys",
        state: "created_or_refreshed",
        note_path: note.notePath,
        file_path: exported.data?.file_path || null,
        pretty_file_path: exported.data?.pretty_file_path || null,
        digest_url: digestUrl,
      });
      console.log(JSON.stringify({
        success: true,
        error: null,
        data: {
          source: "lilys",
          states,
          original_url: url,
          digest_url: digestUrl,
          file_path: exported.data?.file_path,
          pretty_file_path: exported.data?.pretty_file_path,
          file_size: exported.data?.raw?.size || null,
          video_id: videoId,
          title: submit.data?.title || null,
          transcript_available: note.transcriptAvailable,
          note_path: note.notePath,
          already_processed: false,
          marker_path: markerPath,
          export_attempts: attempts,
          started_at: startedAt,
        },
      }, null, 2));
      return;
    } catch (error) {
      states.push("FALLBACK yt-dlp");
      const fallback = await fallbackYtDlp(url);
      states.push("S6 save_to_vault");
      const note = writeYoutubeNote({
        url,
        videoId,
        title: submit.data?.title,
        source: "yt-dlp",
        digestUrl,
        fallbackPath: fallback.existing_note ? "existing youtube-ingest note" : "youtube-ingest.js output",
      });
      const markerPath = writeProcessed(url, {
        source: "yt-dlp",
        state: "fallback",
        note_path: note.notePath,
        file_path: null,
        pretty_file_path: null,
        digest_url: digestUrl,
      });
      console.log(JSON.stringify({
        success: true,
        error: null,
        data: {
          source: "yt-dlp",
          reason: redact(error.message),
          states,
          original_url: url,
          digest_url: digestUrl,
          video_id: videoId,
          note_path: note.notePath,
          already_processed: false,
          marker_path: markerPath,
          fallback,
          started_at: startedAt,
        },
      }, null, 2));
      return;
    }
  } catch (error) {
    console.error(JSON.stringify({ success: false, error: redact(error.message), data: { states, started_at: startedAt } }, null, 2));
    process.exit(1);
  }
}

main();
