#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { writeDurableNote } = require("./vault-writer.js");
const sessionToWiki = require("./session-to-wiki.js");

function tempRoot(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("session exports use vault-writer policy metadata and references path", () => {
  const request = sessionToWiki.buildSessionNoteRequest({
    sessionId: "abcdef1234567890",
    agent: "claude",
    redactedCount: 2,
    exportedAt: "2026-05-28",
    content: "# Raw session\n\nhello",
  });

  assert.equal(request.relPath, "references/session-exports/claude-session-abcdef123456.md");
  assert.equal(request.type, "evidence");
  assert.equal(request.status, "draft");
  assert.deepEqual(request.tags, ["session-export", "agent-os", "evidence"]);
  assert.ok(request.related.includes("[[00_MOC/AI Agent OS]]"));
  assert.ok(request.links.includes("[[00_MOC/AI Agent OS]]"));
  assert.doesNotMatch(request.relPath, /^wiki\/raw\//);

  const memoryRoot = tempRoot("connect-ai-session-export-vault-");
  const storageRoot = tempRoot("connect-ai-session-export-store-");
  const dryRun = writeDurableNote({
    ...request,
    memoryRoot,
    storageRoot,
    dryRun: true,
  });

  assert.equal(dryRun.ok, true);
  assert.equal(dryRun.wrote, false);
  assert.match(dryRun.previewContent, /type: evidence/);
  assert.match(dryRun.previewContent, /session-export/);
  assert.equal(fs.existsSync(path.join(memoryRoot, request.relPath)), false);
});
