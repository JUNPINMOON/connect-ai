#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const HermesIntegration = require("../src/hermes-integration.js");

test("Hermes integration uses central Green/Yellow/Red risk policy", () => {
  const hermes = new HermesIntegration();
  assert.equal(hermes.classifyRiskClass("Read-only review of queue state"), "Green");
  assert.equal(hermes.classifyRiskClass("Implement a bounded local script change"), "Yellow");
  assert.equal(hermes.classifyRiskClass("Approve harness baseline and broker order path"), "Red");
  assert.equal(hermes.classifyAction("Approve harness baseline"), "sensitive");
});

test("Hermes refuses Red-risk execution before routing", async () => {
  const hermes = new HermesIntegration();
  await assert.rejects(
    () => hermes.executeWithRouting("Approve protected_paths and broker order changes"),
    /Red-risk/
  );
});

test("Hermes delegate routing cannot bypass the guarded queue", async () => {
  const hermes = new HermesIntegration();
  let directHermesCalled = false;
  hermes.executeHermes = async () => {
    directHermesCalled = true;
    return { provider: "openrouter", model: "codex" };
  };

  await assert.rejects(
    () => hermes.executeWithRouting("Implement a bounded local script change"),
    (error) => {
      assert.equal(error.code, "QUEUE_DISPATCH_REQUIRED");
      assert.match(error.message, /task_dispatch_goal/);
      assert.equal(directHermesCalled, false);
      return true;
    }
  );
});

test("Hermes Bedrock reviewer routing cannot bypass the guarded queue", async () => {
  const hermes = new HermesIntegration();
  let bedrockCalled = false;
  hermes.executeBedrock = async () => {
    bedrockCalled = true;
    return { provider: "bedrock", model: "claude-sonnet-4" };
  };

  await assert.rejects(
    () => hermes.executeWithRouting("Design a reviewer architecture critique", "design", "low"),
    (error) => {
      assert.equal(error.code, "QUEUE_DISPATCH_REQUIRED");
      assert.match(error.message, /task_dispatch_goal/);
      assert.equal(error.details.executor, "antigravity");
      assert.equal(error.details.requestedProvider, "bedrock");
      assert.equal(error.details.requestedModel, "claude-sonnet-4");
      assert.equal(bedrockCalled, false);
      return true;
    }
  );
});

test("Hermes OpenRouter analysis routing cannot bypass the guarded queue", async () => {
  const hermes = new HermesIntegration();
  let openRouterCalled = false;
  hermes.executeHermes = async () => {
    openRouterCalled = true;
    return { provider: "openrouter", model: "z-ai/glm-4.6" };
  };

  await assert.rejects(
    () => hermes.executeWithRouting("Analyze queue health and summarize risks", "analyze", "low"),
    (error) => {
      assert.equal(error.code, "QUEUE_DISPATCH_REQUIRED");
      assert.match(error.message, /task_dispatch_goal/);
      assert.equal(error.details.executor, "antigravity");
      assert.equal(error.details.requestedProvider, "openrouter");
      assert.equal(error.details.requestedModel, "z-ai/glm-4.6");
      assert.equal(openRouterCalled, false);
      return true;
    }
  );
});

test("Hermes local routing cannot bypass the local LLM queue worker", async () => {
  const hermes = new HermesIntegration();
  hermes.router = {
    selectModel: () => ({ provider: "local", model: "local", reasoning: "forced local smoke" }),
    logDecision: () => {},
  };
  let localCalled = false;
  hermes.executeLocal = async () => {
    localCalled = true;
    return { provider: "local", model: "local" };
  };

  await assert.rejects(
    () => hermes.executeWithRouting("Classify this harmless sentence", "classify", "low"),
    (error) => {
      assert.equal(error.code, "QUEUE_DISPATCH_REQUIRED");
      assert.match(error.message, /task_dispatch_goal/);
      assert.equal(error.details.executor, "local-llm");
      assert.equal(error.details.requestedProvider, "local");
      assert.equal(error.details.requestedModel, "local");
      assert.equal(localCalled, false);
      return true;
    }
  );
});
