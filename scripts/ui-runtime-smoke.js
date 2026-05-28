#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const envPaths = require("./env-paths.js");

const repoRoot = envPaths.repoRoot();

function read(file) {
  return fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
}

function installWebviewMocks(window) {
  window.acquireVsCodeApi = () => ({ postMessage() {}, getState() { return {}; }, setState() {} });
  window.matchMedia = window.matchMedia || (() => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  window.requestAnimationFrame = window.requestAnimationFrame || (() => 0);
  window.cancelAnimationFrame = window.cancelAnimationFrame || clearTimeout;
  if (window.HTMLCanvasElement) {
    window.HTMLCanvasElement.prototype.getContext = window.HTMLCanvasElement.prototype.getContext || (() => ({
      clearRect() {},
      beginPath() {},
      arc() {},
      fill() {},
    }));
  }
}

function dashboardElementIds(source) {
  const ids = new Set();
  for (const match of source.matchAll(/\$\('([^']+)'\)/g)) ids.add(match[1]);
  ids.add("teamRoomStage");
  ids.add("teamRoomBadge");
  return [...ids].sort();
}

function buildDashboardHarnessHtml(dashboardJs) {
  const nodes = dashboardElementIds(dashboardJs).map((id) => {
    if (id === "bgCanvas") return `<canvas id="${id}"></canvas>`;
    if (id === "teamRoomStage") return `<div id="${id}"></div>`;
    if (id === "teamRoomBadge") return `<span id="${id}"></span>`;
    return `<div id="${id}"></div>`;
  }).join("\n");
  return `<!doctype html><html><body>${nodes}<script>${dashboardJs}</script></body></html>`;
}

function makeDashboardState() {
  return {
    company: "1인 기업",
    briefingTime: "09:00",
    conversationsToday: 0,
    yt: { configured: false },
    tasks: { open: 0, urgent: 0, top: [] },
    approvals: [],
    oauthConnected: false,
    agentTeam: [],
    workerStatus: {
      codex: { status: "idle", taskTitle: "대기 중", message: "" },
      antigravity: { status: "idle", taskTitle: "대기 중", message: "" },
    },
    workerHealth: {
      agents: {
        codex: { status: "READY", detail: "codex-cli 0.125.0" },
        claude: { status: "READY", detail: "Claude Code" },
        gemini: { status: "READY", detail: "Gemini CLI" },
        antigravity: { status: "READY", detail: "Antigravity CLI 1.0.2 direct planner ready" },
        hermes: { status: "READY", detail: "observer only" },
      },
    },
    agentQueue: [],
    agentQueuePath: "C:\\Users\\mjb58\\AppData\\Roaming\\Code\\User\\globalStorage\\connectailab.connect-ai-lab\\phase3\\agent-queue.json",
  };
}

function makeDashboardStateWithBlockedQueue() {
  const state = makeDashboardState();
  state.agentQueue = [
    {
      id: "aq-blocked-test",
      assignee: "codex",
      priority: "P1",
      status: "blocked",
      title: "Green worker handoff probe",
      prompt: "테스트용 Green worker 하달 점검",
      resultSummary: "blocked_by_prompt_constraints=true. worker 실행 금지.",
      blockedReason: {
        code: "prompt_constraints",
        label: "프롬프트 제약",
        severity: "Yellow",
      },
    },
  ];
  return state;
}

function smokeSidebar(root = repoRoot) {
  const sidebarHtml = read(path.join(root, "assets", "webview", "sidebar.html"));
  const dom = new JSDOM(sidebarHtml, {
    runScripts: "dangerously",
    resources: "usable",
    pretendToBeVisual: true,
    beforeParse: installWebviewMocks,
  });
  const { window } = dom;
  window.dispatchEvent(new window.MessageEvent("message", {
    data: {
      type: "modelsList",
      value: ["qwen3.5:4b"],
      plannerProvider: "antigravity",
      plannerHealth: {
        status: "READY",
        directStatus: "READY",
        source: "antigravity",
        detail: "Antigravity CLI direct planner ready",
      },
    },
  }));
  const chip = window.document.getElementById("plannerChip");
  const result = {
    chipText: chip ? chip.textContent : "",
    chipClass: chip ? chip.className : "",
    chipTitle: chip ? chip.title : "",
    ok: Boolean(chip && chip.textContent === "Planner: Antigravity" && !chip.classList.contains("fallback") && !chip.classList.contains("limited")),
  };
  window.close();
  return result;
}

function smokeDashboard(root = repoRoot) {
  const dashboardJs = read(path.join(root, "assets", "webview", "dashboard.js"));
  const dom = new JSDOM(buildDashboardHarnessHtml(dashboardJs), {
    runScripts: "dangerously",
    resources: "usable",
    pretendToBeVisual: true,
    beforeParse: installWebviewMocks,
  });
  const { window } = dom;
  if (typeof window.render !== "function") throw new Error("dashboard render() was not exposed on window");
  window.render(makeDashboardState());
  const stage = window.document.getElementById("teamRoomStage");
  const antigravityCard = stage ? stage.querySelector(".office-person-antigravity") : null;
  const antigravityRail = stage ? stage.querySelector(".room-agent-antigravity") : null;
  const result = {
    stageText: stage ? stage.textContent.replace(/\s+/g, " ").trim() : "",
    antigravityClass: antigravityCard ? antigravityCard.className : "",
    antigravityRailText: antigravityRail ? antigravityRail.textContent.replace(/\s+/g, " ").trim() : "",
    ok: Boolean(
      antigravityCard &&
      !antigravityCard.classList.contains("blocked") &&
      /Antigravity/.test(stage.textContent || "") &&
      /READY/.test(stage.textContent || "")
    ),
  };
  window.close();
  return result;
}

function smokeDashboardBlockedQueue(root = repoRoot) {
  const dashboardJs = read(path.join(root, "assets", "webview", "dashboard.js"));
  const dom = new JSDOM(buildDashboardHarnessHtml(dashboardJs), {
    runScripts: "dangerously",
    resources: "usable",
    pretendToBeVisual: true,
    beforeParse: installWebviewMocks,
  });
  const { window } = dom;
  if (typeof window.render !== "function") throw new Error("dashboard render() was not exposed on window");
  window.render(makeDashboardStateWithBlockedQueue());
  const queueBody = window.document.getElementById("agentQueueBody");
  const text = queueBody ? queueBody.textContent.replace(/\s+/g, " ").trim() : "";
  const result = {
    queueText: text,
    ok: /blocked reason/i.test(text) && /프롬프트 제약/.test(text) && /prompt_constraints/.test(text),
  };
  window.close();
  return result;
}

function analyzeRuntime(root = repoRoot) {
  const sidebar = smokeSidebar(root);
  const dashboard = smokeDashboard(root);
  const blockedQueue = smokeDashboardBlockedQueue(root);
  return {
    success: sidebar.ok && dashboard.ok && blockedQueue.ok,
    root,
    checks: [
      {
        id: "sidebar_runtime_planner_antigravity_direct",
        ok: sidebar.ok,
        detail: `chip="${sidebar.chipText}", class="${sidebar.chipClass}"`,
      },
      {
        id: "dashboard_runtime_antigravity_ready",
        ok: dashboard.ok,
        detail: `cardClass="${dashboard.antigravityClass}", rail="${dashboard.antigravityRailText.slice(0, 180)}"`,
      },
      {
        id: "dashboard_runtime_blocked_reason_visible",
        ok: blockedQueue.ok,
        detail: `queue="${blockedQueue.queueText.slice(0, 180)}"`,
      },
    ],
    sidebar,
    dashboard,
    blockedQueue,
  };
}

function format(result) {
  const lines = [
    "Connect AI UI runtime smoke (jsdom, read-only)",
    `repo: ${result.root}`,
    "",
  ];
  for (const check of result.checks) {
    lines.push(`${check.ok ? "OK" : "FAIL"} ${check.id}: ${check.detail}`);
  }
  return lines.join("\n");
}

function main() {
  const result = analyzeRuntime();
  if (process.argv.includes("--json")) console.log(JSON.stringify(result, null, 2));
  else console.log(format(result));
  if (!result.success) process.exit(1);
}

if (require.main === module) main();

module.exports = {
  analyzeRuntime,
  buildDashboardHarnessHtml,
  dashboardElementIds,
  makeDashboardState,
  makeDashboardStateWithBlockedQueue,
  smokeDashboard,
  smokeDashboardBlockedQueue,
  smokeSidebar,
};
