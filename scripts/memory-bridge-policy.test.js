#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const esbuild = require("esbuild");

const repoRoot = path.resolve(__dirname, "..");
const sourcePath = path.join(repoRoot, "src", "our", "memory-bridge.ts");
const repoMemoryPolicyPath = path.join(repoRoot, "config", "memory-policy.json");

function tempRoot(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function buildMemoryBridgeModule() {
  const outDir = tempRoot("connect-ai-memory-bridge-bundle-");
  const outfile = path.join(outDir, "memory-bridge.cjs");
  await esbuild.build({
    entryPoints: [sourcePath],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    logLevel: "silent",
  });
  return require(outfile);
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
}

function writePolicyFixture(extensionRoot, memoryRoot) {
  writeJson(path.join(extensionRoot, "config", "memory-policy.json"), {
    version: 1,
    mutable: false,
    memoryRoot,
    allowedSubdirs: ["", "00_MOC/", "decisions/", "runbooks/", "inbox/", "wiki/", "agent-guides/", "codex-memory/", "youtube/"],
    writeMode: "live",
    liveSubdirs: ["wiki/"],
    observeSubdirs: [],
    redact: true,
  });
  writeJson(path.join(extensionRoot, "config", "tool-execution-policy.json"), {
    version: 1,
    mutable: false,
  });
  writeJson(path.join(extensionRoot, "config", "env-policy.json"), {
    version: 1,
    mutable: false,
  });
  writeJson(path.join(extensionRoot, "config", "vault-write-policy.json"), {
    forbiddenFilenamePatterns: [
      {
        id: "daily-working-log",
        pattern: "(^|/)agent-os-.*\\.md$",
        suggestion: "git commit/PARTIAL report를 사용하세요.",
      },
      {
        id: "date-prefix-note",
        pattern: "(^|/)\\d{4}-\\d{2}-\\d{2}[-_ ].*\\.md$",
        suggestion: "날짜 prefix 대신 stable topic filename을 사용하세요.",
      },
    ],
  });
}

test("source memory bridge writes decisions into KST monthly folders with a lock", () => {
  const source = fs.readFileSync(sourcePath, "utf8");
  assert.match(source, /timeZone:\s*"Asia\/Seoul"/);
  assert.match(source, /const monthPart\s*=\s*datePart\.slice\(0,\s*7\)/);
  assert.doesNotMatch(source, /decisions\/\$\{monthPart\}\/\$\{datePart\}-\$\{slugifyTitle\(meta\.title\)\}\.md/);
  assert.match(source, /decisions\/\$\{monthPart\}\/\$\{slugifyTitle\(meta\.title\)\}\.md/);
  assert.match(source, /withFileLock\(/);
});

test("source memory bridge exposes a durable-note writer for single-writer policy", () => {
  const source = fs.readFileSync(sourcePath, "utf8");
  assert.match(source, /export function createDurableNote\(/);
  assert.match(source, /rejected-writes/);
  assert.match(source, /required_links_missing/);
});

test("memory bridge durable notes include required tags and related frontmatter", async () => {
  const extensionRoot = tempRoot("connect-ai-memory-bridge-ext-");
  const memoryRoot = tempRoot("connect-ai-memory-bridge-vault-");
  const storageRoot = tempRoot("connect-ai-memory-bridge-store-");
  writePolicyFixture(extensionRoot, memoryRoot);
  const bridge = await buildMemoryBridgeModule();

  const result = bridge.createDurableNote(extensionRoot, storageRoot, {
    relPath: "wiki/projects/multi-agent-pyramid.md",
    title: "Multi Agent Pyramid",
    type: "project",
    status: "draft",
    project: "Connect AI",
    owner: "codex",
    source: "test",
    tags: ["agent-os", "routing"],
    related: ["[[00_MOC/AI Agent OS]]", "[[00_MOC/Projects]]"],
    links: ["[[00_MOC/AI Agent OS]]", "[[00_MOC/Projects]]"],
    body: "# Multi Agent Pyramid\n",
  });

  assert.equal(result.ok, true);
  assert.match(result.previewContent, /tags:\n  - "agent-os"\n  - "routing"/);
  assert.match(result.previewContent, /related:\n  - "\[\[00_MOC\/AI Agent OS\]\]"\n  - "\[\[00_MOC\/Projects\]\]"/);
});

test("repo memory policy permits controlled live reference notes for brain-inject", () => {
  const policy = JSON.parse(fs.readFileSync(repoMemoryPolicyPath, "utf8"));
  assert.ok(policy.allowedSubdirs.includes("references/"));
  assert.ok(policy.liveSubdirs.includes("references/"));
});

test("memory bridge rejects agent-os durable notes before writing to the vault", async () => {
  const extensionRoot = tempRoot("connect-ai-memory-bridge-ext-");
  const memoryRoot = tempRoot("connect-ai-memory-bridge-vault-");
  const storageRoot = tempRoot("connect-ai-memory-bridge-store-");
  writePolicyFixture(extensionRoot, memoryRoot);
  const bridge = await buildMemoryBridgeModule();

  const result = bridge.createDurableNote(extensionRoot, storageRoot, {
    relPath: "wiki/projects/agent-os-2026-05-28.md",
    title: "Agent OS Daily Log",
    type: "project",
    status: "draft",
    project: "Connect AI",
    owner: "codex",
    source: "test",
    links: ["[[00_MOC/AI Agent OS]]"],
    body: "# Agent OS Daily Log\n",
  });

  assert.equal(result.ok, false);
  assert.equal(result.wrote, false);
  assert.match(result.reason, /daily-working-log/);
  assert.equal(fs.existsSync(path.join(memoryRoot, "wiki", "projects", "agent-os-2026-05-28.md")), false);
  const rejectionLog = path.join(storageRoot, "rejected-writes", "rejected-writes.jsonl");
  assert.match(fs.readFileSync(rejectionLog, "utf8"), /daily-working-log/);
});

test("memory bridge decision notes use stable filenames without date prefixes", async () => {
  const extensionRoot = tempRoot("connect-ai-memory-bridge-ext-");
  const memoryRoot = tempRoot("connect-ai-memory-bridge-vault-");
  const storageRoot = tempRoot("connect-ai-memory-bridge-store-");
  writePolicyFixture(extensionRoot, memoryRoot);
  const bridge = await buildMemoryBridgeModule();

  const result = bridge.createDecisionNote(
    extensionRoot,
    storageRoot,
    { title: "Queue Contract", dept: "connect-ai", status: "accepted" },
    "- 결정: stable filenames\n"
  );

  assert.equal(result.ok, true);
  assert.equal(result.wrote, false);
  assert.match(result.relPath, /^decisions\/\d{4}-\d{2}\/queue-contract\.md$/);
  assert.doesNotMatch(result.relPath, /\/\d{4}-\d{2}-\d{2}[-_ ]/);
});

test("memory bridge rejects agent-os decision notes before writing to the vault", async () => {
  const extensionRoot = tempRoot("connect-ai-memory-bridge-ext-");
  const memoryRoot = tempRoot("connect-ai-memory-bridge-vault-");
  const storageRoot = tempRoot("connect-ai-memory-bridge-store-");
  writePolicyFixture(extensionRoot, memoryRoot);
  const bridge = await buildMemoryBridgeModule();

  const result = bridge.createDecisionNote(
    extensionRoot,
    storageRoot,
    { title: "agent-os-daily-log", dept: "connect-ai", status: "accepted" },
    "- 결정: should be rejected\n"
  );

  assert.equal(result.ok, false);
  assert.equal(result.wrote, false);
  assert.match(result.reason, /daily-working-log/);
  assert.equal(fs.existsSync(path.join(memoryRoot, "decisions")), false);
  const rejectionLog = path.join(storageRoot, "rejected-writes", "rejected-writes.jsonl");
  assert.match(fs.readFileSync(rejectionLog, "utf8"), /daily-working-log/);
});
