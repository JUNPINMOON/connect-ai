#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function loadModelRouter() {
  const modulePath = require.resolve("./model-router.js");
  delete require.cache[modulePath];
  return require(modulePath);
}

test("model router policy updates persist under runtime company dir, not the Obsidian vault", () => {
  const runtimeRoot = tempDir("connect-ai-model-router-runtime-");
  const vaultRoot = tempDir("connect-ai-model-router-vault-");
  const previousCompanyDir = process.env.CONNECT_AI_COMPANY_DIR;
  const previousVault = process.env.CONNECT_AI_VAULT;
  process.env.CONNECT_AI_COMPANY_DIR = runtimeRoot;
  process.env.CONNECT_AI_VAULT = vaultRoot;

  try {
    const ModelRouter = loadModelRouter();
    const router = new ModelRouter();
    router.updatePolicy({});

    const expectedPolicyPath = path.join(runtimeRoot, "model-router", "model-policy.md");
    assert.equal(router.policyPath, expectedPolicyPath);
    assert.equal(fs.existsSync(expectedPolicyPath), true);
    assert.equal(fs.existsSync(path.join(vaultRoot, "model-policy.md")), false);

    const source = fs.readFileSync(path.join(__dirname, "model-router.js"), "utf8");
    assert.doesNotMatch(source, /connect-ai-vault/);
    assert.doesNotMatch(source, /defaultVaultPath/);
  } finally {
    if (previousCompanyDir === undefined) delete process.env.CONNECT_AI_COMPANY_DIR;
    else process.env.CONNECT_AI_COMPANY_DIR = previousCompanyDir;
    if (previousVault === undefined) delete process.env.CONNECT_AI_VAULT;
    else process.env.CONNECT_AI_VAULT = previousVault;
  }
});
