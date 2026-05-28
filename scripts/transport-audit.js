#!/usr/bin/env node
"use strict";

// Read-only audit for the Connect AI command transport path.
// It checks the handoff chain without registering queue items or running workers.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const envPaths = require("./env-paths.js");
const { analyzeSources: analyzeWebviewRoundtrip } = require("./webview-roundtrip-smoke.js");
const { analyzeRuntime: analyzeUiRuntime } = require("./ui-runtime-smoke.js");
const { runPlannerSmoke } = require("./planner-cli-smoke.js");
const { summarizeSwarmReports, actionSummary } = require("./swarm-status.js");
const { summarize: summarizeBlockedQueue } = require("./blocked-triage.js");
const { planRetries, readEvents, readHealth } = require("./blocked-retry-planner.js");
const { plannedDispatches } = require("./verification-dispatch.js");

const repoRoot = envPaths.repoRoot();
const queueFile = envPaths.agentQueuePath();

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    return fallback;
  }
}

function readJsonc(file, fallback) {
  try {
    const raw = fs.readFileSync(file, "utf8");
    const withoutBlockComments = raw.replace(/\/\*[\s\S]*?\*\//g, "");
    const withoutLineComments = withoutBlockComments.replace(/(^|[^:])\/\/.*$/gm, "$1");
    return JSON.parse(withoutLineComments);
  } catch {
    return fallback;
  }
}

function statSummary(file) {
  try {
    const stat = fs.statSync(file);
    return { exists: true, size: stat.size, mtime: stat.mtime.toISOString() };
  } catch {
    return { exists: false };
  }
}

function sha256(file) {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  } catch {
    return "";
  }
}

function runReadOnly(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, {
    cwd: options.cwd || repoRoot,
    env: options.env || process.env,
    encoding: "utf8",
    windowsHide: true,
    shell: Boolean(options.shell),
    timeout: options.timeoutMs || 15000,
    maxBuffer: 10 * 1024 * 1024,
  });
  return {
    exitCode: result.status ?? 1,
    stdout: String(result.stdout || "").trim(),
    stderr: String(result.stderr || result.error?.message || "").trim(),
    timedOut: result.error && result.error.code === "ETIMEDOUT",
  };
}

function findExtensionInstalls() {
  const roots = [
    process.env.USERPROFILE ? path.join(process.env.USERPROFILE, ".vscode", "extensions") : "",
    process.env.USERPROFILE ? path.join(process.env.USERPROFILE, ".cursor", "extensions") : "",
  ].filter(Boolean);
  const candidates = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory() && /^connectailab\.connect-ai-lab-/i.test(entry.name)) {
        candidates.push(path.join(root, entry.name));
      }
    }
  }
  return candidates.map((dir) => ({
    dir,
    packageJson: path.join(dir, "package.json"),
    bundle: path.join(dir, "out", "extension.js"),
  }));
}

function queueSummary() {
  const items = readJson(queueFile, []);
  const array = Array.isArray(items) ? items : [];
  const counts = {};
  for (const item of array) counts[item.status || "unknown"] = (counts[item.status || "unknown"] || 0) + 1;
  return {
    path: queueFile,
    file: statSummary(queueFile),
    count: array.length,
    counts,
    activeSample: array
      .filter((item) => ["queued", "copied", "running", "blocked"].includes(item.status))
      .slice(0, 8)
      .map((item) => ({
        id: item.id,
        status: item.status,
        assignee: item.assignee,
        priority: item.priority,
        title: item.title,
      })),
  };
}

function blockedTriageSummary(queueItems) {
  try {
    const report = summarizeBlockedQueue(queueItems || []);
    return {
      success: true,
      totalBlocked: report.totalBlocked,
      buckets: report.buckets,
      recommendations: report.recommendations,
      candidateCounts: report.candidateCounts,
    };
  } catch (error) {
    return {
      success: false,
      totalBlocked: 0,
      buckets: {},
      recommendations: {},
      candidateCounts: {
        verifiedArchiveCandidates: 0,
        retryCandidates: 0,
        userDecisionRequired: 0,
        evidenceOnly: 0,
      },
      error: String(error && error.message || error).slice(0, 500),
    };
  }
}

