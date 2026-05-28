const test = require("node:test");
const assert = require("node:assert/strict");
const swarm = require("./deep-debug-swarm.js");

test("defines at least six Gemini and six Antigravity reviewer lanes", () => {
  const gemini = swarm.AGENTS.filter((agent) => agent.provider === "gemini");
  const antigravity = swarm.AGENTS.filter((agent) => agent.provider === "antigravity");
  assert.ok(gemini.length >= 6);
  assert.ok(antigravity.length >= 6);
});

test("deep debug prompt is read-only and evidence-oriented", () => {
  const prompt = swarm.buildPrompt(swarm.AGENTS[0], "context evidence");
  assert.match(prompt, /read-only/i);
  assert.match(prompt, /Do not edit/);
  assert.match(prompt, /Do not call tools/);
  assert.match(prompt, /Model intent:/);
  assert.match(prompt, /Persona:/);
  assert.match(prompt, /근거/);
  assert.match(prompt, /검증 명령/);
});

test("can select a single lane by agent id", () => {
  const originalArgv = process.argv;
  process.argv = ["node", "deep-debug-swarm.js", "--agent-id", "antigravity-transport"];
  try {
    const agents = swarm.selectAgents();
    assert.equal(agents.length, 1);
    assert.equal(agents[0].id, "antigravity-transport");
  } finally {
    process.argv = originalArgv;
  }
});

test("can force all Gemini lanes to flash-only while preserving six personas", () => {
  const agents = swarm.applyGeminiModelPolicy(
    swarm.AGENTS.filter((agent) => agent.provider === "gemini"),
    "flash-only",
  );
  assert.equal(agents.length, 6);
  assert.ok(agents.every((agent) => agent.provider === "gemini"));
  assert.ok(agents.every((agent) => agent.modelId === "gemini-2.5-flash"));
  assert.equal(new Set(agents.map((agent) => agent.persona)).size, 6);
});

test("exposes lane audit with model and persona axes", () => {
  const audit = swarm.laneAudit();
  assert.equal(audit.length, swarm.AGENTS.length);
  assert.ok(audit.every((lane) => lane.id && lane.provider && lane.modelIntent && lane.persona));
  assert.ok(audit.some((lane) => lane.modelEnforcement === "observed-global-selected-model-from-cli-log"));
  assert.ok(audit.filter((lane) => lane.provider === "antigravity").every((lane) => lane.modelControl === "global-selected-model-only"));
  assert.ok(audit.filter((lane) => lane.provider === "gemini").every((lane) => lane.modelId));
});

test("Gemini lanes use only stable explicit Gemini CLI models", () => {
  const gemini = swarm.AGENTS.filter((agent) => agent.provider === "gemini");
  const geminiModels = new Set(gemini.map((agent) => agent.modelId).filter(Boolean));
  assert.ok(geminiModels.has("gemini-2.5-flash"));
  assert.ok(geminiModels.has("gemini-2.5-pro"));
  assert.deepEqual(geminiModels, new Set(["gemini-2.5-flash", "gemini-2.5-pro"]));
  for (const modelId of geminiModels) {
    assert.equal(gemini.filter((agent) => agent.modelId === modelId).length, 3);
  }
});

test("synthesizes requested and observed model fields plus mismatch failures", () => {
  const report = swarm.synthesize([
    {
      id: "gemini-a",
      provider: "gemini",
      ok: false,
      source: "gemini",
      exitCode: 0,
      ms: 1,
      requestedModel: "gemini-2.5-pro",
      observedModel: "gemini-2.5-flash",
      requestedModelLabel: "gemini-2.5-pro",
      observedModelLabel: "gemini-2.5-flash",
      modelSelectionEnforced: false,
      unresolvedFailures: ["MODEL_MISMATCH"],
      response: "review body",
    },
  ]);
  assert.match(report, /requestedModel: gemini-2\.5-pro/);
  assert.match(report, /observedModel: gemini-2\.5-flash/);
  assert.match(report, /unresolvedFailures: MODEL_MISMATCH/);
});

test("source classifies Gemini quota failures before empty response fallout", () => {
  const source = require("node:fs").readFileSync(require("node:path").join(__dirname, "deep-debug-swarm.js"), "utf8");
  assert.match(source, /classifyGeminiCliFailure/);
  assert.match(source, /unresolvedFailures\.push\(cliFailure\)/);
});

test("does not route default Gemini lanes through unstable Gemini 3 preview aliases", () => {
  const source = require("node:fs").readFileSync(require("node:path").join(__dirname, "deep-debug-swarm.js"), "utf8");
  assert.doesNotMatch(source, /modelId:\s*"gemini-3-pro-preview"/);
  assert.match(source, /isObservedModelAllowedForRequest/);
});

test("synthesizes a report with provider counts", () => {
  const report = swarm.synthesize([
    { id: "gemini-a", provider: "gemini", ok: true, source: "gemini", exitCode: 0, ms: 1, response: "ok" },
    { id: "antigravity-a", provider: "antigravity", ok: true, source: "transcript", exitCode: 0, ms: 1, modelControl: "global-selected-model-only", response: "ok" },
  ]);
  assert.match(report, /1 Gemini, 1 Antigravity/);
  assert.match(report, /globally selected observed model/);
  assert.match(report, /modelControl: global-selected-model-only/);
  assert.match(report, /gemini-a/);
  assert.match(report, /antigravity-a/);
});

test("requires Antigravity review headings for verdict, issues, and verification", () => {
  const source = require("node:fs").readFileSync(require("node:path").join(__dirname, "deep-debug-swarm.js"), "utf8");
  assert.match(source, /핵심\\s\*판정/);
  assert.match(source, /발견한\\s\*문제/);
  assert.match(source, /검증\\s\*명령/);
});

test("keeps the Antigravity lane configurable for short print timeout and fallback retries", () => {
  assert.match(require("node:fs").readFileSync(require("node:path").join(__dirname, "deep-debug-swarm.js"), "utf8"), /antigravity-print-timeout/);
  assert.match(require("node:fs").readFileSync(require("node:path").join(__dirname, "deep-debug-swarm.js"), "utf8"), /fallbackAttempts/);
  assert.match(require("node:fs").readFileSync(require("node:path").join(__dirname, "deep-debug-swarm.js"), "utf8"), /context-lite/);
});

test("can build a direct-only Antigravity reviewer invocation", () => {
  const args = swarm.buildAntigravityReviewerArgs({
    promptFile: "prompt.txt",
    printTimeout: "45s",
    timeoutMs: 180000,
    fallbackTimeoutMs: 180000,
    fallbackAttempts: 2,
    directOnly: true,
    forceAgy: true,
    modelLabel: "Claude Opus 4.6 (Thinking)",
  });
  assert.ok(args.includes("--no-fallback"));
  assert.ok(args.includes("--force-agy"));
  assert.equal(args[args.indexOf("--model-label") + 1], "Claude Opus 4.6 (Thinking)");
  assert.equal(args[0].endsWith("antigravity-reviewer.js"), true);
});
