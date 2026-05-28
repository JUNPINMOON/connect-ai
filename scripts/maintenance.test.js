#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const test = require("node:test");

const maintenanceCli = path.join(__dirname, "maintenance.js");

function makeRuntimeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-maintenance-"));
  const phase3 = path.join(root, "phase3");
  const phase2 = path.join(root, "phase2");
  fs.mkdirSync(phase3, { recursive: true });
  fs.mkdirSync(phase2, { recursive: true });
  const oldLog = path.join(phase2, "old-agent-output.log");
  fs.writeFileSync(oldLog, "old runtime log\n", "utf8");
  const old = new Date(Date.now() - 10 * 86400000);
  fs.utimesSync(oldLog, old, old);
  return {
    root,
    oldLog,
    env: {
      ...process.env,
      CONNECT_AI_AGENT_QUEUE: path.join(phase3, "agent-queue.json"),
      CONNECT_AI_COMPANY_DIR: path.join(root, "company"),
    },
  };
}

function runMaintenance(args, env) {
  const output = execFileSync(process.execPath, [maintenanceCli, ...args], {
    cwd: path.resolve(__dirname, ".."),
    env,
    encoding: "utf8",
    maxBuffer: 5 * 1024 * 1024,
  });
  return JSON.parse(output);
}

function runMaintenanceRaw(args, env) {
  const result = spawnSync(process.execPath, [maintenanceCli, ...args], {
    cwd: path.resolve(__dirname, ".."),
    env,
    encoding: "utf8",
    maxBuffer: 5 * 1024 * 1024,
    windowsHide: true,
  });
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout || "",
    parsed: result.stdout ? JSON.parse(result.stdout) : null,
  };
}

test("maintenance defaults to report-only and does not delete stale runtime files", () => {
  const fixture = makeRuntimeFixture();

  const result = runMaintenance(["--days", "7"], fixture.env);

  assert.equal(result.dryRun, true);
  assert.equal(result.execute, false);
  assert.equal(result.deleteCandidates, 1);
  assert.equal(result.deleted, 0);
  assert.equal(fs.existsSync(fixture.oldLog), true);
});

test("maintenance execute without human approval stays report-only", () => {
  const fixture = makeRuntimeFixture();

  const result = runMaintenanceRaw(["--days", "7", "--execute"], fixture.env);

  assert.equal(result.exitCode, 2);
  assert.equal(result.parsed.dryRun, true);
  assert.equal(result.parsed.execute, false);
  assert.equal(result.parsed.executeRequested, true);
  assert.equal(result.parsed.humanApproved, false);
  assert.equal(result.parsed.blockedReason, "HUMAN_APPROVAL_REQUIRED_FOR_DESTRUCTIVE_CLEANUP");
  assert.equal(result.parsed.deleteCandidates, 1);
  assert.equal(result.parsed.deleted, 0);
  assert.equal(fs.existsSync(fixture.oldLog), true);
});

test("maintenance deletes stale runtime files only with explicit approval", () => {
  const fixture = makeRuntimeFixture();

  const result = runMaintenance(["--days", "7", "--execute", "--human-approved"], fixture.env);

  assert.equal(result.dryRun, false);
  assert.equal(result.execute, true);
  assert.equal(result.humanApproved, true);
  assert.equal(result.deleteCandidates, 1);
  assert.equal(result.deleted, 1);
  assert.equal(fs.existsSync(fixture.oldLog), false);
});

test("nightly maintenance invokes maintenance in read-only dry-run mode", () => {
  const script = fs.readFileSync(path.join(__dirname, "nightly-maintenance.ps1"), "utf8");

  assert.match(script, /maintenance\.js" --days 7 --dry-run/);
  assert.doesNotMatch(script, /maintenance\.js" --days 7(?! --dry-run)/);
});
