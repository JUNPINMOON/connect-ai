#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const envPaths = require("./env-paths.js");

const repoRoot = envPaths.repoRoot();
const configPath = path.join(repoRoot, "config", "agent-contracts.json");

const ALLOWED_ROLES = new Set(["implementer", "reviewer", "researcher", "verifier", "local-smoke", "orchestrator"]);
const ALLOWED_WORKER_CLASSES = new Set(["executor", "reviewer", "observer", "local-smoke", "single-writer", "ui-smoke", "orchestrator"]);
const ALLOWED_RISK = new Set(["Green", "Yellow", "Red"]);
const REQUIRED_CONTRACT_FIELDS = [
  "id",
  "role",
  "assignee",
  "workerClass",
  "riskClassMax",
  "authority",
  "allowedWriteScopes",
  "forbiddenPaths",
  "inputRequired",
  "outputRequired",
  "evidenceRequired",
  "expectedTests",
  "tokenBudget",
  "retryBudget",
  "stopConditions",
  "humanApprovalRequiredWhen",
  "doneRule",
];
const REQUIRED_AUTHORITY_FIELDS = [
  "canWriteRepo",
  "canWriteRuntimeCompanyDir",
  "canWriteVaultDirectly",
  "canApproveHumanGates",
  "canCloseDoneWithoutVerifier",
];
const EXPECTED_CONTRACT_IDS = [
  "codex-implementer",
  "claude-implementer",
  "gemini-verifier",
  "antigravity-architecture-reviewer",
  "hermes-observer",
  "local-llm-smoke",
  "vault-writer",
  "browser-smoke",
  "coderabbit-review-gate",
  "hermes-orchestrator",
];
const DONE_RULE_TERMS = [
  "filesChanged",
  "commandsRun",
  "testsPassedCurrentRun",
  "unresolvedFailuresRecorded",
  "generatedArtifactsClassified",
  "separateVerifierAccepted",
];

function readJson(file = configPath) {
  return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
}

function isNonEmptyArray(value) {
  return Array.isArray(value) && value.length > 0 && value.every((item) => String(item || "").trim());
}

function validateContracts(config = readJson()) {
  const errors = [];
  if (!config || typeof config !== "object") errors.push("config must be an object");
  if (config.version !== "1.0") errors.push(`expected version 1.0, got ${config.version || "(missing)"}`);
  if (!Array.isArray(config.contracts)) errors.push("contracts must be an array");
  for (const term of DONE_RULE_TERMS) {
    if (!Array.isArray(config.globalDoneRule) || !config.globalDoneRule.includes(term)) {
      errors.push(`globalDoneRule missing ${term}`);
    }
  }
  for (const status of ["READY_FOR_VERIFICATION", "VERIFIED", "PARTIAL", "BLOCKED"]) {
    if (!Array.isArray(config.statusVocabulary) || !config.statusVocabulary.includes(status)) {
      errors.push(`statusVocabulary missing ${status}`);
    }
  }

  const contracts = Array.isArray(config.contracts) ? config.contracts : [];
  const ids = contracts.map((contract) => contract && contract.id).filter(Boolean);
  for (const id of EXPECTED_CONTRACT_IDS) {
    if (!ids.includes(id)) errors.push(`missing contract ${id}`);
  }
  const duplicateIds = ids.filter((id, index) => ids.indexOf(id) !== index);
  for (const id of new Set(duplicateIds)) errors.push(`duplicate contract id ${id}`);

  for (const contract of contracts) {
    if (!contract || typeof contract !== "object") {
      errors.push("contract must be an object");
      continue;
    }
    const label = contract.id || "(missing-id)";
    for (const field of REQUIRED_CONTRACT_FIELDS) {
      if (!(field in contract)) errors.push(`${label}: missing field ${field}`);
    }
    if (!ALLOWED_ROLES.has(contract.role)) errors.push(`${label}: invalid role ${contract.role}`);
    if (!ALLOWED_WORKER_CLASSES.has(contract.workerClass)) errors.push(`${label}: invalid workerClass ${contract.workerClass}`);
    if (!ALLOWED_RISK.has(contract.riskClassMax)) errors.push(`${label}: invalid riskClassMax ${contract.riskClassMax}`);
    if (!contract.assignee || typeof contract.assignee !== "string") errors.push(`${label}: assignee required`);

    const authority = contract.authority || {};
    for (const field of REQUIRED_AUTHORITY_FIELDS) {
      if (typeof authority[field] !== "boolean") errors.push(`${label}: authority.${field} must be boolean`);
    }
    if (authority.canApproveHumanGates) errors.push(`${label}: may not approve human gates`);
    if (authority.canCloseDoneWithoutVerifier) errors.push(`${label}: may not close DONE without verifier`);
    if (authority.canWriteVaultDirectly && contract.id !== "vault-writer") {
      errors.push(`${label}: only vault-writer may write vault directly`);
    }
    if (contract.id === "vault-writer" && !authority.canWriteVaultDirectly) {
      errors.push("vault-writer: must be the explicit direct vault writer");
    }

    for (const field of [
      "allowedWriteScopes",
      "forbiddenPaths",
      "inputRequired",
      "outputRequired",
      "evidenceRequired",
      "expectedTests",
      "stopConditions",
      "humanApprovalRequiredWhen",
    ]) {
      if (!isNonEmptyArray(contract[field])) errors.push(`${label}: ${field} must be a non-empty array`);
    }
    if (!String(contract.doneRule || "").includes("verifier") && contract.id !== "hermes-observer") {
      errors.push(`${label}: doneRule must mention verifier boundary`);
    }
    if (!String(contract.doneRule || "").match(/READY_FOR_VERIFICATION|Review|Writer|Smoke|Observer|verdict|output/i)) {
      errors.push(`${label}: doneRule must define allowed status/output`);
    }
    if (!Number.isInteger(contract.retryBudget) || contract.retryBudget < 0 || contract.retryBudget > 2) {
      errors.push(`${label}: retryBudget must be 0, 1, or 2`);
    }
    const forbiddenText = (contract.forbiddenPaths || []).join("\n");
    if (!forbiddenText.includes("${VAULT_ROOT}")) errors.push(`${label}: forbiddenPaths must mention VAULT_ROOT`);
    if (!forbiddenText.match(/credential|token|broker|live-trade|approval/i)) {
      errors.push(`${label}: forbiddenPaths must mention sensitive or approval boundaries`);
    }
  }

  return {
    success: errors.length === 0,
    errors,
    contractCount: contracts.length,
    expectedContractCount: EXPECTED_CONTRACT_IDS.length,
  };
}

function main() {
  const result = validateContracts(readJson());
  console.log(JSON.stringify(result, null, 2));
  if (!result.success) process.exit(1);
}

if (require.main === module) main();

module.exports = {
  DONE_RULE_TERMS,
  EXPECTED_CONTRACT_IDS,
  validateContracts,
};
