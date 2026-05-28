#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const envPaths = require("./env-paths.js");

const repoRoot = envPaths.repoRoot();

function vaultRoot() {
  return envPaths.vaultRoot();
}

function storageRoot() {
  const queueDir = path.dirname(envPaths.agentQueuePath());
  return path.basename(queueDir).toLowerCase() === "phase3" ? path.dirname(queueDir) : queueDir;
}

function runJson(script, args = []) {
  const result = spawnSync(process.execPath, [path.join(__dirname, script), ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const text = result.stdout || result.stderr;
  const parsed = JSON.parse(text);
  parsed._exitCode = result.status;
  return parsed;
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function listMarkdown(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
    .map((entry) => path.join(dir, entry.name));
}

function fieldIsFilled(content, label) {
  const match = content.match(new RegExp(`^-\\s*${label}:\\s*(.*)$`, "m"));
  if (match && match[1].trim()) return true;
  const heading = content.match(new RegExp(`^##\\s*${label}\\s*$`, "m"));
  if (!heading) return false;
  const rest = content.slice(heading.index + heading[0].length).trim();
  return Boolean(rest && !rest.startsWith("##"));
}

const checks = [];

function check(name, fn) {
  try {
    const detail = fn();
    checks.push({ name, ok: true, detail });
  } catch (error) {
    checks.push({ name, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

check("lilys session-check schema", () => {
  const result = runJson("lilys-cli.js", ["session-check"]);
  if (typeof result.success !== "boolean") throw new Error("session-check missing success boolean");
  if (!result.data || typeof result.data.action_required !== "string") throw new Error("missing data.action_required");
  return { action_required: result.data.action_required, valid: result.data.valid, exitCode: result._exitCode };
});

check("processed cache exists and blocks known URL", () => {
  const markerCandidates = [
    path.join(envPaths.companyDir(), "youtube", "processed", "dQw4w9WgXcQ.json"),
    path.join(vaultRoot(), "youtube", "processed", "dQw4w9WgXcQ.json"),
  ];
  const marker = markerCandidates.find((candidate) => readJson(candidate));
  const data = marker ? readJson(marker) : null;
  if (!data) throw new Error(`processed marker missing: ${markerCandidates.join(" or ")}`);
  if (!data.note_path && !data.file_path) throw new Error("processed marker has no reusable path");
  return { marker, source: data.source, state: data.state };
});

check("latest decisions have decision/evidence fields", () => {
  const decisionDir = path.join(vaultRoot(), "decisions");
  const files = listMarkdown(decisionDir)
    .map((filePath) => ({ filePath, mtime: fs.statSync(filePath).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 10);
  const missing = files.filter(({ filePath }) => {
    const content = fs.readFileSync(filePath, "utf8");
    return !fieldIsFilled(content, "결정") || !fieldIsFilled(content, "근거");
  });
  return {
    checked: files.length,
    missing_count: missing.length,
    missing_files: missing.map((item) => path.basename(item.filePath)),
    warning: missing.length ? "legacy_or_manual_decision_notes_need_cleanup" : null,
  };
});

check("audit log exists", () => {
  const auditPath = path.join(storageRoot(), "phase2", "audit-log.jsonl");
  if (!fs.existsSync(auditPath)) throw new Error(`audit log missing: ${auditPath}`);
  const lines = fs.readFileSync(auditPath, "utf8").split(/\r?\n/).filter(Boolean).length;
  if (lines < 1) throw new Error("audit log is empty");
  return { auditPath, lines };
});

const ok = checks.every((item) => item.ok);
console.log(JSON.stringify({ success: ok, checks }, null, 2));
process.exit(ok ? 0 : 1);
