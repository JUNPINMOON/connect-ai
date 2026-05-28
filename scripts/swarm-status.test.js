const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { summarizeSwarmReports, formatHuman, extractSwarmActionItem, actionSummary } = require("./swarm-status.js");

function writeReport(root, name, results) {
  const dir = path.join(root, "reports", "deep-debug-swarm", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "report.json"), JSON.stringify({
    generatedAt: "2026-05-27T15:46:40.000Z",
    agentCount: results.length,
    results,
  }, null, 2), "utf8");
}

test("does not count Gemini fallback as Antigravity direct coverage", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-swarm-status-"));
  const expectedAgents = [
    { id: "gemini-a", provider: "gemini", domain: "transport" },
    { id: "antigravity-a", provider: "antigravity", domain: "transport" },
  ];
  writeReport(root, "20260527T150000Z", [
    { id: "gemini-a", provider: "gemini", domain: "transport", ok: true, source: "gemini" },
  ]);
  writeReport(root, "20260527T151000Z", [
    { id: "antigravity-a", provider: "antigravity", domain: "transport", ok: true, source: "gemini-fallback" },
  ]);

  const summary = summarizeSwarmReports({ repoRoot: root, expectedAgents, nowMs: new Date("2026-05-27T16:00:00.000Z").getTime() });
  assert.equal(summary.coverageOk, false);
  assert.equal(summary.freshnessOk, true);
  assert.equal(summary.coveredCount, 1);
  assert.equal(summary.antigravity.covered, 0);
  assert.equal(summary.antigravity.directSuccesses, 0);
  assert.equal(summary.antigravity.fallbackSuccesses, 1);
  assert.equal(summary.antigravity.directCoverageOk, false);
  assert.deepEqual(summary.missingIds, ["antigravity-a"]);
  assert.deepEqual(summary.successfulLanes.map((lane) => lane.id), ["gemini-a"]);
});

test("counts Antigravity transcript/stdout sources as direct coverage only with review shape evidence", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-swarm-status-"));
  const expectedAgents = [
    { id: "antigravity-a", provider: "antigravity", domain: "transport" },
  ];
  writeReport(root, "20260527T151000Z", [
    { id: "antigravity-a", provider: "antigravity", domain: "transport", ok: true, source: "transcript", reviewShapeOk: true, observedModelLabel: "Gemini 3.5 Flash (Medium)" },
  ]);

  const summary = summarizeSwarmReports({ repoRoot: root, expectedAgents, nowMs: new Date("2026-05-27T16:00:00.000Z").getTime() });
  assert.equal(summary.coverageOk, true);
  assert.equal(summary.antigravity.covered, 1);
  assert.equal(summary.antigravity.directSuccesses, 1);
  assert.equal(summary.antigravity.fallbackSuccesses, 0);
  assert.equal(summary.antigravity.directCoverageOk, true);
  assert.deepEqual(summary.successfulLanes.map((lane) => lane.id), ["antigravity-a"]);
  assert.deepEqual(summary.modelDiversity.observedModels, ["Gemini 3.5 Flash (Medium)"]);
});

test("reports model diversity across successful lanes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-swarm-status-"));
  const expectedAgents = [
    { id: "gemini-a", provider: "gemini", domain: "transport" },
    { id: "gemini-b", provider: "gemini", domain: "queue" },
    { id: "gemini-c", provider: "gemini", domain: "policy" },
    { id: "antigravity-a", provider: "antigravity", domain: "transport" },
  ];
  writeReport(root, "20260527T151000Z", [
    { id: "gemini-a", provider: "gemini", domain: "transport", ok: true, source: "gemini", observedModelLabel: "gemini-2.5-flash" },
    { id: "gemini-b", provider: "gemini", domain: "queue", ok: true, source: "gemini", observedModelLabel: "gemini-2.5-pro" },
    { id: "gemini-c", provider: "gemini", domain: "policy", ok: true, source: "gemini", observedModelLabel: "gemini-3-pro-preview" },
    { id: "antigravity-a", provider: "antigravity", domain: "transport", ok: true, source: "transcript", reviewShapeOk: true, observedModelLabel: "Gemini 3.5 Flash (Medium)" },
  ]);

  const summary = summarizeSwarmReports({ repoRoot: root, expectedAgents, nowMs: new Date("2026-05-27T16:00:00.000Z").getTime() });
  assert.equal(summary.coverageOk, true);
  assert.equal(summary.modelDiversity.observedCount, 4);
  assert.equal(summary.modelDiversity.minimumFourModelTargetMet, true);
  assert.match(formatHuman(summary), /models: 4 observed/);
});

test("does not count old Antigravity direct transcript without review shape evidence", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-swarm-status-"));
  const expectedAgents = [
    { id: "antigravity-a", provider: "antigravity", domain: "transport" },
  ];
  writeReport(root, "20260527T151000Z", [
    { id: "antigravity-a", provider: "antigravity", domain: "transport", ok: true, source: "transcript" },
  ]);

  const summary = summarizeSwarmReports({ repoRoot: root, expectedAgents, nowMs: new Date("2026-05-27T16:00:00.000Z").getTime() });
  assert.equal(summary.coverageOk, false);
  assert.equal(summary.antigravity.covered, 0);
  assert.deepEqual(summary.missingIds, ["antigravity-a"]);
  assert.deepEqual(summary.successfulLanes, []);
});

