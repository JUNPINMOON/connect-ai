#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const envPaths = require("./env-paths.js");

const repoRoot = envPaths.repoRoot();

function existsFile(filePath) {
  try {
    return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function existsDir(dirPath) {
  try {
    return fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

function statInfo(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return {
      exists: true,
      bytes: stat.size,
      updated_at: stat.mtime.toISOString(),
    };
  } catch {
    return {
      exists: false,
      bytes: 0,
      updated_at: null,
    };
  }
}

function walkMarkdown(root) {
  const notes = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".obsidian") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
      const stat = fs.statSync(full);
      notes.push({
        rel_path: path.relative(root, full).split(path.sep).join("/"),
        bytes: stat.size,
        updated_at: stat.mtime.toISOString(),
      });
    }
  }
  if (existsDir(root)) walk(root);
  return notes.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

function storageRoot() {
  const queueDir = path.dirname(envPaths.agentQueuePath());
  return path.basename(queueDir).toLowerCase() === "phase3" ? path.dirname(queueDir) : queueDir;
}

function main() {
  const vaultRoot = envPaths.vaultRoot();
  const scriptNames = [
    "audit-log.js",
    "memory-cli.js",
    "gate-check.js",
    "youtube-ingest.js",
    "lilys-cli.js",
    "lilys-ingest-youtube.js",
    "model-router.js",
    "agent-mesh.js",
  ];
  const policyFiles = [
    "memory-policy.json",
    "tool-execution-policy.json",
    "env-policy.json",
    "model-policy.json",
  ];

  const notes = walkMarkdown(vaultRoot);
  const auditLog = path.join(storageRoot(), "phase2", "audit-log.jsonl");
  const missingScripts = scriptNames.filter((name) => !existsFile(path.join(repoRoot, "scripts", name)));
  const missingPolicies = policyFiles.filter((name) => !existsFile(path.join(repoRoot, "config", name)));
  const warnings = [];

  if (!existsDir(vaultRoot)) warnings.push("vault_root_missing");
  if (missingScripts.length) warnings.push("required_scripts_missing");
  if (missingPolicies.length) warnings.push("policy_files_missing");
  if (!existsFile(auditLog)) warnings.push("audit_log_missing");

  const result = {
    success: warnings.length === 0,
    error: warnings.length ? warnings.join(",") : null,
    data: {
      repo_root: repoRoot,
      vault_root: vaultRoot,
      vault_exists: existsDir(vaultRoot),
      note_count: notes.length,
      recent_notes: notes.slice(0, 8),
      audit_log: {
        path: auditLog,
        ...statInfo(auditLog),
      },
      scripts: Object.fromEntries(
        scriptNames.map((name) => [name, existsFile(path.join(repoRoot, "scripts", name))])
      ),
      policies: Object.fromEntries(
        policyFiles.map((name) => [name, existsFile(path.join(repoRoot, "config", name))])
      ),
      warnings,
    },
  };

  console.log(JSON.stringify(result, null, 2));
  if (!result.success) process.exit(1);
}

main();
