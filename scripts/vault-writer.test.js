#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  buildFrontmatter,
  appendToNote,
  moveRootNote,
  normalizeVaultRelPath,
  repairExistingNote,
  rollbackRootMoves,
  writeDurableNote,
} = require("./vault-writer.js");

function tempRoot(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("vault writer rejects runtime and internal Obsidian paths without creating notes", () => {
  const memoryRoot = tempRoot("connect-ai-vault-writer-vault-");
  const storageRoot = tempRoot("connect-ai-vault-writer-store-");

  const result = writeDurableNote({
    memoryRoot,
    storageRoot,
    relPath: "_company/sessions/leak.md",
    title: "Runtime leak",
    type: "evidence",
    status: "draft",
    project: "Connect AI",
    owner: "codex",
    source: "test",
    links: ["[[00_MOC/AI Agent OS]]"],
    body: "This should not be written.",
  });

  assert.equal(result.ok, false);
  assert.equal(result.wrote, false);
  assert.match(result.reason, /runtime_path_forbidden/);
  assert.equal(fs.existsSync(path.join(memoryRoot, "_company", "sessions", "leak.md")), false);
  const rejectionLog = path.join(storageRoot, "rejected-writes", "rejected-writes.jsonl");
  assert.equal(fs.existsSync(rejectionLog), true);
  assert.match(fs.readFileSync(rejectionLog, "utf8"), /runtime_path_forbidden/);
});

test("vault writer enforces governance policy for daily logs, routine paths, and required frontmatter", () => {
  const memoryRoot = tempRoot("connect-ai-vault-writer-vault-");
  const storageRoot = tempRoot("connect-ai-vault-writer-store-");
  const common = {
    memoryRoot,
    storageRoot,
    title: "Policy probe",
    status: "draft",
    project: "Connect AI",
    owner: "codex",
    source: "test",
    links: ["[[00_MOC/AI Agent OS]]"],
    tags: ["policy"],
    related: ["[[00_MOC/AI Agent OS]]"],
    body: "# Policy probe\n",
  };

  const daily = writeDurableNote({
    ...common,
    relPath: "wiki/projects/agent-os-2026-05-28.md",
    type: "project",
  });
  assert.equal(daily.ok, false);
  assert.equal(daily.wrote, false);
  assert.match(daily.reason, /이 write는 daily-working-log 룰 위반/);
  assert.equal(fs.existsSync(path.join(memoryRoot, "wiki", "projects", "agent-os-2026-05-28.md")), false);

  const routine = writeDurableNote({
    ...common,
    relPath: "wiki/misc/free-note.md",
    type: "evidence",
  });
  assert.equal(routine.ok, false);
  assert.match(routine.reason, /이 write는 routine-note-prefix 룰 위반/);
  assert.match(routine.reason, /notes\/.*ideas\/.*references\//);

  const frontmatter = writeDurableNote({
    ...common,
    relPath: "notes/missing-related.md",
    type: "evidence",
    related: [],
  });
  assert.equal(frontmatter.ok, false);
  assert.match(frontmatter.reason, /이 write는 frontmatter-required 룰 위반/);
});

test("vault writer requires protected durable notes to relate to a known MOC hub", () => {
  const memoryRoot = tempRoot("connect-ai-vault-writer-vault-");
  const storageRoot = tempRoot("connect-ai-vault-writer-store-");

  const result = writeDurableNote({
    memoryRoot,
    storageRoot,
    relPath: "decisions/no-related-moc.md",
    title: "No Related MOC",
    type: "decision",
    status: "draft",
    project: "Connect AI",
    owner: "codex",
    source: "test",
    links: ["[[00_MOC/Decisions]]", "[[Connect AI]]"],
    tags: ["decision"],
    related: ["[[Connect AI]]"],
    body: "# No Related MOC\n",
  });

  assert.equal(result.ok, false);
  assert.equal(result.wrote, false);
  assert.match(result.reason, /이 write는 moc-related-required 룰 위반/);
  assert.equal(fs.existsSync(path.join(memoryRoot, "decisions", "no-related-moc.md")), false);
});

test("vault writer dry-run validates frontmatter and required MOC link without writing", () => {
  const memoryRoot = tempRoot("connect-ai-vault-writer-vault-");
  const storageRoot = tempRoot("connect-ai-vault-writer-store-");

  const result = writeDurableNote({
    memoryRoot,
    storageRoot,
    relPath: "00_MOC/AI Agent OS.md",
    title: "AI Agent OS",
    type: "moc",
    status: "active",
    project: "Connect AI",
    owner: "codex",
    source: "test",
    links: ["[[Connect AI]]"],
    tags: ["agent-os", "multi-agent"],
    related: ["[[00_MOC/Agents]]", "[[00_MOC/Projects]]"],
    body: "# AI Agent OS\n\n[[Connect AI]]",
    dryRun: true,
  });

  assert.equal(result.ok, true);
  assert.equal(result.wrote, false);
  assert.match(result.previewContent, /^---\ntype: moc\nstatus: active/m);
  assert.match(result.previewContent, /tags:\n  - "agent-os"\n  - "multi-agent"/);
  assert.match(result.previewContent, /related:\n  - "\[\[00_MOC\/Agents\]\]"\n  - "\[\[00_MOC\/Projects\]\]"/);
  assert.match(result.previewContent, /links:\n  - "\[\[Connect AI\]\]"/);
  assert.equal(fs.existsSync(path.join(memoryRoot, "00_MOC", "AI Agent OS.md")), false);
});

test("vault writer writes durable notes once and rejects duplicates", () => {
  const memoryRoot = tempRoot("connect-ai-vault-writer-vault-");
  const storageRoot = tempRoot("connect-ai-vault-writer-store-");

  const request = {
    memoryRoot,
    storageRoot,
    relPath: "decisions/single-writer-policy.md",
    title: "Agent OS",
    type: "decision",
    status: "active",
    project: "Connect AI",
    owner: "codex",
    source: "test",
    links: ["[[00_MOC/Decisions]]", "[[Connect AI]]"],
    tags: ["decision", "agent-os"],
    related: ["[[00_MOC/Decisions]]"],
    body: "- 결정: Single writer",
  };

  const first = writeDurableNote(request);
  assert.equal(first.ok, true);
  assert.equal(first.wrote, true);
  assert.match(fs.readFileSync(first.path, "utf8"), /type: decision/);
  assert.match(fs.readFileSync(first.path, "utf8"), /\[\[00_MOC\/Decisions\]\]/);

  const duplicate = writeDurableNote(request);
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.wrote, false);
  assert.match(duplicate.reason, /duplicate_note/);
});

test("vault writer normalizes safe markdown paths only", () => {
  assert.equal(normalizeVaultRelPath("decisions\\2026-05\\note.md"), "decisions/2026-05/note.md");
  assert.throws(() => normalizeVaultRelPath("../outside.md"), /outside_vault/);
  assert.throws(() => normalizeVaultRelPath(".obsidian/graph.json"), /obsidian_internal_path_forbidden/);
  assert.throws(() => normalizeVaultRelPath("runbooks/not-markdown.txt"), /vault_note_must_be_markdown/);
  assert.match(buildFrontmatter({
    type: "runbook",
    status: "active",
    project: "Connect AI",
    owner: "codex",
    source: "test",
    links: ["[[00_MOC/Runbooks]]"],
  }), /updated:/);
});

test("vault writer appends to existing notes with backup manifest", () => {
  const memoryRoot = tempRoot("connect-ai-vault-writer-vault-");
  const storageRoot = tempRoot("connect-ai-vault-writer-store-");
  const notePath = path.join(memoryRoot, "wiki", "projects", "vision.md");
  fs.mkdirSync(path.dirname(notePath), { recursive: true });
  fs.writeFileSync(notePath, "# Vision\n", "utf8");

  const dryRun = appendToNote({
    memoryRoot,
    storageRoot,
    batchId: "append-test",
    relPath: "wiki/projects/vision.md",
    marker: "<!-- s2-links -->",
    body: "<!-- s2-links -->\n\n- [[00_MOC/moc-agents]]\n",
    dryRun: true,
  });

  assert.equal(dryRun.ok, true);
  assert.equal(dryRun.wrote, false);
  assert.match(dryRun.previewContent, /\[\[00_MOC\/moc-agents\]\]/);
  assert.equal(fs.readFileSync(notePath, "utf8"), "# Vision\n");

  const applied = appendToNote({
    memoryRoot,
    storageRoot,
    batchId: "append-test",
    relPath: "wiki/projects/vision.md",
    marker: "<!-- s2-links -->",
    body: "<!-- s2-links -->\n\n- [[00_MOC/moc-agents]]\n",
  });

  assert.equal(applied.ok, true);
  assert.equal(applied.wrote, true);
  assert.match(fs.readFileSync(notePath, "utf8"), /\[\[00_MOC\/moc-agents\]\]/);
  assert.equal(fs.readFileSync(applied.backupPath, "utf8"), "# Vision\n");

  const duplicate = appendToNote({
    memoryRoot,
    storageRoot,
    batchId: "append-test",
    relPath: "wiki/projects/vision.md",
    marker: "<!-- s2-links -->",
    body: "<!-- s2-links -->\n\n- [[00_MOC/moc-agents]]\n",
  });

  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.wrote, false);
  assert.equal(duplicate.noOp, true);
});

