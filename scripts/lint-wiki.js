#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const envPaths = require("./env-paths.js");

const defaultWikiRoot = path.join(envPaths.vaultRoot(), "wiki");

function getArg(name, fallback = "") {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return fallback;
  return process.argv[idx + 1] || fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function listMarkdown(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
      .map((entry) => path.join(dir, entry.name));
  } catch {
    return [];
  }
}

function listFiles(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => path.join(dir, entry.name));
  } catch {
    return [];
  }
}

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function parseFrontmatter(content) {
  const match = String(content || "").match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  const fields = {};
  let currentKey = "";
  for (const rawLine of match[1].split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, "");
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (kv) {
      currentKey = kv[1];
      const value = kv[2].trim();
      fields[currentKey] = value || [];
      continue;
    }
    const item = line.match(/^\s*-\s*(.*)$/);
    if (item && currentKey) {
      if (!Array.isArray(fields[currentKey])) fields[currentKey] = fields[currentKey] ? [fields[currentKey]] : [];
      fields[currentKey].push(item[1].replace(/^["']|["']$/g, ""));
    }
  }
  return fields;
}

function rel(root, filePath) {
  return path.relative(root, filePath).replace(/\\/g, "/");
}

function issue(check, severity, file, message) {
  return { check, severity, file: file || "", message };
}

function checkConceptFrontmatter(root) {
  const issues = [];
  const required = ["type", "wiki_role", "explored", "confidence", "maturity", "sources"];
  for (const file of listMarkdown(path.join(root, "concepts"))) {
    const fm = parseFrontmatter(readText(file));
    const fileRel = rel(root, file);
    if (!fm) {
      issues.push(issue("concepts_frontmatter", "error", fileRel, "missing YAML frontmatter"));
      continue;
    }
    for (const key of required) {
      if (fm[key] === undefined || fm[key] === "") {
        issues.push(issue("concepts_frontmatter", "error", fileRel, `missing required frontmatter field: ${key}`));
      }
    }
    if (fm.type !== "ai_wiki") issues.push(issue("concepts_frontmatter", "error", fileRel, "type must be ai_wiki"));
    if (fm.wiki_role !== "concept") issues.push(issue("concepts_frontmatter", "error", fileRel, "wiki_role must be concept"));
  }
  return { ok: issues.length === 0, issues };
}

function extractRawRefs(root) {
  const refs = new Set();
  const sourceFiles = listMarkdown(path.join(root, "sources"));
  const rawRefPattern = /raw[\\/][^"`'\]\s)]+?\.(?:md|json|txt|ya?ml)/gi;
  for (const file of sourceFiles) {
    const text = readText(file);
    const fm = parseFrontmatter(text) || {};
    for (const value of Object.values(fm)) {
      const values = Array.isArray(value) ? value : [value];
      for (const item of values) {
        const match = String(item).match(rawRefPattern);
        if (match) for (const rawRef of match) refs.add(rawRef.replace(/\\/g, "/").replace(/^\.?\//, ""));
      }
    }
    const bodyRefs = text.match(rawRefPattern) || [];
    for (const rawRef of bodyRefs) refs.add(rawRef.replace(/\\/g, "/").replace(/^\.?\//, ""));
  }
  return refs;
}

function checkSourceRawLinks(root) {
  const issues = [];
  const rawFiles = listFiles(path.join(root, "raw")).map((file) => rel(root, file));
  const refs = extractRawRefs(root);
  for (const rawFile of rawFiles) {
    if (!refs.has(rawFile)) {
      issues.push(issue("source_raw_links", "warning", rawFile, `${rawFile} is not referenced by any source summary`));
    }
  }
  for (const ref of refs) {
    if (!fs.existsSync(path.join(root, ref))) {
      issues.push(issue("source_raw_links", "error", ref, "source summary references missing raw file"));
    }
  }
  return { ok: issues.length === 0, issues, referencedRawCount: refs.size, rawFileCount: rawFiles.length };
}

function parseIndexStats(indexText) {
  const totalMatch = indexText.match(/글\s*수:\s*(\d+)\s*\(\s*concept\s*(\d+)\s*,\s*source\s*(\d+)\s*\)/i);
  const rawMatch = indexText.match(/원본\s*\(raw\):\s*(\d+)/i);
  return {
    total: totalMatch ? Number(totalMatch[1]) : null,
    concepts: totalMatch ? Number(totalMatch[2]) : null,
    sources: totalMatch ? Number(totalMatch[3]) : null,
    raw: rawMatch ? Number(rawMatch[1]) : null,
  };
}

function checkIndexStats(root) {
  const issues = [];
  const indexPath = path.join(root, "_index.md");
  const stats = parseIndexStats(readText(indexPath));
  const actual = {
    concepts: listMarkdown(path.join(root, "concepts")).length,
    sources: listMarkdown(path.join(root, "sources")).length,
    raw: listFiles(path.join(root, "raw")).length,
  };
  actual.total = actual.concepts + actual.sources;
  for (const key of ["concepts", "sources", "raw", "total"]) {
    if (stats[key] === null) {
      issues.push(issue("index_stats", "warning", "_index.md", `missing index stat: ${key}`));
    } else if (stats[key] !== actual[key]) {
      issues.push(issue("index_stats", "warning", "_index.md", `stat mismatch for ${key}: index=${stats[key]}, actual=${actual[key]}`));
    }
  }
  return { ok: issues.length === 0, issues, index: stats, actual };
}

function checkEmptyFolderNotes(root) {
  const issues = [];
  const indexText = readText(path.join(root, "_index.md"));
  for (const folder of ["topics", "output"]) {
    const files = listFiles(path.join(root, folder));
    if (files.length === 0) {
      const pattern = new RegExp(`${folder}[\\s\\S]{0,120}(아직 없음|빈|empty|none)`, "i");
      if (!pattern.test(indexText)) {
        issues.push(issue("empty_folder_notes", "warning", "_index.md", `${folder}/ is empty but _index.md does not explicitly say so`));
      }
    }
  }
  return { ok: issues.length === 0, issues };
}

function lint(root) {
  const checks = {
    conceptsFrontmatter: checkConceptFrontmatter(root),
    sourceRawLinks: checkSourceRawLinks(root),
    indexStats: checkIndexStats(root),
    emptyFolderNotes: checkEmptyFolderNotes(root),
  };
  const issues = Object.values(checks).flatMap((check) => check.issues || []);
  return {
    success: true,
    generatedAt: new Date().toISOString(),
    wikiRoot: root,
    summary: {
      totalIssues: issues.length,
      errors: issues.filter((item) => item.severity === "error").length,
      warnings: issues.filter((item) => item.severity === "warning").length,
    },
    checks,
    issues,
  };
}

function printText(result) {
  console.log(`# LLM Wiki lint report`);
  console.log(`- wikiRoot: ${result.wikiRoot}`);
  console.log(`- generatedAt: ${result.generatedAt}`);
  console.log(`- issues: ${result.summary.totalIssues} (${result.summary.errors} errors, ${result.summary.warnings} warnings)`);
  console.log("");
  for (const [name, check] of Object.entries(result.checks)) {
    console.log(`## ${name}: ${check.ok ? "OK" : "ISSUES"}`);
    for (const item of check.issues || []) {
      console.log(`- [${item.severity}] ${item.file}: ${item.message}`);
    }
    if (!check.issues || check.issues.length === 0) console.log("- no issues");
    console.log("");
  }
}

function main() {
  const root = path.resolve(envPaths.toNative(getArg("wiki-root", defaultWikiRoot)));
  const result = lint(root);
  if (hasFlag("json")) console.log(JSON.stringify(result, null, 2));
  else printText(result);
  if (hasFlag("fail-on-issues") && result.summary.totalIssues > 0) process.exit(1);
}

if (require.main === module) main();

module.exports = {
  lint,
  parseFrontmatter,
  parseIndexStats,
  checkConceptFrontmatter,
  checkSourceRawLinks,
  checkIndexStats,
  checkEmptyFolderNotes,
};
