#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const test = require("node:test");

const fixDecisions = require("./fix-decisions.js");

function tempRoot(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("fix-decisions execute routes existing note changes through vault-writer manifests", () => {
  const vaultRoot = tempRoot("connect-ai-fix-decisions-vault-");
  const storageRoot = tempRoot("connect-ai-fix-decisions-store-");
  const queuePath = path.join(storageRoot, "phase3", "agent-queue.json");
  const decisionPath = path.join(vaultRoot, "decisions", "missing-fields.md");
  fs.mkdirSync(path.dirname(decisionPath), { recursive: true });
  fs.writeFileSync(decisionPath, "# Missing Fields\n\nDecision context body.\n", "utf8");

  const env = {
    ...process.env,
    CONNECT_AI_VAULT: vaultRoot,
    CONNECT_AI_AGENT_QUEUE: queuePath,
  };
  const output = execFileSync(process.execPath, [path.join(__dirname, "fix-decisions.js"), "--execute", "--json"], {
    cwd: path.join(__dirname, ".."),
    env,
    encoding: "utf8",
  });
  const result = JSON.parse(output);

  assert.equal(result.success, true);
  assert.equal(result.changed_count, 1);
  assert.equal(result.candidates[0].write_ok, true);
  assert.match(fs.readFileSync(decisionPath, "utf8"), /- 결정:/);
  assert.match(fs.readFileSync(decisionPath, "utf8"), /- 근거:/);
  assert.equal(fs.existsSync(`${decisionPath}.bak`), false);

  const repairDir = path.join(storageRoot, "vault-writer", "repair-manifests");
  const manifests = fs.readdirSync(repairDir).filter((name) => name.endsWith(".jsonl"));
  assert.ok(manifests.length >= 1);
  const manifestText = fs.readFileSync(path.join(repairDir, manifests[0]), "utf8");
  assert.match(manifestText, /fix-decisions-repair/);
  assert.match(manifestText, /decisions\/missing-fields\.md/);
});

test("fix-decisions source does not directly write repaired decision files", () => {
  const source = fs.readFileSync(path.join(__dirname, "fix-decisions.js"), "utf8");
  assert.match(source, /replaceExistingNoteContent/);
  assert.doesNotMatch(source, /fs\.writeFileSync\(filePath,\s*after/);
  assert.equal(typeof fixDecisions.fixContent, "function");
});