test("vault writer repairs existing notes with backup manifest", () => {
  const memoryRoot = tempRoot("connect-ai-vault-writer-vault-");
  const storageRoot = tempRoot("connect-ai-vault-writer-store-");
  const notePath = path.join(memoryRoot, "decisions", "legacy.md");
  fs.mkdirSync(path.dirname(notePath), { recursive: true });
  fs.writeFileSync(notePath, "# Legacy\nNo hub yet.\n", "utf8");

  const dryRun = repairExistingNote({
    memoryRoot,
    storageRoot,
    batchId: "batch-test",
    relPath: "decisions/legacy.md",
    title: "Legacy",
    type: "decision",
    status: "active",
    project: "Connect AI",
    owner: "codex",
    source: "test",
    links: ["[[00_MOC/Decisions]]"],
    tags: ["decision", "repair"],
    related: ["[[00_MOC/Decisions]]"],
    dryRun: true,
  });

  assert.equal(dryRun.ok, true);
  assert.equal(dryRun.wrote, false);
  assert.deepEqual(dryRun.operations, ["added_frontmatter"]);
  assert.equal(fs.readFileSync(notePath, "utf8"), "# Legacy\nNo hub yet.\n");

  const applied = repairExistingNote({
    memoryRoot,
    storageRoot,
    batchId: "batch-test",
    relPath: "decisions/legacy.md",
    title: "Legacy",
    type: "decision",
    status: "active",
    project: "Connect AI",
    owner: "codex",
    source: "test",
    links: ["[[00_MOC/Decisions]]"],
    tags: ["decision", "repair"],
    related: ["[[00_MOC/Decisions]]"],
  });

  assert.equal(applied.ok, true);
  assert.equal(applied.wrote, true);
  assert.match(fs.readFileSync(notePath, "utf8"), /^---\ntype: decision/m);
  assert.equal(fs.readFileSync(applied.backupPath, "utf8"), "# Legacy\nNo hub yet.\n");
  const manifest = path.join(storageRoot, "vault-writer", "repair-manifests", "batch-test.jsonl");
  assert.match(fs.readFileSync(manifest, "utf8"), /decisions\/legacy\.md/);
});

