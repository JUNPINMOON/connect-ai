#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");
const envPaths = require("./env-paths.js");
const {
  DEFAULT_ALLOWED_SUBDIRS,
  isAllowedRelPath,
  moveRootNote,
  repairExistingNote,
  rollbackRootMoves: rollbackRootMovesViaWriter,
} = require("./vault-writer.js");

const MOC_BY_PREFIX = [
  [/^00_MOC\//, { type: "moc", moc: "[[00_MOC/AI Agent OS]]", status: "active" }],
  [/^decisions\//, { type: "decision", moc: "[[00_MOC/Decisions]]", status: "active" }],
  [/^runbooks\//, { type: "runbook", moc: "[[00_MOC/Runbooks]]", status: "active" }],
  [/^agent-guides\//, { type: "agent", moc: "[[00_MOC/Agents]]", status: "active" }],
  [/^wiki\/tools\//, { type: "tool", moc: "[[00_MOC/Tools]]", status: "active" }],
  [/^wiki\/projects\//, { type: "project", moc: "[[00_MOC/Projects]]", status: "active" }],
  [/^wiki\//, { type: "evidence", moc: "[[00_MOC/AI Agent OS]]", status: "draft" }],
  [/^youtube\//, { type: "evidence", moc: "[[00_MOC/Tools]]", status: "draft" }],
  [/^inbox\//, { type: "evidence", moc: "[[00_MOC/Projects]]", status: "draft" }],
  [/^codex-memory\//, { type: "evidence", moc: "[[00_MOC/AI Agent OS]]", status: "active" }],
];
const GRAPH_IGNORED_PREFIXES = [
  "40_템플릿/",
  "_templates/",
  "decisions/archive/",
  "decisions/_pre-reorg-backup-",
  "decisions/_hermes-unauthorized-backup-",
];
const ROOT_TOOL_NOTES = new Set([
  "Antigravity.md",
  "Bedrock.md",
  "Claude.md",
  "Codex.md",
  "env-policy.md",
  "Everything 검색.md",
  "Hermes.md",
  "Lilys.md",
  "MCP.md",
  "model-policy.md",
  "OpenClaw.md",
  "tool-execution-policy.md",
  "VS Code 확장.md",
  "로컬 LLM.md",
  "신뢰 램프.md",
  "작업 파이프라인.md",
  "정책 게이트.md",
]);
const ROOT_AGENT_NOTES = new Set([
  "Business.md",
  "Designer.md",
  "Instagram.md",
  "Secretary.md",
  "검토 에이전트.md",
]);
const ROOT_RUNBOOK_NOTES = new Set([
  "_메모리 규칙.md",
  "_log.md",
  "그래프 정리 인덱스.md",
]);

function getArg(name, fallback = "") {
  const idx = process.argv.indexOf(`--${name}`);
  return idx === -1 ? fallback : process.argv[idx + 1] || fallback;
}

function hasFrontmatter(text) {
  return /^---\r?\n[\s\S]*?\r?\n---\r?\n/.test(String(text || ""));
}

function wikiLinks(text) {
  return [...String(text || "").matchAll(/\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g)].map((match) => match[1].trim());
}

function markdownLinkCount(text) {
  return (String(text || "").match(/\[[^\]]+\]\([^)]+\)/g) || []).length;
}

function compactTimestamp(value = new Date()) {
  return value.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function sha256File(filePath) {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
  } catch {
    return "";
  }
}

function redactLocalPath(fullPath) {
  const resolved = path.resolve(String(fullPath || ""));
  const userProfile = process.env.USERPROFILE ? path.resolve(process.env.USERPROFILE) : "";
  const home = process.env.HOME ? path.resolve(process.env.HOME) : "";
  for (const [label, root] of [["${USERPROFILE}", userProfile], ["${HOME}", home]]) {
    if (root && (resolved === root || resolved.startsWith(`${root}${path.sep}`))) {
      return `${label}${resolved.slice(root.length)}`;
    }
  }
  return resolved;
}

function defaultStorageRoot() {
  return path.resolve(path.dirname(envPaths.agentQueuePath()), "..", "phase2");
}

function approvalArtifactPath(storageRoot, batchId) {
  return path.join(storageRoot, "vault-writer", "human-approvals", `${batchId}.approval.json`);
}

function expectedApprovalText(batchId) {
  return `APPROVE ${batchId}`;
}

function applyEligibility(relPath) {
  try {
    return {
      applyEligible: isAllowedRelPath(relPath, DEFAULT_ALLOWED_SUBDIRS),
      applySkipReason: isAllowedRelPath(relPath, DEFAULT_ALLOWED_SUBDIRS) ? "" : "vault_subdir_not_allowed",
    };
  } catch (error) {
    return {
      applyEligible: false,
      applySkipReason: error && error.message ? error.message : String(error),
    };
  }
}

function isGraphIgnored(relPath) {
  return GRAPH_IGNORED_PREFIXES.some((prefix) => relPath === prefix.slice(0, -1) || relPath.startsWith(prefix));
}

function slugifyNoteName(filename) {
  return path.basename(filename, ".md")
    .trim()
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function manualMoveSuggestion(relPath) {
  if (relPath.includes("/")) return null;
  const basename = path.basename(relPath, ".md").trim();
  if (!basename || !slugifyNoteName(relPath)) return null;
  if (ROOT_TOOL_NOTES.has(relPath)) {
    return {
      targetPath: `wiki/tools/${basename}.md`,
      type: "tool",
      status: "active",
      requiredLink: "[[00_MOC/Tools]]",
      reason: "root_tool_note",
    };
  }
  if (ROOT_AGENT_NOTES.has(relPath)) {
    return {
      targetPath: `agent-guides/${basename}.md`,
      type: "agent",
      status: "active",
      requiredLink: "[[00_MOC/Agents]]",
      reason: "root_agent_note",
    };
  }
  if (ROOT_RUNBOOK_NOTES.has(relPath)) {
    return {
      targetPath: `runbooks/${basename}.md`,
      type: "runbook",
      status: "active",
      requiredLink: "[[00_MOC/Runbooks]]",
      reason: "root_runbook_note",
    };
  }
  return {
    targetPath: `wiki/projects/${basename}.md`,
    type: "project",
    status: "active",
    requiredLink: "[[00_MOC/Projects]]",
    reason: "root_project_note",
  };
}

function manualMovePlan(repairItems, maxItems) {
  return repairItems
    .filter((item) => !item.applyEligible)
    .map((item) => {
      const suggestion = manualMoveSuggestion(item.path);
      return {
        path: item.path,
        issues: item.issues,
        currentReason: item.applySkipReason,
        approvalRequired: true,
        action: suggestion ? "move_then_repair_preserve_basename" : "manual_classification_required",
        suggestedMove: suggestion,
        rollback: "move target back to root path and restore original file from vault-writer backup if needed",
      };
    })
    .slice(0, maxItems);
}

function noteIssues(note) {
  return [
    note.frontmatter ? null : "missing_frontmatter",
    note.hasAnyLink ? null : "linkless",
    note.hasMocLink || note.path.startsWith("00_MOC/") ? null : "missing_moc_link",
  ].filter(Boolean);
}

function summarizeDebt(allRepairs, manualPlan, ignoredByPolicy, maxItems) {
  const sampleLimit = Math.min(Number(maxItems || 10) || 10, 10);
  const safeRepairs = allRepairs.filter((item) => item.applyEligible);
  const approvalRootMoves = manualPlan.filter((item) => item.action === "move_then_repair_preserve_basename");
  const manualClassification = manualPlan.filter((item) => item.action === "manual_classification_required");
  const ignoredDebt = ignoredByPolicy
    .map((note) => ({ path: note.path, issues: noteIssues(note).filter((issue) => issue !== "missing_moc_link") }))
    .filter((item) => item.issues.length > 0)
    .sort((a, b) => a.path.localeCompare(b.path));
  const nextSafeAction = safeRepairs.length > 0
    ? "run_graph_repair"
    : approvalRootMoves.length > 0
    ? "request_human_root_migration_approval"
    : manualClassification.length > 0
    ? "manual_classification_required"
    : ignoredDebt.length > 0
    ? "ignore_or_archive_policy_debt"
    : "none";

  return {
    safeAutoRepair: {
      count: safeRepairs.length,
      sample: safeRepairs.slice(0, sampleLimit).map((item) => item.path),
    },
    approvalRequiredRootMoves: {
      count: approvalRootMoves.length,
      sample: approvalRootMoves.slice(0, sampleLimit).map((item) => ({
        path: item.path,
        targetPath: item.suggestedMove?.targetPath || "",
        requiredLink: item.suggestedMove?.requiredLink || "",
        issues: item.issues,
      })),
    },
    manualClassificationRequired: {
      count: manualClassification.length,
      sample: manualClassification.slice(0, sampleLimit).map((item) => ({ path: item.path, issues: item.issues })),
    },
    ignoredByPolicyDebt: {
      count: ignoredDebt.length,
      sample: ignoredDebt.slice(0, sampleLimit),
    },
    nextSafeAction,
  };
}

function walkMarkdown(root) {
  const files = [];
  function walk(dir) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if ([".obsidian", ".git", "node_modules"].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full).replace(/\\/g, "/");
      if (entry.isDirectory()) {
        if (rel === "_company" || rel.startsWith("_company/")) continue;
        walk(full);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        files.push(full);
      }
    }
  }
  walk(root);
  return files;
}

function classify(relPath) {
  for (const [pattern, suggestion] of MOC_BY_PREFIX) {
    if (pattern.test(relPath)) return suggestion;
  }
  return { type: "project", moc: "[[00_MOC/Projects]]", status: "active" };
}

function noteStats(root, file) {
  const relPath = path.relative(root, file).replace(/\\/g, "/");
  const text = fs.readFileSync(file, "utf8");
  const links = wikiLinks(text);
  const suggestion = classify(relPath);
  const hasMocLink = links.some((link) => link.startsWith("00_MOC/"));
  return {
    path: relPath,
    bytes: fs.statSync(file).size,
    frontmatter: hasFrontmatter(text),
    wikiLinkCount: links.length,
    markdownLinkCount: markdownLinkCount(text),
    hasAnyLink: links.length > 0 || markdownLinkCount(text) > 0,
    hasMocLink,
    suggestedType: suggestion.type,
    suggestedStatus: suggestion.status,
    suggestedMoc: suggestion.moc,
  };
}

function auditGraph(options = {}) {
  const vaultRoot = path.resolve(options.vaultRoot || envPaths.vaultRoot());
  const maxItems = Number(options.maxItems || 50) || 50;
  const allNotes = walkMarkdown(vaultRoot).map((file) => noteStats(vaultRoot, file));
  const ignoredByPolicy = allNotes.filter((note) => isGraphIgnored(note.path));
  const notes = allNotes.filter((note) => !isGraphIgnored(note.path));
  const needsFrontmatter = notes.filter((note) => !note.frontmatter);
  const linkless = notes.filter((note) => !note.hasAnyLink);
  const missingMoc = notes.filter((note) => note.frontmatter && !note.hasMocLink && !note.path.startsWith("00_MOC/"));
  const allRepairs = [...new Map(
    [...needsFrontmatter, ...linkless, ...missingMoc].map((note) => [note.path, {
      path: note.path,
      issues: noteIssues(note),
      suggestedFrontmatter: {
        type: note.suggestedType,
        status: note.suggestedStatus,
        project: "Connect AI",
        owner: "codex",
        source: "obsidian-graph-audit",
        links: [note.suggestedMoc],
      },
      suggestedLink: note.suggestedMoc,
    }])
  ).values()].map((item) => ({ ...item, ...applyEligibility(item.path) }))
    .sort((a, b) => Number(b.applyEligible) - Number(a.applyEligible) || a.path.localeCompare(b.path));
  const repairPlan = allRepairs.slice(0, maxItems);
  const manualPlan = manualMovePlan(allRepairs, maxItems);
  const debtSummary = summarizeDebt(allRepairs, manualPlan, ignoredByPolicy, maxItems);
  return {
    generatedAt: new Date().toISOString(),
    mode: "read-only",
    vaultRoot,
    noteCount: notes.length,
    ignoredByPolicy: ignoredByPolicy.slice(0, 25).map((note) => note.path),
    counts: {
      totalMarkdownNotes: allNotes.length,
      ignoredByPolicy: ignoredByPolicy.length,
      missingFrontmatter: needsFrontmatter.length,
      linkless: linkless.length,
      missingMocLink: missingMoc.length,
      applyEligibleRepairs: allRepairs.filter((item) => item.applyEligible).length,
      needsManualMoveOrPolicy: allRepairs.filter((item) => !item.applyEligible).length,
      plannedRepairs: repairPlan.length,
      plannedManualMoves: manualPlan.length,
    },
    debtSummary,
    repairPlan,
    manualPlan,
  };
}

function repairGraph(options = {}) {
  const vaultRoot = path.resolve(options.vaultRoot || envPaths.vaultRoot());
  const storageRoot = path.resolve(options.storageRoot || defaultStorageRoot());
  const maxItems = Number(options.maxItems || 10) || 10;
  const batchId = String(options.batchId || `graph-repair-${compactTimestamp()}`).replace(/[^\w.-]/g, "-");
  const audit = auditGraph({ vaultRoot, maxItems: Number.MAX_SAFE_INTEGER });
  const planned = audit.repairPlan.filter((item) => item.applyEligible).slice(0, maxItems);
  const skippedIneligible = audit.repairPlan.filter((item) => !item.applyEligible).slice(0, maxItems);
  const execute = !!options.execute;
  const results = planned.map((item) => repairExistingNote({
    memoryRoot: vaultRoot,
    storageRoot,
    batchId,
    relPath: item.path,
    title: path.basename(item.path, ".md"),
    type: item.suggestedFrontmatter.type,
    status: item.suggestedFrontmatter.status,
    project: item.suggestedFrontmatter.project,
    owner: item.suggestedFrontmatter.owner,
    source: "obsidian-graph-audit",
    links: item.suggestedFrontmatter.links,
    tags: [item.suggestedFrontmatter.type, "graph-repair"],
    related: item.suggestedFrontmatter.links,
    dryRun: !execute,
  }));
  return {
    generatedAt: new Date().toISOString(),
    mode: execute ? "live" : "dry-run",
    batchId,
    vaultRoot,
    storageRoot,
    counts: {
      uniqueRepairs: audit.repairPlan.length,
      applyEligibleRepairs: audit.counts.applyEligibleRepairs,
      needsManualMoveOrPolicy: audit.counts.needsManualMoveOrPolicy,
      attempted: results.length,
      wrote: results.filter((item) => item.wrote).length,
      rejected: results.filter((item) => !item.ok).length,
      noOp: results.filter((item) => item.noOp).length,
    },
    results,
    skippedIneligible,
  };
}

function migrateRootNotes(options = {}) {
  const vaultRoot = path.resolve(options.vaultRoot || envPaths.vaultRoot());
  const storageRoot = path.resolve(options.storageRoot || defaultStorageRoot());
  const maxItems = Number(options.maxItems || 10) || 10;
  const batchId = String(options.batchId || `root-migration-${compactTimestamp()}`).replace(/[^\w.-]/g, "-");
  const execute = !!options.execute;
  const audit = auditGraph({ vaultRoot, maxItems: Number.MAX_SAFE_INTEGER });
  const planned = audit.manualPlan
    .filter((item) => item.suggestedMove && item.action === "move_then_repair_preserve_basename")
    .slice(0, maxItems);
  const approval = execute
    ? validateHumanApprovalArtifact({ ...options, vaultRoot, storageRoot, batchId, action: "migrate" })
    : { ok: true, required: false, reason: "dry_run_does_not_require_human_approval" };
  if (execute && !approval.ok) {
    return {
      generatedAt: new Date().toISOString(),
      mode: "live",
      batchId,
      vaultRoot,
      storageRoot,
      requiresApprovalForLiveRun: true,
      approved: false,
      approval,
      counts: {
        manualMoveCandidates: audit.counts.needsManualMoveOrPolicy,
        attempted: 0,
        wrote: 0,
        rejected: planned.length,
        noOp: 0,
      },
      results: [{
        ok: false,
        wrote: false,
        reason: approval.reason || "human_approval_artifact_required",
      }],
    };
  }
  const results = planned.map((item) => moveRootNote({
    memoryRoot: vaultRoot,
    storageRoot,
    batchId,
    relPath: item.path,
    targetRelPath: item.suggestedMove.targetPath,
    title: path.basename(item.suggestedMove.targetPath, ".md"),
    type: item.suggestedMove.type,
    status: item.suggestedMove.status,
    project: "Connect AI",
    owner: "codex",
    source: "obsidian-graph-audit",
    links: [item.suggestedMove.requiredLink],
    tags: [item.suggestedMove.type],
    related: [item.suggestedMove.requiredLink],
    dryRun: !execute,
    approved: execute ? approval.ok : !!options.approved,
  }));
  return {
    generatedAt: new Date().toISOString(),
    mode: execute ? "live" : "dry-run",
    batchId,
    vaultRoot,
    storageRoot,
    requiresApprovalForLiveRun: true,
    approved: execute ? approval.ok : !!options.approved,
    approval,
    counts: {
      manualMoveCandidates: audit.counts.needsManualMoveOrPolicy,
      attempted: results.length,
      wrote: results.filter((item) => item.wrote).length,
      rejected: results.filter((item) => !item.ok).length,
      noOp: results.filter((item) => item.noOp).length,
    },
    results,
  };
}

function createRootMigrationApprovalPacket(options = {}) {
  const vaultRoot = path.resolve(options.vaultRoot || envPaths.vaultRoot());
  const storageRoot = path.resolve(options.storageRoot || defaultStorageRoot());
  const maxItems = Number(options.maxItems || 50) || 50;
  const batchId = String(options.batchId || `root-migration-${compactTimestamp()}`).replace(/[^\w.-]/g, "-");
  const audit = auditGraph({ vaultRoot, maxItems: Number.MAX_SAFE_INTEGER });
  const planned = audit.manualPlan
    .filter((item) => item.suggestedMove && item.action === "move_then_repair_preserve_basename")
    .slice(0, maxItems);
  const moves = planned.map((item) => {
    const relPath = item.path;
    const targetRelPath = item.suggestedMove.targetPath;
    const sourcePath = path.join(vaultRoot, relPath);
    const targetPath = path.join(vaultRoot, targetRelPath);
    const basenamePreserved = path.basename(relPath, ".md") === path.basename(targetRelPath, ".md");
    const problems = [
      fs.existsSync(sourcePath) ? null : "source_missing",
      fs.existsSync(targetPath) ? "target_already_exists" : null,
      basenamePreserved ? null : "basename_not_preserved",
    ].filter(Boolean);
    return {
      relPath,
      targetRelPath,
      type: item.suggestedMove.type,
      status: item.suggestedMove.status,
      requiredLink: item.suggestedMove.requiredLink,
      reason: item.suggestedMove.reason,
      riskClass: "Red",
      writeScope: "vault-root-note-migration",
      rollbackPath: `npm run agent:graph-audit -- --rollback-roots --batch-id ${batchId} --execute --approved`,
      basenamePreserved,
      sourceExists: fs.existsSync(sourcePath),
      targetExists: fs.existsSync(targetPath),
      problems,
    };
  });
  const safetyProblems = moves.flatMap((move) => move.problems.map((problem) => `${move.relPath}:${problem}`));
  const expectedArtifactPath = approvalArtifactPath(storageRoot, batchId);
  const liveCommand = `npm run agent:graph-audit -- --migrate-roots --max ${maxItems} --batch-id ${batchId} --execute --approved`;
  const rollbackCommand = `npm run agent:graph-audit -- --rollback-roots --batch-id ${batchId} --execute --approved`;
  return {
    generatedAt: new Date().toISOString(),
    mode: "approval-packet",
    batchId,
    paths: {
      vaultRoot: redactLocalPath(vaultRoot),
      storageRoot: redactLocalPath(storageRoot),
    },
    requiresExplicitHumanApproval: true,
    approved: false,
    readyForApproval: moves.length > 0 && safetyProblems.length === 0,
    counts: {
      manualMoveCandidates: audit.counts.needsManualMoveOrPolicy,
      plannedMoves: moves.length,
      safetyProblems: safetyProblems.length,
      unresolvedGraphRepairsAfterMove: Math.max(0, audit.counts.needsManualMoveOrPolicy - moves.length),
    },
    commands: {
      dryRun: `npm run agent:graph-audit -- --migrate-roots --max ${maxItems} --batch-id ${batchId}`,
      live: liveCommand,
      rollback: rollbackCommand,
    },
    humanApprovalArtifact: {
      path: redactLocalPath(expectedArtifactPath),
      requiredForLiveMigration: true,
      requiredForRollback: true,
      createManually: true,
      requiredJson: {
        kind: "root-migration-human-approval",
        actorType: "human",
        approved: true,
        batchId,
        approvedActions: ["migrate", "rollback"],
        approvalText: expectedApprovalText(batchId),
        approvedBy: "<human name>",
        approvedAt: "<ISO-8601 timestamp after packet review>",
        packetSha256: "<sha256 of approval packet json>",
      },
    },
    mandatoryPostRunGates: [
      "npm run agent:graph-audit -- --max 20",
      "powershell -NoProfile -ExecutionPolicy Bypass -File $env:USERPROFILE\\connect-ai-vault\\runbooks\\_scripts\\obsidian-vault-health.ps1 -Json",
      "npm run agent:transport-audit",
      "npm run agent:nightly-audit",
    ],
    safetyPolicy: {
      durableWriter: "scripts/vault-writer.js",
      directVaultWritesAllowed: false,
      preservesWikiBasenames: moves.every((move) => move.basenamePreserved),
      writesRequireExecuteApprovedAndHumanArtifact: true,
      rollbackRequiresExecuteApprovedAndHumanArtifact: true,
    },
    safetyProblems,
    moves,
  };
}

function approvalPacketMarkdown(packet) {
  const lines = [
    `# Root Note Migration Approval Packet`,
    "",
    `- status: ${packet.readyForApproval ? "READY_FOR_HUMAN_APPROVAL" : "NOT_READY"}`,
    `- batchId: ${packet.batchId}`,
    `- generatedAt: ${packet.generatedAt}`,
    `- vaultRoot: ${packet.paths.vaultRoot}`,
    `- storageRoot: ${packet.paths.storageRoot}`,
    `- plannedMoves: ${packet.counts.plannedMoves}`,
    `- safetyProblems: ${packet.counts.safetyProblems}`,
    `- humanApprovalArtifact: ${packet.humanApprovalArtifact?.path || ""}`,
    "",
    "## Commands",
    "",
    "```powershell",
    packet.commands.dryRun,
    packet.commands.live,
    packet.commands.rollback,
    "```",
    "",
    "## Mandatory Post-Run Gates",
    "",
    ...packet.mandatoryPostRunGates.map((command) => `- \`${command}\``),
    "",
    "## Human Approval Artifact",
    "",
    "Live migration and rollback require this JSON artifact in addition to `--execute --approved`:",
    "",
    "Run this read-only command to compute the current packet hash template:",
    "",
    "```powershell",
    `npm run agent:graph-audit -- --approval-template --batch-id ${packet.batchId}`,
    "```",
    "",
    "```json",
    JSON.stringify(packet.humanApprovalArtifact?.requiredJson || {}, null, 2),
    "```",
    "",
    "## Moves",
    "",
    "| Source | Target | Type | Required Link | Risk | Problems |",
    "| --- | --- | --- | --- | --- | --- |",
    ...packet.moves.map((move) => `| ${move.relPath} | ${move.targetRelPath} | ${move.type} | ${move.requiredLink} | ${move.riskClass} | ${move.problems.join(", ") || "none"} |`),
    "",
    "## Safety Policy",
    "",
    `- durableWriter: ${packet.safetyPolicy.durableWriter}`,
    `- directVaultWritesAllowed: ${packet.safetyPolicy.directVaultWritesAllowed}`,
    `- preservesWikiBasenames: ${packet.safetyPolicy.preservesWikiBasenames}`,
    `- writesRequireExecuteApprovedAndHumanArtifact: ${packet.safetyPolicy.writesRequireExecuteApprovedAndHumanArtifact}`,
    `- rollbackRequiresExecuteApprovedAndHumanArtifact: ${packet.safetyPolicy.rollbackRequiresExecuteApprovedAndHumanArtifact}`,
  ];
  return `${lines.join("\n")}\n`;
}

function writeApprovalPacket(packet, storageRoot) {
  const packetDir = path.join(storageRoot, "vault-writer", "approval-packets");
  fs.mkdirSync(packetDir, { recursive: true });
  const jsonPath = path.join(packetDir, `${packet.batchId}.json`);
  const markdownPath = path.join(packetDir, `${packet.batchId}.md`);
  fs.writeFileSync(jsonPath, `${JSON.stringify(packet, null, 2)}\n`, "utf8");
  fs.writeFileSync(markdownPath, approvalPacketMarkdown(packet), "utf8");
  return {
    jsonPath,
    markdownPath,
  };
}

function latestApprovalPacketPath(storageRoot) {
  const packetDir = path.join(storageRoot, "vault-writer", "approval-packets");
  if (!fs.existsSync(packetDir)) return "";
  const packets = fs.readdirSync(packetDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".json"))
    .map((entry) => {
      const jsonPath = path.join(packetDir, entry.name);
      let generatedAt = "";
      try {
        generatedAt = JSON.parse(fs.readFileSync(jsonPath, "utf8")).generatedAt || "";
      } catch {
        generatedAt = "";
      }
      return { jsonPath, generatedAt, mtime: fs.statSync(jsonPath).mtime.toISOString() };
    })
    .sort((a, b) => String(b.generatedAt || b.mtime).localeCompare(String(a.generatedAt || a.mtime)));
  return packets[0]?.jsonPath || "";
}

function validateHumanApprovalArtifact(options = {}) {
  const storageRoot = path.resolve(options.storageRoot || defaultStorageRoot());
  const batchId = String(options.batchId || "").replace(/[^\w.-]/g, "-");
  const action = String(options.action || "migrate");
  const approvalFile = path.resolve(options.approvalFile || approvalArtifactPath(storageRoot, batchId));
  const packetPath = path.resolve(options.packetPath || latestApprovalPacketPath(storageRoot));
  if (!options.approved) return { ok: false, required: true, reason: "approval_flag_required", approvalFile, packetPath };
  if (!batchId) return { ok: false, required: true, reason: "batch_id_required", approvalFile, packetPath };
  if (!packetPath || !fs.existsSync(packetPath)) return { ok: false, required: true, reason: "approval_packet_required", approvalFile, packetPath };
  if (!fs.existsSync(approvalFile)) return { ok: false, required: true, reason: "human_approval_artifact_required", approvalFile, packetPath };

  let packet;
  let artifact;
  try {
    packet = JSON.parse(fs.readFileSync(packetPath, "utf8"));
  } catch (error) {
    return { ok: false, required: true, reason: "approval_packet_invalid_json", approvalFile, packetPath, error: error && error.message ? error.message : String(error) };
  }
  try {
    artifact = JSON.parse(fs.readFileSync(approvalFile, "utf8"));
  } catch (error) {
    return { ok: false, required: true, reason: "human_approval_artifact_invalid_json", approvalFile, packetPath, error: error && error.message ? error.message : String(error) };
  }

  const packetHash = sha256File(packetPath);
  const approvedAtMs = Date.parse(artifact.approvedAt || "");
  const packetGeneratedAtMs = Date.parse(packet.generatedAt || "");
  const approvedActions = Array.isArray(artifact.approvedActions) ? artifact.approvedActions.map(String) : [];
  const errors = [
    artifact.kind === "root-migration-human-approval" ? null : "invalid_kind",
    artifact.actorType === "human" ? null : "actor_type_must_be_human",
    artifact.approved === true ? null : "artifact_not_approved",
    artifact.batchId === batchId ? null : "batch_id_mismatch",
    approvedActions.includes(action) || approvedActions.includes("*") ? null : "action_not_approved",
    artifact.approvalText === expectedApprovalText(batchId) ? null : "approval_text_mismatch",
    String(artifact.approvedBy || "").trim() ? null : "approved_by_required",
    Number.isFinite(approvedAtMs) ? null : "approved_at_invalid",
    packetHash && artifact.packetSha256 === packetHash ? null : "packet_hash_mismatch",
    Number.isFinite(approvedAtMs) && Number.isFinite(packetGeneratedAtMs) && approvedAtMs >= packetGeneratedAtMs ? null : "approval_must_be_after_packet_generation",
  ].filter(Boolean);
  if (action === "migrate") {
    const freshness = verifyRootMigrationApprovalPacket({
      vaultRoot: options.vaultRoot,
      storageRoot,
      packetPath,
    });
    if (!freshness.ok) errors.push("approval_packet_not_fresh");
  }
  return {
    ok: errors.length === 0,
    required: true,
    reason: errors[0] || "",
    errors,
    action,
    batchId,
    approvalFile,
    packetPath,
    packetSha256: packetHash,
    approvedBy: artifact.approvedBy || "",
    approvedAt: artifact.approvedAt || "",
  };
}

function createHumanApprovalTemplate(options = {}) {
  const storageRoot = path.resolve(options.storageRoot || defaultStorageRoot());
  const packetPath = path.resolve(options.packetPath || latestApprovalPacketPath(storageRoot));
  if (!packetPath || !fs.existsSync(packetPath)) {
    return {
      ok: false,
      mode: "human-approval-template",
      wrote: false,
      reason: "approval_packet_required",
      packetPath,
    };
  }
  let packet;
  try {
    packet = JSON.parse(fs.readFileSync(packetPath, "utf8"));
  } catch (error) {
    return {
      ok: false,
      mode: "human-approval-template",
      wrote: false,
      reason: "approval_packet_invalid_json",
      packetPath,
      error: error && error.message ? error.message : String(error),
    };
  }
  const batchId = String(options.batchId || packet.batchId || path.basename(packetPath, ".json")).replace(/[^\w.-]/g, "-");
  const approvalFile = approvalArtifactPath(storageRoot, batchId);
  const packetHash = sha256File(packetPath);
  const freshness = verifyRootMigrationApprovalPacket({
    vaultRoot: options.vaultRoot,
    storageRoot,
    packetPath,
  });
  return {
    ok: freshness.ok && packet.readyForApproval === true && packetHash.length > 0,
    mode: "human-approval-template",
    wrote: false,
    writeForbidden: true,
    createManually: true,
    batchId,
    packetPath,
    packetSha256: packetHash,
    approvalFile,
    approvalText: expectedApprovalText(batchId),
    freshness: {
      ok: freshness.ok,
      fresh: freshness.fresh,
      staleReasons: Array.isArray(freshness.staleReasons) ? freshness.staleReasons : [],
      currentPlannedMoves: freshness.counts?.currentPlannedMoves ?? null,
      currentSafetyProblems: freshness.counts?.currentSafetyProblems ?? null,
    },
    template: {
      kind: "root-migration-human-approval",
      actorType: "human",
      approved: true,
      batchId,
      approvedActions: ["migrate", "rollback"],
      approvalText: expectedApprovalText(batchId),
      approvedBy: "<human name>",
      approvedAt: "<ISO-8601 timestamp after packet review>",
      packetSha256: packetHash,
    },
    instructions: [
      "Review the approval packet markdown and planned moves first.",
      "Only a human should create the approval JSON at approvalFile.",
      "Do not let agents create this file automatically.",
      "After creating it, rerun the live migration command and mandatory post-run gates.",
    ],
  };
}

function rollbackRootMoves(options = {}) {
  const memoryRoot = path.resolve(String(options.memoryRoot || options.vaultRoot || envPaths.vaultRoot()));
  const storageRoot = path.resolve(String(options.storageRoot || defaultStorageRoot()));
  const batchId = String(options.batchId || "").replace(/[^\w.-]/g, "-");
  const dryRun = !!options.dryRun;
  const approval = dryRun
    ? { ok: true, required: false, reason: "dry_run_does_not_require_human_approval" }
    : validateHumanApprovalArtifact({ ...options, storageRoot, batchId, action: "rollback" });
  if (!dryRun && !approval.ok) {
    return {
      ok: false,
      wrote: false,
      mode: "live",
      batchId,
      count: 0,
      approval,
      results: [{
        ok: false,
        wrote: false,
        reason: approval.reason || "human_approval_artifact_required",
      }],
    };
  }
  const result = rollbackRootMovesViaWriter({
    memoryRoot,
    storageRoot,
    batchId,
    dryRun,
    approved: dryRun ? !!options.approved : approval.ok,
  });
  return { ...result, approval };
}

function moveIdentity(move) {
  return {
    relPath: move.relPath || "",
    targetRelPath: move.targetRelPath || "",
    type: move.type || "",
    status: move.status || "",
    requiredLink: move.requiredLink || "",
    reason: move.reason || "",
    basenamePreserved: !!move.basenamePreserved,
    sourceExists: !!move.sourceExists,
    targetExists: !!move.targetExists,
    problems: Array.isArray(move.problems) ? move.problems.map(String).sort() : [],
  };
}

function moveKey(move) {
  const identity = moveIdentity(move);
  return JSON.stringify(identity);
}

function verifyRootMigrationApprovalPacket(options = {}) {
  const vaultRoot = path.resolve(options.vaultRoot || envPaths.vaultRoot());
  const storageRoot = path.resolve(options.storageRoot || defaultStorageRoot());
  const packetPath = path.resolve(options.packetPath || latestApprovalPacketPath(storageRoot));
  if (!packetPath || !fs.existsSync(packetPath)) {
    return {
      ok: true,
      pending: false,
      mode: "approval-packet-verification",
      reason: "no_approval_packet",
      vaultRoot,
      storageRoot,
    };
  }

  let packet;
  try {
    packet = JSON.parse(fs.readFileSync(packetPath, "utf8"));
  } catch (error) {
    return {
      ok: false,
      pending: true,
      mode: "approval-packet-verification",
      reason: "approval_packet_invalid_json",
      packetPath,
      error: error && error.message ? error.message : String(error),
    };
  }

  const batchId = String(packet.batchId || path.basename(packetPath, ".json"));
  const expectedApprovalFile = approvalArtifactPath(storageRoot, batchId);
  const packetMoves = Array.isArray(packet.moves) ? packet.moves : [];
  const maxItems = Number(options.maxItems || packet.counts?.plannedMoves || packetMoves.length || 50) || 50;
  const current = createRootMigrationApprovalPacket({ vaultRoot, storageRoot, maxItems, batchId });
  const currentMoves = Array.isArray(current.moves) ? current.moves : [];
  const packetMoveKeys = new Set(packetMoves.map(moveKey));
  const currentMoveKeys = new Set(currentMoves.map(moveKey));
  const missingFromCurrent = packetMoves
    .filter((move) => !currentMoveKeys.has(moveKey(move)))
    .map(moveIdentity);
  const addedSincePacket = currentMoves
    .filter((move) => !packetMoveKeys.has(moveKey(move)))
    .map(moveIdentity);
  const staleReasons = [
    packet.mode === "approval-packet" ? null : "packet_mode_not_approval_packet",
    packet.requiresExplicitHumanApproval === true ? null : "packet_missing_human_approval_requirement",
    packet.readyForApproval === true ? null : "packet_not_ready_for_approval",
    packet.approved === false ? null : "packet_already_approved",
    Number(packet.counts?.plannedMoves ?? packetMoves.length) === current.counts.plannedMoves ? null : "planned_move_count_changed",
    Number(packet.counts?.safetyProblems ?? packet.safetyProblems?.length ?? 0) === current.counts.safetyProblems ? null : "safety_problem_count_changed",
    missingFromCurrent.length === 0 && addedSincePacket.length === 0 ? null : "move_plan_changed",
    Array.isArray(packet.safetyProblems) && JSON.stringify(packet.safetyProblems.map(String).sort()) === JSON.stringify(current.safetyProblems.map(String).sort()) ? null : "safety_problems_changed",
  ].filter(Boolean);

  return {
    ok: staleReasons.length === 0,
    pending: true,
    fresh: staleReasons.length === 0,
    mode: "approval-packet-verification",
    batchId,
    packetPath,
    markdownPath: path.join(path.dirname(packetPath), `${batchId}.md`),
    packetGeneratedAt: packet.generatedAt || "",
    currentGeneratedAt: current.generatedAt,
    staleReasons,
    humanApprovalArtifact: {
      path: expectedApprovalFile,
      exists: fs.existsSync(expectedApprovalFile),
    },
    counts: {
      packetPlannedMoves: Number(packet.counts?.plannedMoves ?? packetMoves.length),
      currentPlannedMoves: current.counts.plannedMoves,
      packetSafetyProblems: Number(packet.counts?.safetyProblems ?? packet.safetyProblems?.length ?? 0),
      currentSafetyProblems: current.counts.safetyProblems,
      missingFromCurrent: missingFromCurrent.length,
      addedSincePacket: addedSincePacket.length,
    },
    packetCommands: packet.commands || {},
    currentCommands: current.commands,
    missingFromCurrent: missingFromCurrent.slice(0, 20),
    addedSincePacket: addedSincePacket.slice(0, 20),
  };
}

function main() {
  const options = {
    vaultRoot: getArg("vault-root", envPaths.vaultRoot()),
    storageRoot: getArg("storage-root", defaultStorageRoot()),
    maxItems: getArg("max", ""),
    batchId: getArg("batch-id", ""),
    packetPath: getArg("packet", ""),
    execute: process.argv.includes("--execute"),
    approved: process.argv.includes("--approved"),
  };
  const report = process.argv.includes("--migrate-roots")
    ? migrateRootNotes(options)
    : process.argv.includes("--rollback-roots")
    ? rollbackRootMoves({ ...options, dryRun: !options.execute })
    : process.argv.includes("--verify-approval-packet")
    ? verifyRootMigrationApprovalPacket(options)
    : process.argv.includes("--approval-template")
    ? createHumanApprovalTemplate(options)
    : process.argv.includes("--approval-packet")
    ? (() => {
      const packet = createRootMigrationApprovalPacket(options);
      if (!process.argv.includes("--write-packet")) return packet;
      return {
        ...packet,
        packetFiles: writeApprovalPacket(packet, path.resolve(options.storageRoot)),
      };
    })()
    : process.argv.includes("--apply")
    ? repairGraph(options)
    : auditGraph(options);
  console.log(JSON.stringify(report, null, 2));
  if (process.argv.includes("--verify-approval-packet") && report.ok === false) process.exit(1);
  if (process.argv.includes("--approval-template") && report.ok === false) process.exit(1);
}

if (require.main === module) main();

module.exports = {
  GRAPH_IGNORED_PREFIXES,
  auditGraph,
  classify,
  createRootMigrationApprovalPacket,
  createHumanApprovalTemplate,
  isGraphIgnored,
  migrateRootNotes,
  manualMoveSuggestion,
  approvalPacketMarkdown,
  approvalArtifactPath,
  repairGraph,
  rollbackRootMoves,
  validateHumanApprovalArtifact,
  verifyRootMigrationApprovalPacket,
  writeApprovalPacket,
};
