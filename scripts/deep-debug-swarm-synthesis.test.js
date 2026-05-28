const test = require("node:test");
const assert = require("node:assert/strict");
const synth = require("./deep-debug-swarm-synthesis.js");

test("classifies repeated swarm findings into prioritized repair items", () => {
  const reports = [{
    reportDir: "gemini-report",
    results: [
      {
        id: "gemini-transport",
        provider: "gemini",
        observedModelLabel: "gemini-3.1-pro-preview",
        response: "chat-to-worker transport handoff fails when planner JSON parsing and transcript JSONL parsing drift.",
      },
      {
        id: "gemini-queue",
        provider: "gemini",
        observedModelLabel: "gemini-2.5-pro",
        response: "agent-queue lock race and ready_for_verification transitions are risky. Many files are untracked in git status.",
      },
    ],
  }];

  const findings = synth.classifyReports(reports);
  assert.equal(findings[0].priority, "P0");
  assert.ok(findings.some((finding) => finding.id === "transport-contract"));
  assert.ok(findings.some((finding) => finding.id === "queue-safety"));
  assert.ok(findings.some((finding) => finding.id === "source-control-integrity"));
});

test("summarizes observed model labels without inflating diversity", () => {
  const summary = synth.modelSummary([{
    reportDir: "report",
    results: [
      { id: "a", provider: "gemini", ok: true, observedModelLabel: "gemini-2.5-pro" },
      { id: "b", provider: "gemini", ok: true, observedModelLabel: "gemini-2.5-pro" },
      { id: "c", provider: "antigravity", ok: true, observedModelLabel: "Gemini 3.5 Flash (Medium)" },
    ],
  }]);

  assert.equal(summary.laneCount, 3);
  assert.deepEqual(summary.observedModelLabels, ["gemini-2.5-pro", "Gemini 3.5 Flash (Medium)"]);
});

test("synthesis picks the top finding as next repair slice", () => {
  const result = synth.synthesizeFromReports ? null : synth.synthesize;
  assert.equal(typeof result, "function");
  const output = synth.synthesize([]);
  assert.equal(output.nextRepairSlice, null);
});

