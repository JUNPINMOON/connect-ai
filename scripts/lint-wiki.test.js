#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const test = require("node:test");

const lintPath = path.join(__dirname, "lint-wiki.js");

function write(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function makeWiki() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-wiki-"));
  for (const dir of ["concepts", "sources", "raw", "topics", "output"]) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  }
  write(path.join(root, "AGENTS.md"), "# AGENTS\n");
  write(path.join(root, "_index.md"), [
    "# Index",
    "## 통계",
    "- 글 수: 2 (concept 1, source 1)",
    "- 원본(raw): 1",
    "## 주제 (topics)",
    "_아직 없음._",
    "## 출력 (output)",
    "_아직 없음._",
  ].join("\n"));
  write(path.join(root, "concepts", "Good.md"), [
    "---",
    "type: ai_wiki",
    "wiki_role: concept",
    "explored: true",
    "confidence: high",
    "maturity: draft",
    "sources:",
    "  - \"raw/example.md\"",
    "---",
    "# Good",
  ].join("\n"));
  write(path.join(root, "raw", "example.md"), "raw");
  write(path.join(root, "sources", "example-source.md"), [
    "---",
    "type: ai_wiki",
    "wiki_role: source_summary",
    "sources:",
    "  - \"raw/example.md\"",
    "---",
    "Raw: `raw/example.md`",
  ].join("\n"));
  return root;
}

function runLint(root, args = []) {
  const output = execFileSync(process.execPath, [lintPath, "--wiki-root", root, "--json", ...args], {
    encoding: "utf8",
  });
  return JSON.parse(output);
}

test("lint-wiki reports a clean minimal wiki", () => {
  const root = makeWiki();
  const result = runLint(root);

  assert.equal(result.success, true);
  assert.equal(result.summary.totalIssues, 0);
  assert.equal(result.checks.conceptsFrontmatter.ok, true);
  assert.equal(result.checks.indexStats.ok, true);
});

test("lint-wiki detects frontmatter and index mismatches", () => {
  const root = makeWiki();
  write(path.join(root, "concepts", "Bad.md"), "# Bad\n");

  const result = runLint(root);

  assert.equal(result.success, true);
  assert.equal(result.checks.conceptsFrontmatter.ok, false);
  assert.equal(result.checks.indexStats.ok, false);
  assert.ok(result.issues.some((issue) => issue.check === "concepts_frontmatter"));
  assert.ok(result.issues.some((issue) => issue.check === "index_stats"));
});

test("lint-wiki detects unreferenced raw files and missing empty-folder notes", () => {
  const root = makeWiki();
  write(path.join(root, "raw", "orphan.json"), "{}");
  write(path.join(root, "_index.md"), [
    "# Index",
    "## 통계",
    "- 글 수: 2 (concept 1, source 1)",
    "- 원본(raw): 2",
  ].join("\n"));

  const result = runLint(root);

  assert.equal(result.checks.sourceRawLinks.ok, false);
  assert.equal(result.checks.emptyFolderNotes.ok, false);
  assert.ok(result.issues.some((issue) => issue.message.includes("orphan.json")));
});
