#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ALLOWED_TYPES = new Set(["project", "agent", "runbook", "decision", "tool", "evidence", "moc"]);
const ALLOWED_STATUSES = new Set(["active", "optional", "draft", "blocked", "archived"]);
const DEFAULT_ALLOWED_SUBDIRS = [
  "00_MOC/",
  "decisions/",
  "runbooks/",
  "inbox/",
  "wiki/",
  "agent-guides/",
  "codex-memory/",
  "youtube/",
  "notes/",
  "ideas/",
  "references/",
];
const FORBIDDEN_PREFIXES = ["_company/", ".obsidian/", ".connect-ai-locks/"];
const DEFAULT_POLICY_PATH = path.join(__dirname, "..", "config", "vault-write-policy.json");

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function loadVaultWritePolicy(policyPath = DEFAULT_POLICY_PATH) {
  const policy = readJson(policyPath, {});
  return policy && typeof policy === "object" ? policy : {};
}

function policyViolation(rule, detail, suggestion) {
  return `이 write는 ${rule} 룰 위반: ${detail} — 대신 ${suggestion}`;
}

function hasRequiredField(options, field) {
  const value = options[field];
  if (Array.isArray(value)) return value.map(String).filter(Boolean).length > 0;
  return String(value || "").trim().length > 0;
}

function asCleanStringArray(value) {
  return Array.isArray(value) ? value.map(String).map((item) => item.trim()).filter(Boolean) : [];
}

