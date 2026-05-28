#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const envPaths = require("./env-paths.js");
const validator = require("./validate-agent-contracts.js");

const repoRoot = envPaths.repoRoot();
const contractsPath = path.join(repoRoot, "config", "agent-contracts.json");
const docsPath = path.join(repoRoot, "docs", "agent-os", "agent-contracts.md");

test("Agent OS contract pack validates", () => {
  const config = JSON.parse(fs.readFileSync(contractsPath, "utf8"));
  const result = validator.validateContracts(config);

  assert.deepEqual(result.errors, []);
  assert.equal(result.success, true);
  assert.equal(result.contractCount, validator.EXPECTED_CONTRACT_IDS.length);
});

test("all expected contracts are documented", () => {
  const docs = fs.readFileSync(docsPath, "utf8");
  for (const id of validator.EXPECTED_CONTRACT_IDS) {
    assert.match(docs, new RegExp(`\\\`${id}\\\``), `${id} should be listed in docs`);
  }
  for (const term of validator.DONE_RULE_TERMS) {
    assert.match(fs.readFileSync(contractsPath, "utf8"), new RegExp(term), `${term} should remain in global DONE rule`);
  }
});

test("non-writer contracts cannot write directly to the vault or approve gates", () => {
  const config = JSON.parse(fs.readFileSync(contractsPath, "utf8"));
  for (const contract of config.contracts) {
    if (contract.id !== "vault-writer") {
      assert.equal(contract.authority.canWriteVaultDirectly, false, `${contract.id} cannot write vault directly`);
    }
    assert.equal(contract.authority.canApproveHumanGates, false, `${contract.id} cannot approve human gates`);
    assert.equal(contract.authority.canCloseDoneWithoutVerifier, false, `${contract.id} cannot close DONE without verifier`);
  }
});