function blockedRetryPlanSummary(queueItems) {
  try {
    const report = planRetries(queueItems || [], readHealth(), { events: readEvents() });
    return {
      success: true,
      plannedCount: report.plans.length,
      backlogCount: report.backlog.length,
      backlogCutoffHours: report.backlogCutoffHours,
      skippedCount: report.skipped.length,
      plans: report.plans.slice(0, 10),
      backlog: report.backlog.slice(0, 10),
    };
  } catch (error) {
    return {
      success: false,
      plannedCount: 0,
      backlogCount: 0,
      backlogCutoffHours: 6,
      skippedCount: 0,
      plans: [],
      backlog: [],
      error: String(error && error.message || error).slice(0, 500),
    };
  }
}

function verificationDispatchSummary(queueItems) {
  const queue = Array.isArray(queueItems) ? queueItems : [];
  const readyForVerificationCount = queue.filter((item) => item.status === "ready_for_verification").length;
  const activeVerifierCount = queue.filter((item) => (
    item
    && item.intent === "verification"
    && item.role === "verifier"
    && ["queued", "copied", "running", "ready_for_verification"].includes(item.status)
  )).length;
  try {
    return {
      success: true,
      readyForVerificationCount,
      plannedCount: plannedDispatches(queue).length,
      activeVerifierCount,
    };
  } catch (error) {
    return {
      success: false,
      readyForVerificationCount,
      plannedCount: 0,
      activeVerifierCount,
      error: String(error && error.message || error).slice(0, 500),
    };
  }
}

function lockSummary() {
  const lock = `${queueFile}.lock`;
  const meta = readJson(lock, null);
  let ageMs = null;
  if (meta && meta.ts) {
    const ts = new Date(meta.ts).getTime();
    if (Number.isFinite(ts)) ageMs = Date.now() - ts;
  }
  return { path: lock, file: statSummary(lock), meta, ageMs };
}

function workerFilesSummary() {
  const dir = path.dirname(queueFile);
  const statusPath = path.join(dir, "worker-status.json");
  const healthPath = path.join(dir, "worker-health.json");
  const status = readJson(statusPath, {});
  const health = readJson(healthPath, {});
  return {
    statusPath,
    healthPath,
    statusFile: statSummary(statusPath),
    healthFile: statSummary(healthPath),
    status,
    healthGeneratedAt: health.generatedAt || "",
    healthAgents: health.agents || {},
  };
}

function packageSummary() {
  const pkgPath = path.join(repoRoot, "package.json");
  const pkg = readJson(pkgPath, {});
  const properties = pkg.contributes?.configuration?.properties || {};
  return {
    path: pkgPath,
    version: pkg.version || "",
    scripts: {
      agentRun: pkg.scripts?.["agent:run"] || "",
      agentRunParallel: pkg.scripts?.["agent:run:parallel"] || "",
      agentHealth: pkg.scripts?.["agent:health"] || "",
      transportAudit: pkg.scripts?.["agent:transport-audit"] || "",
    },
    plannerProviderDefault: properties["connectAiLab.plannerProvider"]?.default,
    localLlmEnabledDefault: properties["connectAiLab.localLlmEnabled"]?.default,
  };
}