test("vault writer migrates root notes only after explicit approval", () => {
  const memoryRoot = tempRoot("connect-ai-vault-writer-vault-");
  const storageRoot = tempRoot("connect-ai-vault-writer-store-");
  const notePath = path.join(memoryRoot, "Claude.md");
  fs.writeFileSync(notePath, "# Claude\nRoot tool note.\n", "utf8");

  const dryRun = moveRootNote({
    memoryRoot,
    storageRoot,
    batchId: "root-move",
    relPath: "Claude.md",
    targetRelPath: "wiki/tools/Claude.md",
    title: "Claude",
    type: "tool",
    status: "active",
    project: "Connect AI",
    owner: "codex",
    source: "test",
    links: ["[[00_MOC/Tools]]"],
    tags: ["tool", "migration"],
    related: ["[[00_MOC/Tools]]"],
    dryRun: true,
  });

  assert.equal(dryRun.ok, true);
  assert.equal(dryRun.wrote, false);
  assert.equal(fs.existsSync(path.join(memoryRoot, "wiki", "tools", "Claude.md")), false);

  const rejected = moveRootNote({
    memoryRoot,
    storageRoot,
    batchId: "root-move",
    relPath: "Claude.md",
    targetRelPath: "wiki/tools/Claude.md",
    title: "Claude",
    type: "tool",
    status: "active",
    project: "Connect AI",
    owner: "codex",
    source: "test",
    links: ["[[00_MOC/Tools]]"],
    tags: ["tool", "migration"],
    related: ["[[00_MOC/Tools]]"],
  });

  assert.equal(rejected.ok, false);
  assert.match(rejected.reason, /approval/);
  assert.equal(fs.existsSync(notePath), true);

  const moved = moveRootNote({
    memoryRoot,
    storageRoot,
    batchId: "root-move",
    relPath: "Claude.md",
    targetRelPath: "wiki/tools/Claude.md",
    title: "Claude",
    type: "tool",
    status: "active",
    project: "Connect AI",
    owner: "codex",
    source: "test",
    links: ["[[00_MOC/Tools]]"],
    tags: ["tool", "migration"],
    related: ["[[00_MOC/Tools]]"],
    approved: true,
  });

  assert.equal(moved.ok, true);
  assert.equal(moved.wrote, true);
  assert.equal(fs.existsSync(notePath), false);
  assert.match(fs.readFileSync(path.join(memoryRoot, "wiki", "tools", "Claude.md"), "utf8"), /^---\ntype: tool/m);
  assert.equal(fs.readFileSync(moved.backupPath, "utf8"), "# Claude\nRoot tool note.\n");
});

