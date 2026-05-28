#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const envPaths = require("./env-paths.js");

const repoRoot = envPaths.repoRoot();
const vaultRoot = envPaths.vaultRoot();
const companyDir = envPaths.companyDir();

function getArg(name, fallback = "") {
  const idx = process.argv.indexOf(`--${name}`);
  return idx === -1 ? fallback : process.argv[idx + 1] || fallback;
}

function compactTimestamp(value = new Date()) {
  return value.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function buildAuditPlan(paths = {}) {
  const repo = paths.repoRoot || repoRoot;
  const vault = paths.vaultRoot || vaultRoot;
  return {
    generatedAt: new Date().toISOString(),
    repoRoot: repo,
    vaultRoot: vault,
    commands: [
      {
        name: "transportAudit",
        mutates: false,
        command: process.execPath,
        args: [path.join(repo, "scripts", "transport-audit.js"), "--json"],
        cwd: repo,
      },
      {
        name: "vaultHealth",
        mutates: false,
        command: "powershell",
        args: [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          `$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); & '${path.join(vault, "runbooks", "_scripts", "obsidian-vault-health.ps1").replace(/'/g, "''")}' -Json`,
        ],
        cwd: repo,
        captureStdout: false,
      },
      {
        name: "graphAudit",
        mutates: false,
        command: process.execPath,
        args: [path.join(repo, "scripts", "obsidian-graph-audit.js"), "--max", "50"],
        cwd: repo,
      },
      {
        name: "dashboardPlugin",
        mutates: false,
        url: "http://127.0.0.1:9119/dashboard-plugins/example/dist/index.js",
      },
      {
        name: "agentContracts",
        mutates: false,
        command: process.execPath,
        args: [path.join(repo, "scripts", "validate-agent-contracts.js")],
        cwd: repo,
      },
      {
        name: "rootMigrationApproval",
        mutates: false,
        command: process.execPath,
        args: [path.join(repo, "scripts", "obsidian-graph-audit.js"), "--verify-approval-packet"],
        cwd: repo,
      },
      {
        name: "queueGate",
        mutates: false,
        isolatedTempOnly: true,
      },
    ],
  };
}

function tryParseJson(text) {
  try { return JSON.parse(String(text || "")); } catch { return null; }
}

function runCommand(item) {
  const result = spawnSync(item.command, item.args || [], {
    cwd: item.cwd || repoRoot,
    env: process.env,
    encoding: "utf8",
    windowsHide: true,
    timeout: 60000,
    maxBuffer: 20 * 1024 * 1024,
  });
  const stdout = String(result.stdout || "").trim();
  const stderr = String(result.stderr || result.error?.message || "").trim();
  return {
    ok: (result.status ?? 1) === 0,
    exitCode: result.status ?? 1,
    stdout: item.captureStdout === false ? "" : stdout.slice(0, 20000),
    stderr: stderr.slice(0, 4000),
    parsed: tryParseJson(stdout),
  };
}

function fetchUrl(url) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 5000 }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({
        ok: res.statusCode >= 200 && res.statusCode < 300 && !/\bexport\b/.test(body),
        status: res.statusCode,
        bytes: Buffer.byteLength(body),
        hasExportSyntax: /\bexport\b/.test(body),
      }));
    });
    req.on("timeout", () => {
      req.destroy(new Error("dashboard_plugin_timeout"));
    });
    req.on("error", (error) => resolve({ ok: false, error: error.message }));
  });
}