function userSettingsSummary() {
  const candidates = [
    process.env.APPDATA ? { app: "vscode", path: path.join(process.env.APPDATA, "Code", "User", "settings.json") } : null,
    process.env.APPDATA ? { app: "cursor", path: path.join(process.env.APPDATA, "Cursor", "User", "settings.json") } : null,
  ].filter(Boolean);
  return candidates.map((candidate) => {
    const settings = readJsonc(candidate.path, {});
    const connectAi = {};
    for (const [key, value] of Object.entries(settings || {})) {
      if (key.startsWith("connectAiLab.")) connectAi[key] = value;
    }
    return {
      app: candidate.app,
      path: candidate.path,
      file: statSummary(candidate.path),
      connectAi,
      plannerProvider: connectAi["connectAiLab.plannerProvider"],
      localLlmEnabled: connectAi["connectAiLab.localLlmEnabled"],
      defaultModel: connectAi["connectAiLab.defaultModel"],
      companyDir: connectAi["connectAiLab.companyDir"],
      localBrainPath: connectAi["connectAiLab.localBrainPath"],
    };
  });
}

function sourcePolicySummary() {
  const extensionPath = path.join(repoRoot, "src", "extension.ts");
  let source = "";
  try {
    source = fs.readFileSync(extensionPath, "utf8");
  } catch {
    return { extensionPath, readable: false, classifierLocalLlmGuarded: false };
  }
  const classifierMatch = source.match(/async function classifyToAgent[\s\S]*?\n}\n/);
  const classifierSource = classifierMatch ? classifierMatch[0] : "";
  const localGuardIndex = classifierSource.indexOf("!getConfig().localLlmEnabled");
  const quickCallIndex = classifierSource.indexOf("_quickLLMCall");
  return {
    extensionPath,
    readable: true,
    classifierLocalLlmGuarded: Boolean(localGuardIndex !== -1 && quickCallIndex !== -1 && localGuardIndex < quickCallIndex),
  };
}

function bundleSummary() {
  const sourceBundle = path.join(repoRoot, "out", "extension.js");
  const sourceHash = sha256(sourceBundle);
  return {
    sourceBundle,
    sourceFile: statSummary(sourceBundle),
    installs: findExtensionInstalls().map((install) => {
      const hash = sha256(install.bundle);
      return {
        dir: install.dir,
        bundle: install.bundle,
        packageJson: install.packageJson,
        bundleFile: statSummary(install.bundle),
        packageFile: statSummary(install.packageJson),
        matchesSourceBundle: Boolean(sourceHash && hash && sourceHash === hash),
      };
    }),
  };
}

function dryRunSummary() {
  const result = runReadOnly(process.execPath, [path.join(repoRoot, "scripts", "run-queue.js")], { timeoutMs: 20000 });
  let parsed = null;
  try { parsed = JSON.parse(result.stdout); } catch { /* keep raw */ }
  return {
    command: "node scripts/run-queue.js",
    mutatesQueue: false,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    parsed,
    stderr: result.stderr.slice(0, 1000),
  };
}

function webviewRoundtripSummary() {
  try {
    const result = analyzeWebviewRoundtrip(repoRoot);
    return {
      success: result.success,
      failedChecks: result.checks.filter((check) => !check.ok).map((check) => check.id),
      checkCount: result.checks.length,
    };
  } catch (error) {
    return {
      success: false,
      failedChecks: ["WEBVIEW_ROUNDTRIP_EXCEPTION"],
      error: String(error && error.message || error).slice(0, 500),
      checkCount: 0,
    };
  }
}

function uiRuntimeSummary() {
  try {
    const result = analyzeUiRuntime(repoRoot);
    return {
      success: result.success,
      failedChecks: result.checks.filter((check) => !check.ok).map((check) => check.id),
      checkCount: result.checks.length,
      sidebarChipText: result.sidebar?.chipText || "",
      sidebarChipClass: result.sidebar?.chipClass || "",
      antigravityClass: result.dashboard?.antigravityClass || "",
    };
  } catch (error) {
    return {
      success: false,
      failedChecks: ["UI_RUNTIME_EXCEPTION"],
      error: String(error && error.message || error).slice(0, 500),
      checkCount: 0,
      sidebarChipText: "",
      sidebarChipClass: "",
      antigravityClass: "",
    };
  }
}

