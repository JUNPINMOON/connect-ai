#!/usr/bin/env node
"use strict";
/**
 * agent-sync-lint.test.js
 * agent-sync-lint.js 회귀 테스트. 픽스처 트리를 임시 생성하고 lint 를 자식 프로세스로 실행,
 * exit code 와 출력(FAIL/CONFLICT/WARN/PASS)을 단언한다.
 *
 * lint 스크립트 경로: env LINT_SCRIPT 우선, 없으면 같은 폴더의 agent-sync-lint.js.
 */
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const LINT = process.env.LINT_SCRIPT || path.join(__dirname, "agent-sync-lint.js");

// --- 픽스처 빌더 ---
function note({ roleKey, status, executor }) {
  return [
    "---",
    "type: agent",
    `status: ${status}`,
    `roleKey: ${roleKey}`,
    "links:",
    '  - "[[00_MOC/Agents]]"',
    "---",
    `# ${roleKey}`,
    "",
    `실체: [[${executor}]] 단독`,
    "",
  ].join("\n");
}
function contract({ id, assignee, workerClass }) {
  return { id, assignee, workerClass };
}
function build(spec) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lint-fix-"));
  const repo = path.join(root, "repo");
  const vault = path.join(root, "vault");
  fs.mkdirSync(path.join(repo, "config"), { recursive: true });
  fs.mkdirSync(path.join(vault, "agent-guides"), { recursive: true });
  fs.mkdirSync(path.join(vault, "00_MOC"), { recursive: true });
  fs.writeFileSync(path.join(repo, "config", "agent-roles.json"), JSON.stringify({ agents: spec.roles }), "utf8");
  fs.writeFileSync(path.join(repo, "config", "agent-contracts.json"), JSON.stringify({ contracts: spec.contracts }), "utf8");
  for (const [file, body] of Object.entries(spec.notes || {})) {
    fs.writeFileSync(path.join(vault, "agent-guides", file), body, "utf8");
  }
  fs.writeFileSync(path.join(vault, "00_MOC", "moc-agents.md"), spec.moc || "", "utf8");
  return { root, repo, vault };
}
function run(spec) {
  const { root, repo, vault } = build(spec);
  try {
    const r = spawnSync(process.execPath, [LINT], {
      env: { ...process.env, REPO_ROOT: repo, VAULT_ROOT: vault },
      encoding: "utf8",
    });
    return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// 세 MIRROR 역할 + orchestrator 가 있는 green 베이스라인.
function greenSpec() {
  return {
    roles: {
      developer: { executor: "codex", status: "active", primaryNotes: ["agent-guides/developer.md"], allowedTools: ["memory_read"] },
      ceo: { executor: "hermes", status: "active", primaryNotes: ["agent-guides/CEO.md"], allowedTools: ["task_enqueue"] },
      verifier: { executor: "gemini", status: "active", primaryNotes: ["agent-guides/verifier.md"], allowedTools: ["memory_read"] },
    },
    contracts: [
      contract({ id: "codex-implementer", assignee: "codex", workerClass: "executor" }),
      contract({ id: "hermes-orchestrator", assignee: "hermes", workerClass: "orchestrator" }),
      contract({ id: "gemini-verifier", assignee: "gemini", workerClass: "reviewer" }),
    ],
    notes: {
      "developer.md": note({ roleKey: "developer", status: "active", executor: "Codex" }),
      "CEO.md": note({ roleKey: "ceo", status: "active", executor: "Hermes" }),
      "verifier.md": note({ roleKey: "verifier", status: "active", executor: "Gemini" }),
    },
    moc: "## Persona Notes\n\n- [[developer]]\n- [[CEO]]\n- [[verifier]]\n",
  };
}

test("green: 3-way 동기화 통과 → exit 0, PASS", () => {
  const r = run(greenSpec());
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /\[PASS\]/);
});

test("dispatch CONFLICT: orchestrator 권한 없는 dispatch 도구 → exit 1", () => {
  const spec = greenSpec();
  // hermes contract 를 observer 로 바꿔 rule 3 은 통과하되 rule 4(orchestrator) 불충족.
  spec.contracts[1] = contract({ id: "hermes-observer", assignee: "hermes", workerClass: "observer" });
  const r = run(spec);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /\[CONFLICT\] ceo:/);
});

test("MIRROR 노트 부재: developer 노트 없음 → exit 1 FAIL", () => {
  const spec = greenSpec();
  delete spec.notes["developer.md"];
  const r = run(spec);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /\[FAIL\] developer:/);
});

test("status 불일치: 노트 optional ≠ roles active → exit 1 FAIL", () => {
  const spec = greenSpec();
  spec.notes["developer.md"] = note({ roleKey: "developer", status: "optional", executor: "Codex" });
  const r = run(spec);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /\[FAIL\] developer:.*status/);
});

test("forbidden/allowed 동시 존재 → exit 1 FAIL", () => {
  const spec = greenSpec();
  spec.roles.developer.forbiddenTools = ["memory_read"];
  const r = run(spec);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /\[FAIL\] developer:/);
});

test("non-MIRROR 노트 부재 → WARN(비차단), exit 0", () => {
  const spec = greenSpec();
  spec.roles.researcher = { executor: "claude", status: "active", primaryNotes: [], allowedTools: ["memory_read"] };
  spec.contracts.push(contract({ id: "claude-implementer", assignee: "claude", workerClass: "executor" }));
  const r = run(spec);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /\[WARN\] researcher:/);
});