function hasKnownMocHubLink(values, policy) {
  const links = asCleanStringArray(values);
  const knownHubs = asCleanStringArray(policy.mocHubLinks);
  if (knownHubs.length) return links.some((link) => knownHubs.includes(link));
  return links.some((link) => /\[\[00_MOC\//.test(link));
}

function enforceVaultWritePolicy(options, relPath, policy = loadVaultWritePolicy(), settings = {}) {
  const rel = normalizeVaultRelPath(relPath);
  for (const rule of policy.forbiddenFilenamePatterns || []) {
    const regex = new RegExp(rule.pattern, "i");
    if (regex.test(rel)) {
      throw new Error(policyViolation(
        rule.id || "filename",
        `${rel} is not allowed by vault-write-policy.json`,
        rule.suggestion || "notes/, ideas/, references/ 또는 적절한 MOC/장기 노트 경로를 사용하세요."
      ));
    }
  }
  const requireMeta = settings.requireMeta !== false;
  if (requireMeta) {
    for (const field of policy.frontmatterRequired || []) {
      if (!hasRequiredField(options, field)) {
        throw new Error(policyViolation(
          "frontmatter-required",
          `${field} frontmatter value is required`,
          "type/status/tags/related를 모두 채운 뒤 vault-writer로 다시 작성하세요."
        ));
      }
    }
    const routineTypes = new Set((policy.routineNoteTypes || []).map(String));
    const routinePrefixes = policy.routineAllowedPrefixes || [];
    const type = String(options.type || "");
    if (routineTypes.has(type) && routinePrefixes.length && !routinePrefixes.some((prefix) => rel.startsWith(prefix))) {
      throw new Error(policyViolation(
        "routine-note-prefix",
        `${type} notes must live under an approved routine prefix`,
        `${routinePrefixes.join(", ")} 경로를 사용하세요.`
      ));
    }
    const durableTypes = new Set((policy.protectedDurableTypes || []).map(String));
    if (durableTypes.has(type) && !hasKnownMocHubLink(options.related, policy)) {
      throw new Error(policyViolation(
        "moc-related-required",
        `${type} notes must include at least one known MOC hub in related frontmatter`,
        "related에 [[00_MOC/AI Agent OS]], [[00_MOC/Projects]], [[00_MOC/Tools]], [[00_MOC/Agents]], [[00_MOC/Decisions]], [[00_MOC/Runbooks]] 중 하나를 넣으세요."
      ));
    }
  }
}

function normalizeVaultRelPath(relPath) {
  const cleaned = String(relPath || "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (!cleaned || path.isAbsolute(String(relPath || "")) || cleaned.includes("\0")) throw new Error("invalid_vault_relpath");
  if (cleaned.split("/").includes("..")) throw new Error("outside_vault");
  if (cleaned === ".obsidian" || cleaned.startsWith(".obsidian/") || cleaned.includes("/.obsidian/")) {
    throw new Error("obsidian_internal_path_forbidden");
  }
  if (!cleaned.toLowerCase().endsWith(".md")) throw new Error("vault_note_must_be_markdown");
  return cleaned;
}

function isAllowedRelPath(relPath, allowedSubdirs = DEFAULT_ALLOWED_SUBDIRS) {
  const rel = normalizeVaultRelPath(relPath);
  if (FORBIDDEN_PREFIXES.some((prefix) => rel === prefix.slice(0, -1) || rel.startsWith(prefix))) {
    throw new Error("runtime_path_forbidden");
  }
  const firstSlash = rel.indexOf("/");
  if (firstSlash === -1) return false;
  return allowedSubdirs.some((dir) => rel.startsWith(dir));
}

function yamlString(value) {
  const text = String(value || "").replace(/"/g, '\\"');
  return `"${text}"`;
}

function buildFrontmatter(meta) {
  const now = new Date().toISOString();
  const type = String(meta.type || "").trim();
  const status = String(meta.status || "").trim();
  const roleKey = String(meta.roleKey || "").trim();
  const links = Array.isArray(meta.links) ? meta.links.map(String).filter(Boolean) : [];
  const tags = Array.isArray(meta.tags) ? meta.tags.map(String).filter(Boolean) : [];
  const related = Array.isArray(meta.related) ? meta.related.map(String).filter(Boolean) : [];
  return [
    "---",
    `type: ${type}`,
    `status: ${status}`,
    ...(roleKey ? [`roleKey: ${roleKey}`] : []),
    "tags:",
    ...tags.map((tag) => `  - ${yamlString(tag)}`),
    `project: ${yamlString(meta.project || "")}`,
    `owner: ${yamlString(meta.owner || "")}`,
    `source: ${yamlString(meta.source || "")}`,
    `created: ${yamlString(meta.created || now)}`,
    `updated: ${yamlString(meta.updated || now)}`,
    "related:",
    ...related.map((item) => `  - ${yamlString(item)}`),
    "links:",
    ...links.map((link) => `  - ${yamlString(link)}`),
    "---",
    "",
  ].join("\n");
}

function hasFrontmatter(content) {
  return /^---\r?\n[\s\S]*?\r?\n---\r?\n/.test(String(content || ""));
}

function assertValidMeta(meta, relPath) {
  const type = String(meta.type || "").trim();
  const status = String(meta.status || "").trim();
  const links = Array.isArray(meta.links) ? meta.links.map(String).filter(Boolean) : [];
  if (!ALLOWED_TYPES.has(type)) throw new Error("invalid_type");
  if (!ALLOWED_STATUSES.has(status)) throw new Error("invalid_status");
  if (!String(meta.project || "").trim()) throw new Error("project_required");
  if (!String(meta.owner || "").trim()) throw new Error("owner_required");
  if (!String(meta.source || "").trim()) throw new Error("source_required");
  if (!links.length) throw new Error("required_links_missing");
  if (type !== "moc" && !links.some((link) => /\[\[00_MOC\//.test(link))) {
    throw new Error("required_moc_link_missing");
  }
  if (type === "moc" && !relPath.startsWith("00_MOC/")) throw new Error("moc_must_live_under_00_MOC");
}

function appendJsonl(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify({ ts: new Date().toISOString(), ...payload })}\n`, "utf8");
}

function rejectedWritesPath(storageRoot) {
  return path.join(storageRoot, "rejected-writes", "rejected-writes.jsonl");
}

function writeLogPath(storageRoot) {
  return path.join(storageRoot, "vault-writer", "writes.jsonl");
}

function repairManifestPath(storageRoot, batchId) {
  return path.join(storageRoot, "vault-writer", "repair-manifests", `${batchId}.jsonl`);
}

function rollbackManifestPath(storageRoot, batchId) {
  return path.join(storageRoot, "vault-writer", "rollback-manifests", `${batchId}.jsonl`);
}

function backupPath(storageRoot, batchId, relPath) {
  return path.join(storageRoot, "vault-writer", "backups", batchId, relPath);
}

function reject(storageRoot, detail) {
  appendJsonl(rejectedWritesPath(storageRoot), { actor: "vault-writer", ...detail });
  return {
    ok: false,
    wrote: false,
    reason: detail.reason,
    relPath: detail.relPath || "",
    path: detail.path || "",
    previewContent: detail.previewContent || "",
  };
}

function writeDurableNote(options) {
  const memoryRoot = path.resolve(String(options.memoryRoot || ""));
  const storageRoot = path.resolve(String(options.storageRoot || path.join(memoryRoot, ".connect-ai-runtime")));
  const policy = loadVaultWritePolicy(options.policyPath || DEFAULT_POLICY_PATH);
  let relPath = "";
  let fullPath = "";
  try {
    if (!memoryRoot) throw new Error("memory_root_required");
    relPath = normalizeVaultRelPath(options.relPath);
    fullPath = path.resolve(memoryRoot, relPath);
    const relative = path.relative(memoryRoot, fullPath);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("outside_vault");
    if (!isAllowedRelPath(relPath, options.allowedSubdirs || policy.allowedSubdirs || DEFAULT_ALLOWED_SUBDIRS)) throw new Error("vault_subdir_not_allowed");
    enforceVaultWritePolicy(options, relPath, policy);
    assertValidMeta(options, relPath);
    const body = String(options.body || "").trim();
    const content = hasFrontmatter(body)
      ? body.replace(/\s*$/, "\n")
      : `${buildFrontmatter(options)}${body}\n`;
    if (!content.includes(String(options.title || "").trim()) && String(options.title || "").trim()) {
      // The title is metadata, but keep the body readable when callers only pass paragraphs.
    }
    if (fs.existsSync(fullPath)) throw new Error("duplicate_note");
    if (options.dryRun) {
      appendJsonl(writeLogPath(storageRoot), { actor: "vault-writer", relPath, dryRun: true, wrote: false });
      return { ok: true, wrote: false, mode: "dry-run", relPath, path: fullPath, previewContent: content };
    }
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, { encoding: "utf8", flag: "wx" });
    appendJsonl(writeLogPath(storageRoot), { actor: "vault-writer", relPath, dryRun: false, wrote: true });
    return { ok: true, wrote: true, mode: "live", relPath, path: fullPath, previewContent: content };
  } catch (error) {
    return reject(storageRoot, {
      reason: error && error.message ? error.message : String(error),
      relPath,
      path: fullPath,
    });
  }
}

function compactTimestamp(value = new Date()) {
  return value.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function ensureBodyWikiLink(content, link) {
  const text = String(content || "").replace(/\s*$/, "\n");
  if (!String(link || "").trim() || text.includes(link)) return text;
  return `${text}\n${link}\n`;
}

function appendToNote(options) {
  const memoryRoot = path.resolve(String(options.memoryRoot || ""));
  const storageRoot = path.resolve(String(options.storageRoot || path.join(memoryRoot, ".connect-ai-runtime")));
  const policy = loadVaultWritePolicy(options.policyPath || DEFAULT_POLICY_PATH);
  const batchId = String(options.batchId || compactTimestamp()).replace(/[^\w.-]/g, "-");
  let relPath = "";
  try {
    if (!memoryRoot) throw new Error("memory_root_required");
    relPath = normalizeVaultRelPath(options.relPath);
    const fullPath = path.join(memoryRoot, relPath);
    const relative = path.relative(memoryRoot, fullPath);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("outside_vault");
    if (!isAllowedRelPath(relPath, options.allowedSubdirs || policy.allowedSubdirs || DEFAULT_ALLOWED_SUBDIRS)) throw new Error("vault_subdir_not_allowed");
    enforceVaultWritePolicy(options, relPath, policy, { requireMeta: false });
    if (!fs.existsSync(fullPath)) throw new Error("note_not_found");

    const original = fs.readFileSync(fullPath, "utf8");
    const marker = String(options.marker || "").trim();
    const body = String(options.body || "").trimEnd();
    if (!body.trim()) throw new Error("append_body_required");
    if (marker && original.includes(marker)) {
      appendJsonl(writeLogPath(storageRoot), { actor: "vault-writer", operation: "append-to-note", relPath, dryRun: !!options.dryRun, wrote: false, noOp: true });
      return { ok: true, wrote: false, mode: options.dryRun ? "dry-run" : "live", relPath, path: fullPath, noOp: true, previewContent: original };
    }

    const appended = `${original.replace(/\s*$/, "\n\n")}${body}\n`;
    if (options.dryRun) {
      appendJsonl(writeLogPath(storageRoot), { actor: "vault-writer", operation: "append-to-note", relPath, dryRun: true, wrote: false });
      return { ok: true, wrote: false, mode: "dry-run", relPath, path: fullPath, previewContent: appended };
    }

    const noteBackupPath = backupPath(storageRoot, batchId, relPath);
    fs.mkdirSync(path.dirname(noteBackupPath), { recursive: true });
    fs.writeFileSync(noteBackupPath, original, { encoding: "utf8", flag: "wx" });
    fs.writeFileSync(fullPath, appended, "utf8");
    appendJsonl(repairManifestPath(storageRoot, batchId), {
      actor: "vault-writer",
      operation: "append-to-note",
      relPath,
      path: fullPath,
      backupPath: noteBackupPath,
    });
    appendJsonl(writeLogPath(storageRoot), { actor: "vault-writer", operation: "append-to-note", relPath, dryRun: false, wrote: true, backupPath: noteBackupPath });
    return { ok: true, wrote: true, mode: "live", batchId, relPath, path: fullPath, backupPath: noteBackupPath, previewContent: appended };
  } catch (error) {
    return reject(storageRoot, {
      reason: error && error.message ? error.message : String(error),
      operation: "append-to-note",
      relPath,
    });
  }
}

function repairNoteContent(original, options) {
  let repaired = String(original || "").replace(/^\uFEFF/, "");
  const operations = [];
  if (!hasFrontmatter(repaired)) {
    repaired = `${buildFrontmatter(options)}${repaired}`;
    operations.push("added_frontmatter");
  }
  const link = (Array.isArray(options.links) ? options.links : []).find((item) => /\[\[00_MOC\//.test(String(item)));
  if (link && !repaired.includes(link)) {
    repaired = ensureBodyWikiLink(repaired, link);
    operations.push("added_moc_link");
  }
  return { content: repaired, operations };
}

function repairExistingNote(options) {
  const memoryRoot = path.resolve(String(options.memoryRoot || ""));
  const storageRoot = path.resolve(String(options.storageRoot || path.join(memoryRoot, ".connect-ai-runtime")));
  const policy = loadVaultWritePolicy(options.policyPath || DEFAULT_POLICY_PATH);
  const batchId = String(options.batchId || compactTimestamp()).replace(/[^\w.-]/g, "-");
  let relPath = "";
  let fullPath = "";
  try {
    if (!memoryRoot) throw new Error("memory_root_required");
    relPath = normalizeVaultRelPath(options.relPath);
    fullPath = path.resolve(memoryRoot, relPath);
    const relative = path.relative(memoryRoot, fullPath);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("outside_vault");
    if (!isAllowedRelPath(relPath, options.allowedSubdirs || policy.allowedSubdirs || DEFAULT_ALLOWED_SUBDIRS)) throw new Error("vault_subdir_not_allowed");
    enforceVaultWritePolicy(options, relPath, policy);
    assertValidMeta(options, relPath);
    if (!fs.existsSync(fullPath)) throw new Error("note_not_found");

    const original = fs.readFileSync(fullPath, "utf8");
    const { content: repaired, operations } = repairNoteContent(original, options);

    if (repaired === original) {
      appendJsonl(writeLogPath(storageRoot), { actor: "vault-writer", operation: "repair-existing-note", relPath, dryRun: !!options.dryRun, wrote: false, noOp: true });
      return { ok: true, wrote: false, mode: options.dryRun ? "dry-run" : "live", relPath, path: fullPath, operations: [], noOp: true, previewContent: repaired };
    }
    if (options.dryRun) {
      appendJsonl(writeLogPath(storageRoot), { actor: "vault-writer", operation: "repair-existing-note", relPath, dryRun: true, wrote: false, operations });
      return { ok: true, wrote: false, mode: "dry-run", relPath, path: fullPath, operations, previewContent: repaired };
    }

    const noteBackupPath = backupPath(storageRoot, batchId, relPath);
    fs.mkdirSync(path.dirname(noteBackupPath), { recursive: true });
    fs.writeFileSync(noteBackupPath, original, { encoding: "utf8", flag: "wx" });
    fs.writeFileSync(fullPath, repaired, "utf8");
    appendJsonl(repairManifestPath(storageRoot, batchId), {
      actor: "vault-writer",
      operation: "repair-existing-note",
      relPath,
      path: fullPath,
      backupPath: noteBackupPath,
      operations,
    });
    appendJsonl(writeLogPath(storageRoot), { actor: "vault-writer", operation: "repair-existing-note", relPath, dryRun: false, wrote: true, backupPath: noteBackupPath, operations });
    return { ok: true, wrote: true, mode: "live", batchId, relPath, path: fullPath, backupPath: noteBackupPath, operations, previewContent: repaired };
  } catch (error) {
    return reject(storageRoot, {
      reason: error && error.message ? error.message : String(error),
      operation: "repair-existing-note",
      relPath,
      path: fullPath,
    });
  }
}

function replaceExistingNoteContent(options) {
  const memoryRoot = path.resolve(String(options.memoryRoot || ""));
  const storageRoot = path.resolve(String(options.storageRoot || path.join(memoryRoot, ".connect-ai-runtime")));
  const policy = loadVaultWritePolicy(options.policyPath || DEFAULT_POLICY_PATH);
  const batchId = String(options.batchId || compactTimestamp()).replace(/[^\w.-]/g, "-");
  const operation = String(options.operation || "replace-existing-note");
  let relPath = "";
  let fullPath = "";
  try {
    if (!memoryRoot) throw new Error("memory_root_required");
    relPath = normalizeVaultRelPath(options.relPath);
    fullPath = path.resolve(memoryRoot, relPath);
    const relative = path.relative(memoryRoot, fullPath);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("outside_vault");
    if (!isAllowedRelPath(relPath, options.allowedSubdirs || policy.allowedSubdirs || DEFAULT_ALLOWED_SUBDIRS)) throw new Error("vault_subdir_not_allowed");
    enforceVaultWritePolicy(options, relPath, policy, { requireMeta: false });
    if (!fs.existsSync(fullPath)) throw new Error("note_not_found");

    const original = fs.readFileSync(fullPath, "utf8");
    const replacement = String(options.content ?? "").replace(/\s*$/, "\n");
    if (!replacement.trim()) throw new Error("replacement_content_required");
    if (replacement === original) {
      appendJsonl(writeLogPath(storageRoot), { actor: "vault-writer", operation, relPath, dryRun: !!options.dryRun, wrote: false, noOp: true });
      return { ok: true, wrote: false, mode: options.dryRun ? "dry-run" : "live", batchId, relPath, path: fullPath, noOp: true, previewContent: replacement };
    }
    if (options.dryRun) {
      appendJsonl(writeLogPath(storageRoot), { actor: "vault-writer", operation, relPath, dryRun: true, wrote: false });
      return { ok: true, wrote: false, mode: "dry-run", batchId, relPath, path: fullPath, previewContent: replacement };
    }

    const noteBackupPath = backupPath(storageRoot, batchId, relPath);
    fs.mkdirSync(path.dirname(noteBackupPath), { recursive: true });
    fs.writeFileSync(noteBackupPath, original, { encoding: "utf8", flag: "wx" });
    fs.writeFileSync(fullPath, replacement, "utf8");
    appendJsonl(repairManifestPath(storageRoot, batchId), {
      actor: "vault-writer",
      operation,
      relPath,
      path: fullPath,
      backupPath: noteBackupPath,
    });
    appendJsonl(writeLogPath(storageRoot), { actor: "vault-writer", operation, relPath, dryRun: false, wrote: true, backupPath: noteBackupPath });
    return { ok: true, wrote: true, mode: "live", batchId, relPath, path: fullPath, backupPath: noteBackupPath, previewContent: replacement };
  } catch (error) {
    return reject(storageRoot, {
      reason: error && error.message ? error.message : String(error),
      operation,
      relPath,
      path: fullPath,
    });
  }
}

function moveRootNote(options) {
  const memoryRoot = path.resolve(String(options.memoryRoot || ""));
  const storageRoot = path.resolve(String(options.storageRoot || path.join(memoryRoot, ".connect-ai-runtime")));
  const policy = loadVaultWritePolicy(options.policyPath || DEFAULT_POLICY_PATH);
  const batchId = String(options.batchId || compactTimestamp()).replace(/[^\w.-]/g, "-");
  let relPath = "";
  let targetRelPath = "";
  let sourcePath = "";
  let targetPath = "";
  try {
    if (!memoryRoot) throw new Error("memory_root_required");
    relPath = normalizeVaultRelPath(options.relPath || options.sourceRelPath);
    targetRelPath = normalizeVaultRelPath(options.targetRelPath);
    if (relPath.includes("/")) throw new Error("source_must_be_root_note");
    if (targetRelPath.indexOf("/") === -1) throw new Error("target_must_be_allowed_subdir");
    if (path.basename(relPath, ".md") !== path.basename(targetRelPath, ".md") && options.preserveBasename !== false) {
      throw new Error("target_basename_must_match_source");
    }
    sourcePath = path.resolve(memoryRoot, relPath);
    targetPath = path.resolve(memoryRoot, targetRelPath);
    const sourceRelative = path.relative(memoryRoot, sourcePath);
    const targetRelative = path.relative(memoryRoot, targetPath);
    if (!sourceRelative || sourceRelative.startsWith("..") || path.isAbsolute(sourceRelative)) throw new Error("outside_vault");
    if (!targetRelative || targetRelative.startsWith("..") || path.isAbsolute(targetRelative)) throw new Error("outside_vault");
    if (!isAllowedRelPath(targetRelPath, options.allowedSubdirs || policy.allowedSubdirs || DEFAULT_ALLOWED_SUBDIRS)) throw new Error("vault_subdir_not_allowed");
    enforceVaultWritePolicy(options, targetRelPath, policy);
    assertValidMeta(options, targetRelPath);
    if (!fs.existsSync(sourcePath)) throw new Error("note_not_found");
    if (fs.existsSync(targetPath)) throw new Error("duplicate_note");

    const original = fs.readFileSync(sourcePath, "utf8");
    const { content: repaired, operations } = repairNoteContent(original, options);
    const moveOperations = ["moved_root_note", ...operations];
    if (options.dryRun) {
      appendJsonl(writeLogPath(storageRoot), {
        actor: "vault-writer",
        operation: "move-root-note",
        relPath,
        targetRelPath,
        dryRun: true,
        wrote: false,
        operations: moveOperations,
      });
      return {
        ok: true,
        wrote: false,
        mode: "dry-run",
        batchId,
        relPath,
        targetRelPath,
        path: sourcePath,
        targetPath,
        operations: moveOperations,
        previewContent: repaired,
      };
    }
    if (!options.approved) throw new Error("root_note_migration_requires_approval");

    const noteBackupPath = backupPath(storageRoot, batchId, relPath);
    fs.mkdirSync(path.dirname(noteBackupPath), { recursive: true });
    fs.writeFileSync(noteBackupPath, original, { encoding: "utf8", flag: "wx" });
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, repaired, { encoding: "utf8", flag: "wx" });
    fs.unlinkSync(sourcePath);
    appendJsonl(repairManifestPath(storageRoot, batchId), {
      actor: "vault-writer",
      operation: "move-root-note",
      relPath,
      targetRelPath,
      sourcePath,
      targetPath,
      backupPath: noteBackupPath,
      stubCreated: false,
      linkPreservation: "basename preserved so existing wiki links keep resolving",
      operations: moveOperations,
    });
    appendJsonl(writeLogPath(storageRoot), {
      actor: "vault-writer",
      operation: "move-root-note",
      relPath,
      targetRelPath,
      dryRun: false,
      wrote: true,
      backupPath: noteBackupPath,
      operations: moveOperations,
    });
    return {
      ok: true,
      wrote: true,
      mode: "live",
      batchId,
      relPath,
      targetRelPath,
      path: sourcePath,
      targetPath,
      backupPath: noteBackupPath,
      operations: moveOperations,
      previewContent: repaired,
    };
  } catch (error) {
    return reject(storageRoot, {
      reason: error && error.message ? error.message : String(error),
      operation: "move-root-note",
      relPath,
      targetRelPath,
      path: sourcePath,
      targetPath,
    });
  }
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) throw new Error("manifest_not_found");
  return fs.readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function rollbackRootMoves(options) {
  const memoryRoot = path.resolve(String(options.memoryRoot || ""));
  const storageRoot = path.resolve(String(options.storageRoot || path.join(memoryRoot, ".connect-ai-runtime")));
  const batchId = String(options.batchId || "").replace(/[^\w.-]/g, "-");
  try {
    if (!memoryRoot) throw new Error("memory_root_required");
    if (!batchId) throw new Error("batch_id_required");
    const manifest = readJsonl(repairManifestPath(storageRoot, batchId));
    const entries = manifest
      .filter((entry) => entry.operation === "move-root-note")
      .reverse();
    const results = entries.map((entry) => rollbackRootMoveEntry({
      memoryRoot,
      storageRoot,
      batchId,
      entry,
      dryRun: !!options.dryRun,
      approved: !!options.approved,
    }));
    return {
      ok: results.every((item) => item.ok),
      wrote: results.some((item) => item.wrote),
      mode: options.dryRun ? "dry-run" : "live",
      batchId,
      count: results.length,
      results,
    };
  } catch (error) {
    return reject(storageRoot, {
      reason: error && error.message ? error.message : String(error),
      operation: "rollback-root-moves",
    });
  }
}

function rollbackRootMoveEntry(options) {
  const { memoryRoot, storageRoot, batchId, entry } = options;
  let relPath = "";
  let targetRelPath = "";
  let rootPath = "";
  let targetPath = "";
  let noteBackupPath = "";
  try {
    relPath = normalizeVaultRelPath(entry.relPath);
    targetRelPath = normalizeVaultRelPath(entry.targetRelPath);
    if (relPath.includes("/")) throw new Error("rollback_source_must_be_root_note");
    if (targetRelPath.indexOf("/") === -1) throw new Error("rollback_target_must_be_allowed_subdir");
    if (path.basename(relPath, ".md") !== path.basename(targetRelPath, ".md")) {
      throw new Error("rollback_basename_mismatch");
    }
    rootPath = path.resolve(memoryRoot, relPath);
    targetPath = path.resolve(memoryRoot, targetRelPath);
    noteBackupPath = backupPath(storageRoot, batchId, relPath);
    for (const fullPath of [rootPath, targetPath]) {
      const relative = path.relative(memoryRoot, fullPath);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("outside_vault");
    }
    if (!fs.existsSync(noteBackupPath)) throw new Error("backup_not_found");
    if (!fs.existsSync(targetPath)) throw new Error("target_note_not_found");
    if (fs.existsSync(rootPath)) throw new Error("root_note_already_exists");
    if (options.dryRun) {
      appendJsonl(writeLogPath(storageRoot), {
        actor: "vault-writer",
        operation: "rollback-root-note",
        relPath,
        targetRelPath,
        dryRun: true,
        wrote: false,
      });
      return {
        ok: true,
        wrote: false,
        mode: "dry-run",
        batchId,
        relPath,
        targetRelPath,
        path: rootPath,
        targetPath,
        backupPath: noteBackupPath,
        operations: ["rollback_root_note"],
      };
    }
    if (!options.approved) throw new Error("root_note_rollback_requires_approval");

    fs.mkdirSync(path.dirname(rootPath), { recursive: true });
    fs.copyFileSync(noteBackupPath, rootPath, fs.constants.COPYFILE_EXCL);
    fs.unlinkSync(targetPath);
    appendJsonl(rollbackManifestPath(storageRoot, batchId), {
      actor: "vault-writer",
      operation: "rollback-root-note",
      relPath,
      targetRelPath,
      path: rootPath,
      targetPath,
      backupPath: noteBackupPath,
      operations: ["rollback_root_note"],
    });
    appendJsonl(writeLogPath(storageRoot), {
      actor: "vault-writer",
      operation: "rollback-root-note",
      relPath,
      targetRelPath,
      dryRun: false,
      wrote: true,
      backupPath: noteBackupPath,
    });
    return {
      ok: true,
      wrote: true,
      mode: "live",
      batchId,
      relPath,
      targetRelPath,
      path: rootPath,
      targetPath,
      backupPath: noteBackupPath,
      operations: ["rollback_root_note"],
    };
  } catch (error) {
    return reject(storageRoot, {
      reason: error && error.message ? error.message : String(error),
      operation: "rollback-root-note",
      relPath,
      targetRelPath,
      path: rootPath,
      targetPath,
    });
  }
}

function getArg(name, fallback = "") {
  const idx = process.argv.indexOf(`--${name}`);
  return idx === -1 ? fallback : process.argv[idx + 1] || fallback;
}

function getMultiArg(name) {
  const values = [];
  for (let i = 0; i < process.argv.length; i += 1) {
    if (process.argv[i] === `--${name}` && process.argv[i + 1]) values.push(process.argv[i + 1]);
  }
  return values;
}

function getArgOrFile(name, fallback = "") {
  const filePath = getArg(`${name}-file`);
  if (filePath) return fs.readFileSync(filePath, "utf8");
  return getArg(name, fallback);
}

function main() {
  const command = process.argv[2];
  if (!["write", "synthetic", "append", "replace"].includes(command)) {
    console.log("Usage: node scripts/vault-writer.js synthetic|write|append|replace --memory-root <vault> --storage-root <store> --rel-path <path.md> --type evidence --status draft --project \"Connect AI\" --owner codex --source test --link \"[[00_MOC/AI Agent OS]]\" --body \"...\" [--role-key <key>] [--body-file <path>] [--content-file <path>] [--dry-run]");
    return;
  }
  if (command === "replace") {
    const result = replaceExistingNoteContent({
      memoryRoot: getArg("memory-root"),
      storageRoot: getArg("storage-root"),
      batchId: getArg("batch-id"),
      relPath: getArg("rel-path"),
      content: getArgOrFile("content"),
      dryRun: process.argv.includes("--dry-run"),
    });
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exit(1);
    return;
  }
  if (command === "append") {
    const result = appendToNote({
      memoryRoot: getArg("memory-root"),
      storageRoot: getArg("storage-root"),
      batchId: getArg("batch-id"),
      relPath: getArg("rel-path"),
      marker: getArg("marker"),
      body: getArg("body"),
      dryRun: process.argv.includes("--dry-run"),
    });
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exit(1);
    return;
  }
  const result = writeDurableNote({
    memoryRoot: getArg("memory-root"),
    storageRoot: getArg("storage-root"),
    relPath: getArg("rel-path"),
    title: getArg("title", "Synthetic Vault Write"),
    type: getArg("type", "evidence"),
    status: getArg("status", "draft"),
    roleKey: getArg("role-key"),
    project: getArg("project", "Connect AI"),
    owner: getArg("owner", "codex"),
    source: getArg("source", "vault-writer-cli"),
    links: getMultiArg("link"),
    tags: getMultiArg("tag"),
    related: getMultiArg("related"),
    body: getArgOrFile("body", "# Synthetic Vault Write\n\n- evidence: generated by vault-writer"),
    dryRun: process.argv.includes("--dry-run") || command === "synthetic",
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exit(1);
}

if (require.main === module) main();

module.exports = {
  DEFAULT_ALLOWED_SUBDIRS,
  appendToNote,
  buildFrontmatter,
  enforceVaultWritePolicy,
  isAllowedRelPath,
  loadVaultWritePolicy,
  moveRootNote,
  normalizeVaultRelPath,
  repairExistingNote,
  replaceExistingNoteContent,
  rollbackRootMoves,
  writeDurableNote,
};