function plannerCliSmokeSummary() {
  if (!hasFlag("planner-smoke")) return null;
  const result = runPlannerSmoke({
    userCommand: "Connect AI 현재 운영 구조를 5줄로 요약해줘. 구현 작업 금지.",
    printTimeout: "45s",
    processTimeoutMs: 90000,
    fallbackTimeoutMs: 180000,
    fallbackAttempts: 2,
  });
  return {
    success: result.success,
    source: result.source,
    directStatus: result.directStatus || "",
    agyDiagnostic: result.agyDiagnostic || null,
    exitCode: result.exitCode,
    reason: result.parsed?.reason || "",
    taskCount: result.parsed?.plan?.tasks?.length || 0,
  };
}

function antigravityQuotaSummary() {
  return {
    source: "user_screenshot_2026-05-28",
    liveCliQuotaApi: false,
    refreshWindow: "5h rolling window",
    overages: "OFF",
    models: [
      { model: "GPT-OSS 120B", tiers: ["Medium"], remaining: "full" },
      { model: "Gemini 3.5 Flash", tiers: ["Low", "Medium", "High"], remaining: "full" },
      { model: "Gemini 3.1 Pro", tiers: ["Low", "High"], remaining: "full" },
      { model: "Claude Sonnet 4.6", tiers: ["Thinking"], remaining: "full" },
      { model: "Claude Opus 4.6", tiers: ["Thinking"], remaining: "full" },
    ],
  };
}

function swarmStatusSummary() {
  try {
    const summary = summarizeSwarmReports();
    return {
      reportCount: summary.reportCount,
      newestReport: summary.newestReport,
      expectedCount: summary.expectedCount,
      coveredCount: summary.coveredCount,
      coverageOk: summary.coverageOk,
      freshnessOk: summary.freshnessOk,
      newestReportAgeHours: summary.newestReportAgeHours,
      maxAgeHours: summary.maxAgeHours,
      missingIds: summary.missingIds,
      antigravity: summary.antigravity,
      modelDiversity: summary.modelDiversity,
      sourceCounts: summary.sourceCounts,
      actionItemCount: summary.actionItemCount,
      topActionItems: (summary.actionItems || []).slice(0, 6).map((item) => ({
        id: item.id,
        domain: item.domain,
        recommendation: actionSummary(item),
        verificationCommand: item.verificationCommands?.[0] || "",
      })),
    };
  } catch (error) {
    return {
      reportCount: 0,
      newestReport: "",
      expectedCount: 0,
      coveredCount: 0,
      coverageOk: false,
      missingIds: ["SWARM_STATUS_EXCEPTION"],
      error: String(error && error.message || error).slice(0, 500),
      antigravity: { expected: 0, covered: 0, directSuccesses: 0, fallbackSuccesses: 0 },
      sourceCounts: {},
      actionItemCount: 0,
      topActionItems: [],
    };
  }
}

