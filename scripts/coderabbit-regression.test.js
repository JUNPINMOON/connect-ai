#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "..");

function read(relPath) {
  return fs.readFileSync(path.join(repoRoot, relPath), "utf8");
}

test("portable scripts do not embed a specific Windows user path", () => {
  const files = [
    "scripts/memory-cli.ts",
    "scripts/youtube-ingest.ts",
    "scripts/gate-check.ts",
    "scripts/memory-cli.js",
    "scripts/youtube-ingest.js",
    "scripts/gate-check.js",
    "scripts/model-router.js",
    "scripts/cost-tracker.js",
    "scripts/agent-mesh.js",
    "scripts/cleanup-content.js",
    "scripts/connect-ai-status.js",
    "scripts/fix-decisions.js",
    "scripts/lilys-cli.js",
    "scripts/lilys-ingest-youtube.js",
    "scripts/lilys-ingest-youtube-fixed.js",
    "scripts/lint-wiki.js",
    "scripts/session-to-wiki.js",
    "scripts/smoke-test.js",
    "scripts/validate-agent-roles.js",
    "scripts/youtube-cube.js",
    "src/our/memory-bridge.ts",
    "src/our/registry-validation.ts",
  ];
  for (const file of files) {
    const source = read(file);
    assert.doesNotMatch(source, /C:\\Users\\mjb58|\/mnt\/c\/Users\/mjb58|\|\|\s*["']mjb58["']/);
  }
});

test("session export routes durable vault writes through vault-writer", () => {
  const source = read("scripts/session-to-wiki.js");
  assert.match(source, /writeDurableNote/);
  assert.doesNotMatch(source, /fs\.writeFileSync\(dest/);
  assert.match(source, /relPath:\s*`references\/session-exports\/\$\{safeAgent\}-session-\$\{shortId\}\.md`/);
  assert.doesNotMatch(source, /wiki\/raw/);
});

test("gate-check stdin reader cannot wait forever on interactive stdin", () => {
  const source = read("scripts/gate-check.ts");
  assert.match(source, /process\.stdin\.isTTY/);
  assert.match(source, /CONNECT_AI_STDIN_TIMEOUT_MS/);
  assert.match(source, /setTimeout/);
});

test("Lilys wrappers redact token values without dropping the key", () => {
  for (const file of ["scripts/lilys-cli.js", "scripts/lilys-ingest-youtube.js", "scripts/lilys-ingest-youtube-fixed.js"]) {
    const source = read(file);
    assert.match(source, /\$1\$2\*\*\*/);
    assert.doesNotMatch(source, /\$1=\*\*\*/);
  }
});

test("legacy YouTube queue helpers keep transient state outside the vault", () => {
  const source = read("scripts/youtube-cube.js");
  assert.match(source, /envPaths\.companyDir\(\)/);
  assert.doesNotMatch(source, /connect-ai-vault/);
});
