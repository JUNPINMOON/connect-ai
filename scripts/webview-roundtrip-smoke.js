#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const envPaths = require("./env-paths.js");

const repoRoot = envPaths.repoRoot();

function read(file) {
  return fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
}

function has(source, pattern) {
  return pattern.test(source);
}

function analyzeSources(root = repoRoot) {
  const packagePath = path.join(root, "package.json");
  const sidebarPath = path.join(root, "assets", "webview", "sidebar.html");
  const extensionPath = path.join(root, "src", "extension.ts");
  const pkg = JSON.parse(read(packagePath));
  const sidebar = read(sidebarPath);
  const dashboard = read(path.join(root, "assets", "webview", "dashboard.js"));
  const extension = read(extensionPath);

  const promptCaseStart = extension.indexOf("case 'prompt':");
  const promptCaseEnd = promptCaseStart >= 0 ? extension.indexOf("case 'corpModeToggle':", promptCaseStart) : -1;
  const promptCase = promptCaseStart >= 0 && promptCaseEnd > promptCaseStart
    ? extension.slice(promptCaseStart, promptCaseEnd)
    : (extension.match(/case 'prompt':[\s\S]*?break;\n\s*}/) || [""])[0];
  const handlePrompt = (extension.match(/private async _handlePrompt[\s\S]*?private async _callAgentLLM/) || [""])[0];
  const handleCorporate = (extension.match(/private async _handleCorporatePrompt[\s\S]*?const sessionDir = makeSessionDir/) || [""])[0];

  const checks = [
    {
      id: "view_registered",
      ok: has(JSON.stringify(pkg), /connect-ai-lab-v2-view/),
      detail: "package.json registers the Connect AI webview view id.",
    },
    {
      id: "sidebar_input_present",
      ok: has(sidebar, /<textarea[^>]+id="input"/),
      detail: "sidebar has the main chat textarea.",
    },
    {
      id: "sidebar_prompt_corporate_true",
      ok: has(sidebar, /vscode\.postMessage\(\{type:'prompt',value:text,model:modelSel\.value,internet:internetEnabled,corporate:true\}\)/),
      detail: "normal sidebar sends prompt messages with corporate:true.",
    },
    {
      id: "sidebar_planner_chip",
      ok: has(sidebar, /Planner:\s*Antigravity/) && has(sidebar, /Planner:\s*Gemini fallback/) && has(sidebar, /setPlannerProvider\(msg\.plannerProvider,\s*msg\.plannerHealth\)/),
      detail: "sidebar exposes planner provider state to the user.",
    },
    {
      id: "sidebar_planner_health_visible",
      ok: has(sidebar, /plannerHealth/) && has(sidebar, /SKIPPED_RATE_LIMITED/) && has(sidebar, /fallback/) && has(sidebar, /limited/),
      detail: "sidebar distinguishes Antigravity direct from Gemini fallback/quota-limited planner state.",
    },
    {
      id: "extension_sends_planner_health",
      ok: has(extension, /function readPlannerHealthForUi/) && has(extension, /plannerHealth:\s*readPlannerHealthForUi\(\)/),
      detail: "extension includes planner health in modelsList messages.",
    },
    {
      id: "extension_has_operator_readiness_command",
      ok: has(JSON.stringify(pkg), /connectAiLab\.readiness\.show/) &&
        has(extension, /function buildConnectAiReadinessSummary/) &&
        has(extension, /vscode\.commands\.registerCommand\('connectAiLab\.readiness\.show'/),
      detail: "extension exposes a command-palette readiness summary without requiring terminal log interpretation.",
    },
    {
      id: "statusbar_shows_operator_readiness",
      ok: has(extension, /const readinessStatusBar = vscode\.window\.createStatusBarItem/) &&
        has(extension, /readinessStatusBar\.command = 'connectAiLab\.readiness\.show'/) &&
        has(extension, /Connect AI \$\{summary\.verdict\}/) &&
        has(extension, /setInterval\(refreshReadinessBadge,\s*15000\)/),
      detail: "status bar surfaces Connect AI readiness continuously and links to the readiness command.",
    },
    {
      id: "fast_meta_reply_handles_readiness_questions",
      ok: has(extension, /asksReadiness/) && has(extension, /buildConnectAiReadinessSummary\(\)\.text/),
      detail: "Connect Chat can answer readiness questions through the fast non-mutating meta path.",
    },
    {
      id: "dashboard_marks_rate_limited_agents_blocked",
      ok: has(dashboard, /RATE_LIMIT\|QUOTA/) && has(dashboard, /quota 제한/),
      detail: "dashboard Team Room does not show quota-limited agents as normal ready/idle.",
    },
    {
      id: "extension_prompt_routes_corporate",
      ok: has(promptCase, /const localChat = !!msg\.localChat/) && has(promptCase, /!localChat \|\| msg\.corporate \|\| hasExplicit/) && has(promptCase, /_handleCorporatePrompt\(txt, msg\.model\)/),
      detail: "extension routes ordinary prompt messages through corporate dispatcher unless explicitly localChat.",
    },
    {
      id: "extension_prompt_recognizes_natural_queue_dispatch",
      ok: has(extension, /작업\\s\*\(\?:시켜\|하달\|맡겨\|등록\)/) &&
        has(extension, /\(\?:worker\|워커\)\\s\*\(\?:하달\|등록\|시켜\)/i) &&
        has(extension, /큐\\s\*\(\?:등록\|하달\|넣어\|추가\)/) &&
        has(promptCase, /parseAgentDispatchShortcut\(txt\)/) &&
        has(promptCase, /createAgentDispatchQueueItem\(agentShortcut\)/),
      detail: "extension routes natural Korean worker/queue handoff prefixes into Agent OS queue dispatch before corporate chat.",
    },
    {
      id: "handle_prompt_antigravity_when_local_disabled",
      ok: has(handlePrompt, /!getConfig\(\)\.localLlmEnabled/) && has(handlePrompt, /_callAntigravityCli\(systemText, userText, \{ label: 'sidebar-chat' \}\)/),
      detail: "fallback single-chat path uses Antigravity when local LLM is disabled.",
    },
    {
      id: "antigravity_falls_back_on_failure_text_and_non_json",
      ok: has(extension, /function _looksLikeJsonObjectResponse/) &&
        has(extension, /function _looksLikeCliFailureResponse/) &&
        has(extension, /_looksLikeCliFailureResponse\(response\)[\s\S]*?after Antigravity failure text/) &&
        has(extension, /opts\?\.jsonMode[\s\S]*?_looksLikeJsonObjectResponse\(response\)[\s\S]*?after non-JSON Antigravity response/),
      detail: "Antigravity output falls back to Gemini when direct CLI output is quota/auth/failure prose; JSON planner also falls back on non-JSON.",
    },
    {
      id: "corporate_has_fast_non_mutating_diagnostics",
      ok: has(handleCorporate, /_buildReadOnlyWorkerHandoffDiagnostic\(prompt\)/) && has(handleCorporate, /_buildFastMetaReply\(prompt\)/),
      detail: "corporate dispatcher has fast read-only diagnostic/meta replies before persisted sessions.",
    },
    {
      id: "local_llm_default_false",
      ok: pkg.contributes?.configuration?.properties?.["connectAiLab.localLlmEnabled"]?.default === false,
      detail: "local LLM is disabled by default.",
    },
    {
      id: "planner_default_antigravity",
      ok: pkg.contributes?.configuration?.properties?.["connectAiLab.plannerProvider"]?.default === "antigravity",
      detail: "Antigravity is the default planner provider.",
    },
  ];

  return {
    success: checks.every((check) => check.ok),
    root,
    files: { packagePath, sidebarPath, extensionPath },
    checks,
  };
}

function format(result) {
  const lines = [
    "Connect AI webview roundtrip smoke (static, read-only)",
    `repo: ${result.root}`,
    "",
  ];
  for (const check of result.checks) {
    lines.push(`${check.ok ? "OK" : "FAIL"} ${check.id}: ${check.detail}`);
  }
  return lines.join("\n");
}

function main() {
  const result = analyzeSources();
  if (process.argv.includes("--json")) console.log(JSON.stringify(result, null, 2));
  else console.log(format(result));
  if (!result.success) process.exit(1);
}

if (require.main === module) main();

module.exports = { analyzeSources, format };