function riskFindings(audit) {
  const findings = [];
  if (audit.package.localLlmEnabledDefault !== false) {
    findings.push({ severity: "P0", code: "LOCAL_LLM_DEFAULT_ENABLED", message: "local LLM default is not false." });
  }
  if (audit.package.plannerProviderDefault !== "antigravity") {
    findings.push({ severity: "P0", code: "PLANNER_NOT_ANTIGRAVITY", message: "plannerProvider default is not antigravity." });
  }
  for (const settings of audit.userSettings || []) {
    if (settings.localLlmEnabled === true) {
      findings.push({ severity: "P0", code: "USER_LOCAL_LLM_ENABLED", message: `${settings.app} user settings override localLlmEnabled=true.` });
    }
    if (settings.plannerProvider === "local") {
      findings.push({ severity: "P0", code: "USER_PLANNER_LOCAL", message: `${settings.app} user settings override plannerProvider=local.` });
    }
    if (settings.localLlmEnabled === true && settings.defaultModel && /(?:20b|14b|large|deep)/i.test(String(settings.defaultModel))) {
      findings.push({ severity: "P2", code: "USER_HEAVY_LOCAL_MODEL_SELECTED", message: `${settings.app} defaultModel is ${settings.defaultModel}; keep localLlmEnabled=false unless intentionally testing local models.` });
    }
  }
  if (audit.sourcePolicy && audit.sourcePolicy.classifierLocalLlmGuarded === false) {
    findings.push({ severity: "P1", code: "CLASSIFIER_LOCAL_LLM_UNGUARDED", message: "classifyToAgent may call the local LLM even when localLlmEnabled is false." });
  }
  if (!audit.queue.file.exists) {
    findings.push({ severity: "P1", code: "QUEUE_FILE_MISSING", message: "agent queue file is missing." });
  }
  if (audit.lock.file.exists && audit.lock.ageMs !== null && audit.lock.ageMs > 60000) {
    findings.push({ severity: "P1", code: "STALE_QUEUE_LOCK", message: `queue lock is older than 60s (${audit.lock.ageMs}ms).` });
  }
  for (const install of audit.bundle.installs) {
    if (!install.bundleFile.exists) {
      findings.push({ severity: "P0", code: "INSTALLED_BUNDLE_MISSING", message: `${install.dir} has no out/extension.js.` });
    } else if (!install.matchesSourceBundle) {
      findings.push({ severity: "P0", code: "INSTALLED_BUNDLE_STALE", message: `${install.dir} out/extension.js does not match repo out/extension.js.` });
    }
  }
  const claudeStatus = audit.workers.status?.claude?.status;
  const claudeHealth = audit.workers.healthAgents?.claude?.status;
  const antigravityHealth = audit.workers.healthAgents?.antigravity?.status;
  if (antigravityHealth === "RATE_LIMITED") {
    findings.push({ severity: "P2", code: "ANTIGRAVITY_DIRECT_RATE_LIMITED", message: "Antigravity CLI is installed, but direct agy print recently hit quota; Gemini fallback is required until quota resets." });
  }
  if (antigravityHealth === "AUTH_EXPIRED") {
    findings.push({ severity: "P1", code: "ANTIGRAVITY_DIRECT_AUTH_EXPIRED", message: "Antigravity CLI direct print recently had an auth issue." });
  }
  if (claudeStatus === "blocked" && claudeHealth === "READY") {
    findings.push({ severity: "P2", code: "CLAUDE_HEALTH_STATUS_MISMATCH", message: "worker-health says Claude READY but worker-status is blocked from a prior run." });
  }
  if (audit.dryRun.exitCode !== 0) {
    findings.push({ severity: "P1", code: "RUN_QUEUE_DRY_RUN_FAILED", message: "node scripts/run-queue.js dry-run failed." });
  }
  const readyForVerificationCount = Number(audit.queue?.counts?.ready_for_verification || 0);
  const plannedVerifierDispatches = Number(audit.verificationDispatch?.plannedCount ?? readyForVerificationCount);
  if (readyForVerificationCount > 0 && plannedVerifierDispatches > 0) {
    findings.push({
      severity: "P2",
      code: "S7_VERIFICATION_BACKLOG_PENDING",
      message: `${readyForVerificationCount} queue item(s) are ready_for_verification and ${plannedVerifierDispatches} still need S7 verifier dispatch before DONE.`,
    });
  }
  if (audit.webviewRoundtrip && !audit.webviewRoundtrip.success) {
    findings.push({ severity: "P0", code: "WEBVIEW_ROUNDTRIP_CONTRACT_BROKEN", message: `webview chat roundtrip checks failed: ${audit.webviewRoundtrip.failedChecks.join(", ")}` });
  }
  if (audit.uiRuntime && !audit.uiRuntime.success) {
    findings.push({ severity: "P0", code: "UI_RUNTIME_STATE_BROKEN", message: `UI runtime smoke failed: ${audit.uiRuntime.failedChecks.join(", ")}` });
  }
  if (audit.plannerCliSmoke && !audit.plannerCliSmoke.success) {
    findings.push({ severity: "P0", code: "PLANNER_CLI_SMOKE_FAILED", message: `planner CLI smoke failed: ${audit.plannerCliSmoke.reason || `exit ${audit.plannerCliSmoke.exitCode}`}` });
  }
  if (audit.plannerCliSmoke && audit.plannerCliSmoke.success && audit.plannerCliSmoke.source === "gemini-fallback" && /RATE_LIMITED/.test(audit.plannerCliSmoke.directStatus || "")) {
    findings.push({ severity: "P2", code: "PLANNER_USING_GEMINI_FALLBACK_FOR_ANTIGRAVITY_QUOTA", message: "Planner smoke passed through Gemini fallback because direct Antigravity is quota-limited." });
  }
  if (audit.swarmStatus && !audit.swarmStatus.coverageOk) {
    findings.push({ severity: "P2", code: "DEEP_DEBUG_SWARM_COVERAGE_INCOMPLETE", message: `deep-debug swarm coverage is ${audit.swarmStatus.coveredCount}/${audit.swarmStatus.expectedCount}.` });
  }
  if (
    audit.swarmStatus?.antigravity?.expected > 0 &&
    audit.swarmStatus.antigravity.directSuccesses < audit.swarmStatus.antigravity.expected
  ) {
    const brokerQuotaAvailable = Boolean(
      audit.antigravityQuota?.models?.length &&
      String(audit.antigravityQuota?.overages || "").toUpperCase() === "OFF"
    );
    findings.push({
      severity: brokerQuotaAvailable ? "P2" : "P0",
      code: "ANTIGRAVITY_DIRECT_COVERAGE_MISSING",
      message: brokerQuotaAvailable
        ? `Antigravity direct lane evidence is still ${audit.swarmStatus.antigravity.directSuccesses}/${audit.swarmStatus.antigravity.expected}, fallback=${audit.swarmStatus.antigravity.fallbackSuccesses}; treating as advisory while Antigravity IDE broker quota/evidence is being refreshed.`
        : `Antigravity lanes require direct agy/transcript/stdout evidence; direct coverage is ${audit.swarmStatus.antigravity.directSuccesses}/${audit.swarmStatus.antigravity.expected}, fallback=${audit.swarmStatus.antigravity.fallbackSuccesses}.`,
    });
  }
  if (audit.swarmStatus && audit.swarmStatus.coverageOk && audit.swarmStatus.freshnessOk === false) {
    findings.push({ severity: "P2", code: "DEEP_DEBUG_SWARM_REPORT_STALE", message: `deep-debug swarm newest report is ${audit.swarmStatus.newestReportAgeHours === null ? "unknown age" : `${audit.swarmStatus.newestReportAgeHours.toFixed(1)}h old`} (max ${audit.swarmStatus.maxAgeHours}h).` });
  }
  if (audit.swarmStatus && audit.swarmStatus.coverageOk && audit.swarmStatus.freshnessOk && audit.swarmStatus.actionItemCount === 0) {
    findings.push({ severity: "P2", code: "DEEP_DEBUG_SWARM_ACTIONS_MISSING", message: "deep-debug swarm reports are fresh and covered, but no actionable recommendations were extracted." });
  }
  if (audit.blockedTriage && !audit.blockedTriage.success) {
    findings.push({ severity: "P1", code: "BLOCKED_TRIAGE_FAILED", message: "blocked backlog triage failed." });
  }
  if (audit.blockedRetryPlan && !audit.blockedRetryPlan.success) {
    findings.push({ severity: "P1", code: "BLOCKED_RETRY_PLAN_FAILED", message: "blocked retry planner failed." });
  }
  return findings;
}