test("flags stale swarm reports even when coverage is complete", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-swarm-status-"));
  const expectedAgents = [
    { id: "gemini-a", provider: "gemini", domain: "transport" },
  ];
  writeReport(root, "20260527T150000Z", [
    { id: "gemini-a", provider: "gemini", domain: "transport", ok: true, source: "gemini" },
  ]);

  const summary = summarizeSwarmReports({
    repoRoot: root,
    expectedAgents,
    nowMs: new Date("2026-05-29T16:00:00.000Z").getTime(),
    maxAgeHours: 24,
  });
  assert.equal(summary.coverageOk, true);
  assert.equal(summary.freshnessOk, false);
  assert.match(formatHuman(summary), /freshness: stale/);
});

test("reports missing lanes and latest failures without mutating anything", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-swarm-status-"));
  const expectedAgents = [
    { id: "gemini-a", provider: "gemini", domain: "transport" },
    { id: "antigravity-a", provider: "antigravity", domain: "transport" },
  ];
  writeReport(root, "20260527T150000Z", [
    { id: "gemini-a", provider: "gemini", domain: "transport", ok: false, source: "gemini", exitCode: 1 },
  ]);

  const summary = summarizeSwarmReports({ repoRoot: root, expectedAgents });
  assert.equal(summary.coverageOk, false);
  assert.deepEqual(summary.missingIds.sort(), ["antigravity-a", "gemini-a"].sort());
  assert.deepEqual(summary.latestFailures, ["gemini-a"]);
  assert.match(formatHuman(summary), /coverage: 0\/2 incomplete/);
});

test("extracts actionable recommendations and verification commands from reviewer responses", () => {
  const result = {
    id: "gemini-a",
    provider: "gemini",
    domain: "transport",
    source: "gemini",
    response: [
      "### 1. 핵심 판정",
      "점검 필요",
      "### 4. 권장 수정",
      "- run-queue copied 상태를 후보에 포함한다.",
      "- 실패 출력을 blocked 사유에 보존한다.",
      "### 5. 검증 명령",
      "`node scripts/run-queue.js`",
      "`npm run agent:transport-audit`",
      "### 6. 위험/보류",
      "Red 작업은 보류",
    ].join("\n"),
  };

  const item = extractSwarmActionItem(result);
  assert.equal(item.id, "gemini-a");
  assert.match(item.recommendations[0], /copied 상태/);
  assert.match(item.verificationCommands[0], /node scripts\/run-queue\.js/);
});

test("summary carries action items into human and JSON output", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-swarm-status-"));
  const expectedAgents = [
    { id: "gemini-a", provider: "gemini", domain: "transport" },
  ];
  writeReport(root, "20260527T150000Z", [
    {
      id: "gemini-a",
      provider: "gemini",
      domain: "transport",
      ok: true,
      source: "gemini",
      response: [
        "### 4. 권장 수정",
        "- queue runner action bridge를 추가한다.",
        "### 5. 검증 명령",
        "`node scripts/swarm-status.js --json`",
      ].join("\n"),
    },
  ]);

  const summary = summarizeSwarmReports({
    repoRoot: root,
    expectedAgents,
    nowMs: new Date("2026-05-27T16:00:00.000Z").getTime(),
  });
  assert.equal(summary.actionItemCount, 1);
  assert.match(summary.actionItems[0].recommendations[0], /action bridge/);
  assert.match(formatHuman(summary), /top action items:/);
});

test("ignores reviewer template table of contents before real sections", () => {
  const item = extractSwarmActionItem({
    id: "gemini-transport",
    provider: "gemini",
    domain: "transport",
    source: "gemini",
    response: [
      "1. 핵심 판정",
      "2. 발견한 문제",
      "3. 근거",
      "4. 권장 수정",
      "5. 검증 명령",
      "6. 위험/보류",
      "",
      "형식에 맞추어 검토 결과를 작성합니다.",
      "",
      "### 1. 핵심 판정",
      "점검 필요",
      "### 4. 권장 수정",
      "- 디스패처 폴링 로직을 복원한다.",
      "### 5. 검증 명령",
      "- npm run agent:transport-audit",
    ].join("\n"),
  });

  assert.equal(item.recommendations[0], "디스패처 폴링 로직을 복원한다.");
  assert.equal(item.verificationCommands[0], "npm run agent:transport-audit");
});

test("action summary skips heading-only recommendation lines", () => {
  assert.equal(actionSummary({
    recommendations: [
      "**`scripts/agent-os-dashboard.js` 백엔드 수정**:",
      "응답 페이로드에 worker health를 병합한다.",
    ],
    verificationCommands: [],
  }), "응답 페이로드에 worker health를 병합한다.");
});