function runQueueGateSmoke() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-nightly-queue-"));
  const queueFile = path.join(temp, "agent-queue.json");
  const env = { ...process.env, CONNECT_AI_AGENT_QUEUE: queueFile };
  const cli = path.join(repoRoot, "scripts", "agent-queue.js");
  const dispatchCli = path.join(repoRoot, "scripts", "verification-dispatch.js");
  function run(args) {
    const result = spawnSync(process.execPath, [cli, ...args], {
      cwd: repoRoot,
      env,
      encoding: "utf8",
      windowsHide: true,
      timeout: 30000,
      maxBuffer: 5 * 1024 * 1024,
    });
    const parsed = tryParseJson(result.stdout);
    if ((result.status ?? 1) !== 0) {
      return { ok: false, exitCode: result.status ?? 1, stdout: result.stdout, stderr: result.stderr, parsed };
    }
    return { ok: true, parsed };
  }
  function runDispatch(args) {
    const result = spawnSync(process.execPath, [dispatchCli, ...args], {
      cwd: repoRoot,
      env,
      encoding: "utf8",
      windowsHide: true,
      timeout: 30000,
      maxBuffer: 5 * 1024 * 1024,
    });
    const parsed = tryParseJson(result.stdout);
    if ((result.status ?? 1) !== 0) {
      return { ok: false, exitCode: result.status ?? 1, stdout: result.stdout, stderr: result.stderr, parsed };
    }
    return { ok: true, parsed };
  }
  const add = run(["add", "--assignee", "codex", "--priority", "P1", "--title", "Nightly audit queue gate smoke", "--prompt", "Temp-only smoke.", "--file", "scripts/vault-writer.js"]);
  const id = add.parsed?.item?.id;
  if (!id) return { ok: false, reason: "queue_add_failed", add };
  const first = run([
    "update",
    "--id", id,
    "--status", "done",
    "--result-summary",
    "Files changed: none. Commands run: temp smoke. Current-run expected tests/evidence: isolated queue gate smoke passed. Unresolved failures: none.",
  ]);
  const dispatch = runDispatch(["--execute", "--reviewer", "gemini"]);
  const verifierId = dispatch.parsed?.enqueued?.[0]?.id || "";
  const verifier = verifierId
    ? run([
      "update",
      "--id", verifierId,
      "--status", "done",
      "--result-summary",
      "검증 판정: accept\n근거: temp-only queue gate smoke passed.\n누락 증거: 없음.",
      "--verified",
    ])
    : { ok: false, parsed: null };
  const second = runDispatch(["--apply", "--execute"]);
  const validate = spawnSync(process.execPath, [path.join(repoRoot, "scripts", "result-validator.js")], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    windowsHide: true,
    timeout: 30000,
    maxBuffer: 5 * 1024 * 1024,
  });
  const validation = tryParseJson(validate.stdout);
  return {
    ok: first.parsed?.item?.status === "ready_for_verification"
      && verifier.parsed?.item?.status === "done"
      && second.parsed?.applied?.[0]?.status === "done"
      && Boolean(second.parsed?.applied?.[0]?.verifiedAt)
      && validation?.success === true,
    queueFile,
    taskId: id,
    verifierTaskId: verifierId,
    firstStatus: first.parsed?.item?.status || "",
    verifierStatus: verifier.parsed?.item?.status || "",
    secondStatus: second.parsed?.applied?.[0]?.status || "",
    verifiedAt: Boolean(second.parsed?.applied?.[0]?.verifiedAt),
    dispatchPlanned: dispatch.parsed?.plannedCount ?? null,
    applyPlanned: second.parsed?.plannedCount ?? null,
    validation,
  };
}