function formatHuman(audit) {
  const lines = [];
  lines.push("Connect AI transport audit (read-only)");
  lines.push("");
  lines.push(`repo: ${repoRoot}`);
  lines.push(`queue: ${audit.queue.path}`);
  const readyForVerificationCount = audit.queue.counts.ready_for_verification || 0;
  lines.push(`queue status: total ${audit.queue.count}, queued ${audit.queue.counts.queued || 0}, copied ${audit.queue.counts.copied || 0}, running ${audit.queue.counts.running || 0}, blocked ${audit.queue.counts.blocked || 0}, ready_for_verification ${readyForVerificationCount}, done ${audit.queue.counts.done || 0}`);
  lines.push(`planner default: ${audit.package.plannerProviderDefault}`);
  lines.push(`local LLM default: ${audit.package.localLlmEnabledDefault}`);
  if (audit.userSettings && audit.userSettings.length) {
    for (const settings of audit.userSettings) {
      lines.push(`${settings.app} user override: planner=${settings.plannerProvider ?? "(unset)"}, localLlm=${settings.localLlmEnabled ?? "(unset)"}, model=${settings.defaultModel ?? "(unset)"}`);
    }
  }
  lines.push(`run dry-run: exit ${audit.dryRun.exitCode}, mutatesQueue=${audit.dryRun.mutatesQueue}`);
  lines.push(`webview roundtrip: ${audit.webviewRoundtrip.success ? "ok" : "failed"} (${audit.webviewRoundtrip.checkCount} checks)`);
  lines.push(`UI runtime smoke: ${audit.uiRuntime.success ? "ok" : "failed"} (${audit.uiRuntime.checkCount} checks, sidebar="${audit.uiRuntime.sidebarChipText}", antigravity="${audit.uiRuntime.antigravityClass}")`);
  if (audit.antigravityQuota) {
    lines.push(`antigravity quota: source=${audit.antigravityQuota.source}, window=${audit.antigravityQuota.refreshWindow}, overages=${audit.antigravityQuota.overages}`);
    for (const model of audit.antigravityQuota.models || []) {
      lines.push(`  - ${model.model}: ${model.remaining} (${(model.tiers || []).join("/")})`);
    }
  }
  lines.push(`blocked triage: total ${audit.blockedTriage.totalBlocked}, archiveCandidates=${audit.blockedTriage.candidateCounts.verifiedArchiveCandidates}, retryCandidates=${audit.blockedTriage.candidateCounts.retryCandidates}, userDecisionRequired=${audit.blockedTriage.candidateCounts.userDecisionRequired}, evidenceOnly=${audit.blockedTriage.candidateCounts.evidenceOnly}`);
  if (audit.blockedRetryPlan) {
    lines.push(`blocked retry plan: planned=${audit.blockedRetryPlan.plannedCount}, backlog=${audit.blockedRetryPlan.backlogCount}, cutoff=${audit.blockedRetryPlan.backlogCutoffHours}h`);
    for (const item of audit.blockedRetryPlan.backlog || []) {
      lines.push(`  - backlog/${item.assignee || "unknown"}: ${item.id} (${item.reason || "blocked_backlog"})`);
    }
  }
  if (readyForVerificationCount > 0) {
    const plannedVerifierDispatches = Number(audit.verificationDispatch?.plannedCount ?? readyForVerificationCount);
    const activeVerifierCount = Number(audit.verificationDispatch?.activeVerifierCount || 0);
    if (plannedVerifierDispatches > 0) {
      lines.push(`verification backlog: ${readyForVerificationCount} ready_for_verification item(s); run npm run agent:verify-dispatch -- --execute to enqueue ${plannedVerifierDispatches} read-only S7 verifier task(s).`);
    } else {
      lines.push(`verification backlog: ${readyForVerificationCount} ready_for_verification item(s); ${activeVerifierCount} verifier task(s) already queued/active.`);
    }
  }
  lines.push(`deep-debug swarm: ${audit.swarmStatus.coverageOk ? "ok" : "incomplete"} (${audit.swarmStatus.coveredCount}/${audit.swarmStatus.expectedCount} lanes, reports=${audit.swarmStatus.reportCount}, freshness=${audit.swarmStatus.freshnessOk ? "ok" : "stale"}, actionItems=${audit.swarmStatus.actionItemCount || 0}, antigravity direct=${audit.swarmStatus.antigravity.directSuccesses}, historicalFallback=${audit.swarmStatus.antigravity.fallbackSuccesses})`);
  if (audit.swarmStatus.modelDiversity) {
    lines.push(`model diversity: ${audit.swarmStatus.modelDiversity.observedCount} observed (${audit.swarmStatus.modelDiversity.minimumFourModelTargetMet ? "4-model target met" : "below target"})`);
    for (const model of audit.swarmStatus.modelDiversity.observedModels || []) lines.push(`  - ${model}`);
  }
  if (audit.plannerCliSmoke) {
    lines.push(`planner CLI smoke: ${audit.plannerCliSmoke.success ? "ok" : "failed"} (source=${audit.plannerCliSmoke.source || "unknown"}, direct=${audit.plannerCliSmoke.directStatus || "unknown"}, tasks=${audit.plannerCliSmoke.taskCount || 0})`);
  }
  lines.push("");
  lines.push("findings:");
  if (!audit.findings.length) lines.push("- none");
  for (const finding of audit.findings) lines.push(`- [${finding.severity}] ${finding.code}: ${finding.message}`);
  lines.push("");
  lines.push("deep-debug top actions:");
  if (!audit.swarmStatus.topActionItems?.length) {
    lines.push("- none");
  } else {
    for (const item of audit.swarmStatus.topActionItems) {
      lines.push(`- ${item.id}: ${item.recommendation || item.verificationCommand || "(no summary)"}`);
    }
  }
  lines.push("");
  lines.push("installed extension bundles:");
  for (const install of audit.bundle.installs) {
    lines.push(`- ${install.dir}: ${install.bundleFile.exists ? "exists" : "missing"}, matches source=${install.matchesSourceBundle}`);
  }
  lines.push("");
  lines.push("active queue sample:");
  if (!audit.queue.activeSample.length) lines.push("- none");
  for (const item of audit.queue.activeSample) lines.push(`- ${item.status}/${item.assignee}/${item.priority}: ${item.title} (${item.id})`);
  return lines.join("\n");
}

