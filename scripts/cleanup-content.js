#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const envPaths = require("./env-paths.js");

function vaultRoot() {
  return envPaths.vaultRoot();
}

function parseArgs(argv) {
  return {
    execute: argv.includes("--execute"),
    json: argv.includes("--json"),
  };
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function uniqueDestination(destPath) {
  if (!fs.existsSync(destPath)) return destPath;
  const dir = path.dirname(destPath);
  const ext = path.extname(destPath);
  const base = path.basename(destPath, ext);
  let index = 2;
  while (true) {
    const candidate = path.join(dir, `${base}.${index}${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
    index += 1;
  }
}

function normalizeForCompare(value) {
  const normalized = String(value || "").replace(/\\/g, "/");
  const wslMatch = normalized.match(/^\/mnt\/([a-zA-Z])\/(.*)$/);
  if (wslMatch) {
    return `${wslMatch[1].toLowerCase()}:/${wslMatch[2]}`.toLowerCase();
  }
  return normalized.replace(/^([A-Za-z]):/, (match) => match.toLowerCase()).toLowerCase();
}

function toWslPath(value) {
  const normalized = String(value || "").replace(/\\/g, "/");
  const match = normalized.match(/^([A-Za-z]):\/(.*)$/);
  if (!match) return normalized;
  return `/mnt/${match[1].toLowerCase()}/${match[2]}`;
}

function replacementFor(oldValue, newValue) {
  if (String(oldValue || "").replace(/\\/g, "/").startsWith("/mnt/")) {
    return toWslPath(newValue);
  }
  return newValue;
}

function classifyFile(name) {
  const lower = name.toLowerCase();
  const ext = path.extname(lower);
  if (/(^|[-_.])(test|proof|check|retry|schema|hermes)([-_.]|$)/.test(lower)) {
    return "test";
  }
  if ([".vtt", ".txt", ".json3"].includes(ext)) {
    return "transcripts";
  }
  if (ext === ".md") {
    return "notes";
  }
  return null;
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function updateProcessedMarkers(processedDir, movedPairs, execute) {
  if (!fs.existsSync(processedDir)) {
    return { checked: 0, updated: 0, files: [] };
  }

  const markerFiles = fs.readdirSync(processedDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".json"))
    .map((entry) => path.join(processedDir, entry.name));

  const movedByOldPath = new Map(movedPairs.map((pair) => [
    normalizeForCompare(pair.from),
    pair.to,
  ]));

  const updated = [];
  for (const markerPath of markerFiles) {
    const data = readJson(markerPath);
    if (!data || typeof data !== "object") continue;

    let changed = false;
    for (const key of ["file_path", "note_path", "json_path", "transcript_path"]) {
      const oldValue = data[key];
      if (!oldValue) continue;
      const replacement = movedByOldPath.get(normalizeForCompare(oldValue));
      if (replacement) {
        data[key] = replacementFor(oldValue, replacement);
        changed = true;
      }
    }

    if (changed) {
      updated.push(markerPath);
      if (execute) {
        fs.writeFileSync(markerPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
      }
    }
  }

  return { checked: markerFiles.length, updated: updated.length, files: updated };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = vaultRoot();
  const contentDir = path.join(root, "youtube", "content");
  const processedDir = path.join(envPaths.companyDir(), "youtube", "processed");
  const targets = {
    test: path.join(contentDir, "test"),
    transcripts: path.join(contentDir, "transcripts"),
    notes: path.join(contentDir, "notes"),
  };

  if (!fs.existsSync(contentDir)) {
    throw new Error(`content directory missing: ${contentDir}`);
  }

  const moves = [];
  const kept = [];

  for (const entry of fs.readdirSync(contentDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const bucket = classifyFile(entry.name);
    const source = path.join(contentDir, entry.name);
    if (!bucket) {
      kept.push(source);
      continue;
    }

    const dest = uniqueDestination(path.join(targets[bucket], entry.name));
    moves.push({ bucket, from: source, to: dest, bytes: fs.statSync(source).size });
  }

  if (args.execute) {
    for (const target of Object.values(targets)) ensureDir(target);
    for (const move of moves) {
      ensureDir(path.dirname(move.to));
      fs.renameSync(move.from, move.to);
    }
  }

  const markerUpdate = updateProcessedMarkers(processedDir, moves, args.execute);

  const byBucket = {};
  for (const move of moves) {
    byBucket[move.bucket] = byBucket[move.bucket] || { count: 0, bytes: 0 };
    byBucket[move.bucket].count += 1;
    byBucket[move.bucket].bytes += move.bytes;
  }

  const result = {
    success: true,
    dry_run: !args.execute,
    content_dir: contentDir,
    moved_count: args.execute ? moves.length : 0,
    planned_move_count: moves.length,
    kept_count: kept.length,
    by_bucket: byBucket,
    processed_marker_update: markerUpdate,
    moves,
  };

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`${args.execute ? "EXECUTE" : "DRY-RUN"} cleanup-content`);
  console.log(`content: ${contentDir}`);
  console.log(`planned moves: ${moves.length}`);
  for (const [bucket, stats] of Object.entries(byBucket)) {
    console.log(`- ${bucket}: ${stats.count} files, ${stats.bytes} bytes`);
  }
  console.log(`kept in root: ${kept.length}`);
  console.log(`processed markers checked: ${markerUpdate.checked}, updates: ${markerUpdate.updated}`);
  if (!args.execute) console.log("No files moved. Re-run with --execute to apply.");
}

main();