function deriveVerdict(results) {
  if (!results.transportAudit?.ok) return "BLOCKED";
  if (!results.vaultHealth?.ok) return "BLOCKED";
  if (!results.graphAudit?.ok) return "BLOCKED";
  if (!results.agentContracts?.ok || results.agentContracts?.parsed?.success !== true) return "BLOCKED";
  if (rootMigrationApprovalBlocks(results)) return "BLOCKED";
  if (Array.isArray(results.transportAudit.parsed?.findings) && results.transportAudit.parsed.findings.length > 0) return "PARTIAL";
  if (Number(results.vaultHealth.parsed?.UnresolvedLinks || 0) > 0) return "PARTIAL";
  if (Number(results.vaultHealth.parsed?.StaleInboxFilesOver7Days || 0) > 0) return "PARTIAL";
  if (Number(results.graphAudit.parsed?.counts?.applyEligibleRepairs || 0) > 0) return "PARTIAL";
  if (Number(results.graphAudit.parsed?.counts?.needsManualMoveOrPolicy || 0) > 0) return "PARTIAL";
  if (results.dashboardPlugin && results.dashboardPlugin.ok === false) return "PARTIAL";
  if (results.queueGate && results.queueGate.ok === false) return "PARTIAL";
  return "VERIFIED";
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function rootMigrationApprovalBlocks(results) {
  const approval = results.rootMigrationApproval;
  if (!approval) return true;
  if (approval.ok && approval.parsed?.ok !== false) return false;

  const requiredRootMoves = finiteNumber(results.graphAudit?.parsed?.debtSummary?.approvalRequiredRootMoves?.count);
  const currentPlannedMoves = finiteNumber(approval.parsed?.counts?.currentPlannedMoves);
  const currentGraphProvesNoRootMoves = requiredRootMoves === 0 && (currentPlannedMoves === null || currentPlannedMoves === 0);

  return !currentGraphProvesNoRootMoves;
}

function reportMarkdown(report) {
  const summary = report?.summary || {};
  const lines = [
    "# Connect AI Agent OS Read-only Audit",
    "",
    `- generatedAt: ${report?.generatedAt || ""}`,
    `- Status: ${report?.status || "PARTIAL"}`,
    "",
    "## Summary",
    "",
    `- transportFindings: ${summary.transportFindings ?? "unknown"}`,
    `- blockedRetryPlanned: ${summary.blockedRetryPlanned ?? "unknown"}`,
    `- blockedRetryBacklog: ${summary.blockedRetryBacklog ?? "unknown"}`,
    `- blockedRetrySkipped: ${summary.blockedRetrySkipped ?? "unknown"}`,
    `- blockedRetryCutoffHours: ${summary.blockedRetryCutoffHours ?? "unknown"}`,
    `- unresolvedLinks: ${summary.unresolvedLinks ?? "unknown"}`,
    `- staleInbox: ${summary.staleInbox ?? "unknown"}`,
    `- graphMissingFrontmatter: ${summary.graphMissingFrontmatter ?? "unknown"}`,
    `- graphLinkless: ${summary.graphLinkless ?? "unknown"}`,
    `- graphSafeAutoRepair: ${summary.graphSafeAutoRepair ?? "unknown"}`,
    `- graphApprovalRequiredRootMoves: ${summary.graphApprovalRequiredRootMoves ?? "unknown"}`,
    `- graphIgnoredByPolicyDebt: ${summary.graphIgnoredByPolicyDebt ?? "unknown"}`,
    `- graphNextSafeAction: ${summary.graphNextSafeAction || "unknown"}`,
    `- rootMigrationApprovalFresh: ${summary.rootMigrationApprovalFresh ?? "unknown"}`,
    `- rootMigrationApprovalArtifactExists: ${summary.rootMigrationApprovalArtifactExists ?? "unknown"}`,
    `- queueGateOk: ${summary.queueGateOk ?? "unknown"}`,
    "",
    "## Boundaries",
    "",
    "- This report is written to runtime companyDir only.",
    "- It does not approve, migrate, clean up, deploy, or write durable vault notes.",
  ];
  return `${lines.join("\n")}\n`;
}

function writeAuditReport(report, options = {}) {
  const root = path.resolve(options.companyDir || companyDir);
  const dir = path.join(root, "agent-os", "nightly-audits");
  const stamp = compactTimestamp(new Date(Date.parse(report?.generatedAt || "") || Date.now()));
  const jsonPath = path.join(dir, `${stamp}.json`);
  const markdownPath = path.join(dir, `${stamp}.md`);
  const latestJsonPath = path.join(dir, "latest.json");
  const latestMarkdownPath = path.join(dir, "latest.md");
  const reportFiles = {
    ok: true,
    wrote: true,
    dir,
    jsonPath,
    markdownPath,
    latestJsonPath,
    latestMarkdownPath,
  };
  const persistedReport = { ...report, reportFiles };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(jsonPath, `${JSON.stringify(persistedReport, null, 2)}\n`, "utf8");
  fs.writeFileSync(markdownPath, reportMarkdown(persistedReport), "utf8");
  fs.writeFileSync(latestJsonPath, `${JSON.stringify(persistedReport, null, 2)}\n`, "utf8");
  fs.writeFileSync(latestMarkdownPath, reportMarkdown(persistedReport), "utf8");
  return reportFiles;
}

async function runAudit() {
  const plan = buildAuditPlan();
  const results = {};
  for (const item of plan.commands) {
    if (item.name === "dashboardPlugin") results[item.name] = await fetchUrl(item.url);
    else if (item.name === "queueGate") results[item.name] = runQueueGateSmoke();
    else results[item.name] = runCommand(item);
  }
  return {
    generatedAt: new Date().toISOString(),
    status: deriveVerdict(results),
    plan,
    summary: {
      transportFindings: results.transportAudit?.parsed?.findings?.length ?? null,
      blockedRetryPlanned: results.transportAudit?.parsed?.blockedRetryPlan?.plannedCount ?? null,
      blockedRetryBacklog: results.transportAudit?.parsed?.blockedRetryPlan?.backlogCount ?? null,
      blockedRetrySkipped: results.transportAudit?.parsed?.blockedRetryPlan?.skippedCount ?? null,
      blockedRetryCutoffHours: results.transportAudit?.parsed?.blockedRetryPlan?.backlogCutoffHours ?? null,
      unresolvedLinks: results.vaultHealth?.parsed?.UnresolvedLinks ?? null,
      staleInbox: results.vaultHealth?.parsed?.StaleInboxFilesOver7Days ?? null,
      graphMissingFrontmatter: results.graphAudit?.parsed?.counts?.missingFrontmatter ?? null,
      graphLinkless: results.graphAudit?.parsed?.counts?.linkless ?? null,
      graphSafeAutoRepair: results.graphAudit?.parsed?.debtSummary?.safeAutoRepair?.count ?? null,
      graphApprovalRequiredRootMoves: results.graphAudit?.parsed?.debtSummary?.approvalRequiredRootMoves?.count ?? null,
      graphIgnoredByPolicyDebt: results.graphAudit?.parsed?.debtSummary?.ignoredByPolicyDebt?.count ?? null,
      graphNextSafeAction: results.graphAudit?.parsed?.debtSummary?.nextSafeAction ?? "",
      dashboardPluginOk: results.dashboardPlugin?.ok ?? null,
      agentContractsOk: results.agentContracts?.parsed?.success ?? null,
      agentContractCount: results.agentContracts?.parsed?.contractCount ?? null,
      rootMigrationApprovalFresh: results.rootMigrationApproval?.parsed?.fresh ?? null,
      rootMigrationApprovalPending: results.rootMigrationApproval?.parsed?.pending ?? null,
      rootMigrationApprovalArtifactExists: results.rootMigrationApproval?.parsed?.humanApprovalArtifact?.exists ?? null,
      queueGateOk: results.queueGate?.ok ?? null,
    },
    results,
  };
}

if (require.main === module) {
  runAudit().then((report) => {
    const finalReport = process.argv.includes("--write-report")
      ? { ...report, reportFiles: writeAuditReport(report, { companyDir: getArg("company-dir", companyDir) }) }
      : report;
    console.log(JSON.stringify(finalReport, null, 2));
    process.exit(finalReport.status === "BLOCKED" ? 1 : 0);
  }).catch((error) => {
    console.log(JSON.stringify({ generatedAt: new Date().toISOString(), status: "BLOCKED", error: error.message }, null, 2));
    process.exit(1);
  });
}

module.exports = {
  buildAuditPlan,
  deriveVerdict,
  reportMarkdown,
  runAudit,
  writeAuditReport,
};