test("vault writer rejects root migration when target basename would break wiki links", () => {
  const memoryRoot = tempRoot("connect-ai-vault-writer-vault-");
  const storageRoot = tempRoot("connect-ai-vault-writer-store-");
  fs.writeFileSync(path.join(memoryRoot, "로컬 LLM.md"), "# 로컬 LLM\n", "utf8");

  const result = moveRootNote({
    memoryRoot,
    storageRoot,
    batchId: "root-move",
    relPath: "로컬 LLM.md",
    targetRelPath: "wiki/tools/로컬-LLM.md",
    title: "로컬 LLM",
    type: "tool",
    status: "active",
    project: "Connect AI",
    owner: "codex",
    source: "test",
    links: ["[[00_MOC/Tools]]"],
    dryRun: true,
  });

  assert.equal(result.ok, false);
  assert.match(result.reason, /basename/);
});

test("vault writer rolls back approved root migrations from manifest", () => {
  const memoryRoot = tempRoot("connect-ai-vault-writer-vault-");
  const storageRoot = tempRoot("connect-ai-vault-writer-store-");
  fs.writeFileSync(path.join(memoryRoot, "Claude.md"), "# Claude\nRoot tool note.\n", "utf8");

  const moved = moveRootNote({
    memoryRoot,
    storageRoot,
    batchId: "root-move-rollback",
    relPath: "Claude.md",
    targetRelPath: "wiki/tools/Claude.md",
    title: "Claude",
    type: "tool",
    status: "active",
    project: "Connect AI",
    owner: "codex",
    source: "test",
    links: ["[[00_MOC/Tools]]"],
    tags: ["tool", "migration"],
    related: ["[[00_MOC/Tools]]"],
    approved: true,
  });

  assert.equal(moved.ok, true);
  assert.equal(fs.existsSync(path.join(memoryRoot, "Claude.md")), false);

  const dryRun = rollbackRootMoves({
    memoryRoot,
    storageRoot,
    batchId: "root-move-rollback",
    dryRun: true,
  });

  assert.equal(dryRun.ok, true);
  assert.equal(dryRun.wrote, false);
  assert.equal(dryRun.count, 1);
  assert.equal(fs.existsSync(path.join(memoryRoot, "wiki", "tools", "Claude.md")), true);

  const rejected = rollbackRootMoves({
    memoryRoot,
    storageRoot,
    batchId: "root-move-rollback",
  });

  assert.equal(rejected.ok, false);
  assert.match(rejected.results[0].reason, /approval/);
  assert.equal(fs.existsSync(path.join(memoryRoot, "Claude.md")), false);

  const rolledBack = rollbackRootMoves({
    memoryRoot,
    storageRoot,
    batchId: "root-move-rollback",
    approved: true,
  });

  assert.equal(rolledBack.ok, true);
  assert.equal(rolledBack.wrote, true);
  assert.equal(fs.readFileSync(path.join(memoryRoot, "Claude.md"), "utf8"), "# Claude\nRoot tool note.\n");
  assert.equal(fs.existsSync(path.join(memoryRoot, "wiki", "tools", "Claude.md")), false);
  const rollbackManifest = path.join(storageRoot, "vault-writer", "rollback-manifests", "root-move-rollback.jsonl");
  assert.match(fs.readFileSync(rollbackManifest, "utf8"), /rollback-root-note/);
});
