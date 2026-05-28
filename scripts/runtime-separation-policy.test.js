#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const extensionSource = fs.readFileSync(path.join(__dirname, "..", "src", "extension.ts"), "utf8");

test("setCompanyDir updates companyDir instead of localBrainPath", () => {
  const match = extensionSource.match(/async function setCompanyDir\(absPath: string\) \{[\s\S]*?\n\}/);
  assert.ok(match, "setCompanyDir function must exist");
  assert.match(match[0], /update\('companyDir',\s*absPath/);
  assert.doesNotMatch(match[0], /update\('localBrainPath',\s*absPath/);
});

test("legacy migration preserves detached companyDir runtime", () => {
  const match = extensionSource.match(/function _migrateCompanyToBrain\(\) \{[\s\S]*?function getCompanyMetrics/);
  assert.ok(match, "_migrateCompanyToBrain function must exist");
  assert.match(match[0], /detached companyDir is intentional runtime state/);
  assert.match(match[0], /return; \/\/ detached companyDir/);
});

test("companyDir default runtime is outside the Obsidian brain", () => {
  const pathsSource = fs.readFileSync(path.join(__dirname, "..", "src", "paths.ts"), "utf8");
  const match = pathsSource.match(/export function getCompanyDir\(\): string \{[\s\S]*?\n\}/);
  assert.ok(match, "getCompanyDir function must exist");
  assert.match(match[0], /connect-ai-runtime/);
  assert.match(match[0], /company/);
  assert.doesNotMatch(match[0], /return path\.join\(_getBrainDir\(\), COMPANY_SUBDIR\)/);
});

test("intentional nested companyDir selection persists explicit path", () => {
  const match = extensionSource.match(/async function runChangeCompanyDir\(\) \{[\s\S]*?\/\/ ============================================================\n\/\/ Knowledge Graph Builder/);
  assert.ok(match, "runChangeCompanyDir block must exist");
  assert.match(match[0], /newDir = path\.join\(brainDir, COMPANY_SUBDIR\)/);
  assert.doesNotMatch(match[0], /cfg\.update\('companyDir',\s*''/);
});

test("conversation logs stay in company runtime without raw brain naming", () => {
  const match = extensionSource.match(/function getConversationsDir\(\): string \{[\s\S]*?\n\}/);
  assert.ok(match, "getConversationsDir function must exist");
  assert.match(match[0], /getCompanyDir\(\)/);
  assert.match(match[0], /'conversations'/);
  assert.doesNotMatch(match[0], /'00_Raw'/);
  assert.doesNotMatch(match[0], /_getBrainDir\(\)/);
});