function main() {
  const queue = queueSummary();
  const queueItems = readJson(queueFile, []);
  const audit = {
    generatedAt: new Date().toISOString(),
    platform: process.platform,
    env: {
      isWsl: envPaths.isWsl,
      winUser: envPaths.WIN_USER,
      vaultRoot: envPaths.vaultRoot(),
      queueOverrideSet: Boolean(process.env.CONNECT_AI_AGENT_QUEUE),
    },
    package: packageSummary(),
    userSettings: userSettingsSummary(),
    sourcePolicy: sourcePolicySummary(),
    queue,
    blockedTriage: blockedTriageSummary(queueItems),
    blockedRetryPlan: blockedRetryPlanSummary(queueItems),
    verificationDispatch: verificationDispatchSummary(queueItems),
    lock: lockSummary(),
    workers: workerFilesSummary(),
    bundle: bundleSummary(),
    dryRun: dryRunSummary(),
    webviewRoundtrip: webviewRoundtripSummary(),
    uiRuntime: uiRuntimeSummary(),
    antigravityQuota: antigravityQuotaSummary(),
    swarmStatus: swarmStatusSummary(),
    plannerCliSmoke: plannerCliSmokeSummary(),
  };
  audit.findings = riskFindings(audit);
  if (hasFlag("json")) console.log(JSON.stringify(audit, null, 2));
  else console.log(formatHuman(audit));
  process.exit(audit.findings.some((finding) => finding.severity === "P0") ? 1 : 0);
}

if (require.main === module) main();

module.exports = { blockedRetryPlanSummary, formatHuman, riskFindings };
