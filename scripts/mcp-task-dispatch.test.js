#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const envPaths = require("./env-paths.js");
const dispatchGoal = require("./task-dispatch-goal.js");

const repoRoot = envPaths.repoRoot();

test("task dispatch helper maps one natural-language goal to queue-dispatcher args", () => {
  const target = path.join(envPaths.companyDir(), "mcp-dispatch-smoke", "hello.js");
  const args = dispatchGoal.buildDispatchArgs({
    goal: "이 파일에 hello world 주석 추가",
    executor: "local-llm",
    files: [target],
    writeScope: [],
    expectedTests: ["executor returns READY_FOR_VERIFICATION evidence"],
    rollbackPath: "delete the added comment",
    risk: "Green",
  });

  assert.deepEqual(args.slice(0, 2), ["dispatch", "--goal"]);
  assert.equal(args[2], "이 파일에 hello world 주석 추가");
  assert.ok(args.includes("--executor"));
  assert.ok(args.includes("local-llm"));
  assert.ok(args.includes("--file"));
  assert.ok(args.includes(target));
  assert.ok(args.includes("--write-scope"));
  assert.ok(args.includes("--expected-test"));
  assert.ok(args.includes("--rollback-path"));
  assert.ok(args.includes("delete the added comment"));
});

test("task dispatch helper supports Gemini executor with explicit model", () => {
  const target = path.join(envPaths.companyDir(), "mcp-dispatch-smoke", "gemini.md");
  const args = dispatchGoal.buildDispatchArgs({
    goal: "model-specific Gemini review",
    executor: "gemini",
    geminiModel: "gemini-2.5-pro",
    files: [target],
  });

  assert.ok(args.includes("gemini"));
  assert.equal(args[args.indexOf("--gemini-model") + 1], "gemini-2.5-pro");
});

test("task dispatch helper refuses direct Obsidian vault write scopes", () => {
  const vaultTarget = path.join(envPaths.vaultRoot(), "wiki", "projects", "bad-direct-write.md");

  assert.throws(
    () => dispatchGoal.normalizeRequest({
      goal: "vault에 바로 써",
      executor: "codex",
      files: [vaultTarget],
      writeScope: [vaultTarget],
    }),
    /direct Obsidian vault writes are forbidden/
  );
});

test("MCP server exposes task_dispatch_goal as the Connect AI vertical dispatch surface", () => {
  const source = fs.readFileSync(path.join(repoRoot, "mcp", "server.js"), "utf8");

  assert.match(source, /registerTool\(\s*"task_dispatch_goal"/);
  assert.match(source, /queue-dispatcher\.js|task-dispatch-goal\.js/);
  assert.match(source, /READY_FOR_VERIFICATION/);
  assert.match(source, /local-llm/);
  assert.match(source, /gemini/);
  assert.match(source, /gemini-3-pro-preview/);
  assert.doesNotMatch(source, /gemini-3\.1-pro-preview/);
});

test("agent role matrix exposes task_dispatch_goal only to orchestration and implementation roles", () => {
  const roles = JSON.parse(fs.readFileSync(path.join(repoRoot, "config", "agent-roles.json"), "utf8"));
  const agents = roles.agents;

  for (const id of ["ceo", "secretary", "developer"]) {
    assert.ok(
      agents[id].allowedTools.includes("task_dispatch_goal"),
      `${id} should be able to use the Connect AI vertical dispatch surface`
    );
  }

  for (const id of ["youtube", "instagram", "designer", "business", "editor", "writer", "researcher"]) {
    assert.equal(
      agents[id].allowedTools.includes("task_dispatch_goal"),
      false,
      `${id} should not directly dispatch executor work`
    );
  }
});

test("package exposes a narrow agent:dispatch command for local Connect AI smoke runs", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));

  assert.equal(pkg.scripts["agent:dispatch"], "node scripts/task-dispatch-goal.js");
});

test("MCP queue surfaces expose local-llm and READY_FOR_VERIFICATION", () => {
  const source = fs.readFileSync(path.join(repoRoot, "mcp", "server.js"), "utf8");
  const assigneeEnums = [...source.matchAll(/assignee:\s*z\.enum\(\[([^\]]+)\]\)/g)].map((match) => match[1]);

  assert.ok(assigneeEnums.length >= 3, "expected task enqueue/claim assignee enums");
  for (const enumBody of assigneeEnums) {
    assert.match(enumBody, /"local-llm"/, "local-llm queue workers must be claimable through MCP");
    assert.match(enumBody, /"gemini"/, "gemini queue workers must remain claimable through MCP");
    assert.match(enumBody, /"antigravity"/, "antigravity queue workers must remain claimable through MCP");
  }

  const statusEnums = [...source.matchAll(/status:\s*z\.enum\(\[([^\]]+)\]\)/g)].map((match) => match[1]);
  assert.ok(statusEnums.length >= 2, "expected task list/update status enums");
  for (const enumBody of statusEnums) {
    assert.match(enumBody, /"ready_for_verification"/, "RFV queue items must be listable/updateable through MCP");
  }
});

test("MCP exposes verifier dispatch only to orchestration roles", () => {
  const source = fs.readFileSync(path.join(repoRoot, "mcp", "server.js"), "utf8");
  const roles = JSON.parse(fs.readFileSync(path.join(repoRoot, "config", "agent-roles.json"), "utf8")).agents;

  assert.match(source, /registerTool\(\s*"task_dispatch_verification"/);
  assert.match(source, /verification-dispatch\.js/);
  assert.match(source, /--execute/);
  assert.match(source, /--reviewer/);
  assert.match(source, /READY_FOR_VERIFICATION/);

  for (const id of ["ceo", "secretary"]) {
    assert.ok(
      roles[id].allowedTools.includes("task_dispatch_verification"),
      `${id} should be able to enqueue verifier tasks for RFV queue items`
    );
  }
  for (const id of ["developer", "youtube", "instagram", "designer", "business", "editor", "writer", "researcher"]) {
    assert.equal(
      roles[id].allowedTools.includes("task_dispatch_verification"),
      false,
      `${id} should not directly trigger verifier dispatch`
    );
  }
});

test("MCP exposes verifier apply only to orchestration roles", () => {
  const source = fs.readFileSync(path.join(repoRoot, "mcp", "server.js"), "utf8");
  const roles = JSON.parse(fs.readFileSync(path.join(repoRoot, "config", "agent-roles.json"), "utf8")).agents;

  assert.match(source, /registerTool\(\s*"task_apply_verification"/);
  assert.match(source, /verification-dispatch\.js/);
  assert.match(source, /--apply/);
  assert.match(source, /--execute/);
  assert.match(source, /verifier evidence/i);

  for (const id of ["ceo", "secretary"]) {
    assert.ok(
      roles[id].allowedTools.includes("task_apply_verification"),
      `${id} should be able to apply accepted verifier evidence to RFV queue items`
    );
  }
  for (const id of ["developer", "youtube", "instagram", "designer", "business", "editor", "writer", "researcher"]) {
    assert.equal(
      roles[id].allowedTools.includes("task_apply_verification"),
      false,
      `${id} should not directly close source tasks from verifier evidence`
    );
  }
});
