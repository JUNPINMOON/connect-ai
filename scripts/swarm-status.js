#!/usr/bin/env node
"use strict";

// Read-only status audit for deep-debug swarm reports.
// It never starts agents, mutates the queue, or writes to the vault.

const fs = require("node:fs");
const path = require("node:path");
const envPaths = require("./env-paths.js");
const { AGENTS } = require("./deep-debug-swarm.js");

const repoRoot = envPaths.repoRoot();

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function getArg(name, fallback = "") {
  const idx = process.argv.indexOf(`--${name}`);
  return idx === -1 ? fallback : (process.argv[idx + 1] || fallback);
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function listReportFiles(root = repoRoot) {
  const reportsDir = path.join(root, "reports", "deep-debug-swarm");
  if (!fs.existsSync(reportsDir)) return [];
  return fs.readdirSync(reportsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(reportsDir, entry.name, "report.json"))
    .filter((file) => fs.existsSync(file))
    .sort();
}

function normalizeReport(file) {
  const parsed = readJson(file, null);
  const results = Array.isArray(parsed?.results) ? parsed.results : [];
  return {
    file,
    generatedAt: parsed?.generatedAt || "",
    agentCount: Number(parsed?.agentCount || results.length || 0),
    results,
  };
}

function isWithinWindow(report, sinceHours) {
  if (!sinceHours) return true;
  const ts = new Date(report.generatedAt).getTime();
  if (!Number.isFinite(ts)) return false;
  return Date.now() - ts <= sinceHours * 60 * 60 * 1000;
}

function sectionBody(text, titlePattern) {
  const raw = String(text || "").replace(/```[a-zA-Z]*\n?|```/g, "");
  const titleRe = new RegExp(`(?:^|\\n)\\s*(?:#{1,6}\\s*)?(?:\\d+\\.\\s*)?${titlePattern}\\s*\\n`, "gi");
  const matches = Array.from(raw.matchAll(titleRe));
  if (!matches.length) return "";
  const bodies = matches.map((match) => {
    const start = Number(match.index || 0) + match[0].length;
    const rest = raw.slice(start);
    const next = rest.search(/\n\s*(?:#{1,6}\s*)?(?:\d+\.\s*)?(?:핵심 판정|발견한 문제|근거|권장 수정|검증 명령|위험\/보류)\s*\n/i);
    return (next === -1 ? rest : rest.slice(0, next)).trim();
  }).filter(Boolean);
  const score = (body) => {
    let value = body.length;
    if (/^\s*[-*]\s+/m.test(body)) value += 10000;
    if (/`[^`]+`/.test(body) || /\b(?:node|npm|git|pwsh|powershell)\b/i.test(body)) value += 1000;
    if (/^(?:핵심 판정|발견한 문제|근거|권장 수정|검증 명령|위험\/보류|\d+\.)/m.test(body)) value -= 5000;
    if (/형식에 맞추어/.test(body)) value -= 5000;
    return value;
  };
  return bodies.sort((a, b) => score(b) - score(a))[0] || "";
}

function extractBulletLikeLines(text, limit = 4) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^[-*]\s+/, "").replace(/^\d+\.\s+/, "").trim())
    .filter(Boolean)
    .filter((line) => !/^(핵심 판정|발견한 문제|근거|권장 수정|검증 명령|위험\/보류)$/.test(line))
    .filter((line) => !/^형식에 맞추어/.test(line))
    .filter((line) => !/^```/.test(line));
  return lines.slice(0, limit);
}

function extractSwarmActionItem(result) {
  const response = String(result?.response || "");
  const recommendations = extractBulletLikeLines(sectionBody(response, "권장\\s*수정"), 4);
  const verificationCommands = extractBulletLikeLines(sectionBody(response, "검증\\s*명령"), 4);
  if (!recommendations.length && !verificationCommands.length) return null;
  return {
    id: result.id,
    provider: result.provider,
    domain: result.domain,
    source: result.source,
    report: result.report,
    generatedAt: result.generatedAt,
    recommendations,
    verificationCommands,
  };
}

function isAntigravityDirectSource(source) {
  return /^(antigravity|agy|transcript|stdout)$/i.test(String(source || ""));
}

function isVerifiedAntigravityDirectSuccess(result) {
  return Boolean(result?.ok)
    && isAntigravityDirectSource(result?.source)
    && result?.reviewShapeOk === true;
}

function actionSummary(item) {
  const candidates = [
    ...(item?.recommendations || []),
    ...(item?.verificationCommands || []),
  ];
  return candidates.find((line) => !/[:：]\s*$/.test(String(line).replace(/\*\*/g, "").trim()))
    || candidates[0]
    || "(no summary)";
}

function summarizeSwarmReports(options = {}) {
  const root = options.repoRoot || repoRoot;
  const sinceHours = Number(options.sinceHours || 0) || 0;
  const maxAgeHours = Number(options.maxAgeHours || 24) || 24;
  const nowMs = Number(options.nowMs || Date.now());
  const expectedAgents = options.expectedAgents || AGENTS;
  const expectedIds = expectedAgents.map((agent) => agent.id);
  const files = listReportFiles(root);
  const reports = files.map(normalizeReport).filter((report) => isWithinWindow(report, sinceHours));
  const newestReportGeneratedAt = reports.reduce((latest, report) => {
    if (!report.generatedAt) return latest;
    return !latest || String(report.generatedAt).localeCompare(String(latest)) > 0 ? report.generatedAt : latest;
  }, "");
  const newestReportMs = newestReportGeneratedAt ? new Date(newestReportGeneratedAt).getTime() : NaN;
  const newestReportAgeHours = Number.isFinite(newestReportMs)
    ? Math.max(0, (nowMs - newestReportMs) / (60 * 60 * 1000))
    : null;
  const freshnessOk = newestReportAgeHours !== null && newestReportAgeHours <= maxAgeHours;

  const latestById = new Map();
  const successById = new Map();
  const antigravityFallbackById = new Map();
  const sourceCounts = {};
  const providerCounts = {};
  const domainCoverage = {};

  for (const report of reports) {
    for (const result of report.results) {
      if (!result || !result.id) continue;
      const previous = latestById.get(result.id);
      if (!previous || String(report.generatedAt).localeCompare(String(previous.generatedAt)) >= 0) {
        latestById.set(result.id, { report: report.file, generatedAt: report.generatedAt, ...result });
      }
      const expectedProvider = expectedAgents.find((agent) => agent.id === result.id)?.provider;
      const provider = result.provider || expectedProvider || "unknown";
      const successOk = provider === "antigravity"
        ? isVerifiedAntigravityDirectSuccess(result)
        : Boolean(result.ok);
      if (successOk) {
        const previousSuccess = successById.get(result.id);
        if (!previousSuccess || String(report.generatedAt).localeCompare(String(previousSuccess.generatedAt)) >= 0) {
          successById.set(result.id, { report: report.file, generatedAt: report.generatedAt, ...result });
        }
      }
      if (provider === "antigravity" && result.ok && !isAntigravityDirectSource(result.source)) {
        const previousFallback = antigravityFallbackById.get(result.id);
        if (!previousFallback || String(report.generatedAt).localeCompare(String(previousFallback.generatedAt)) >= 0) {
          antigravityFallbackById.set(result.id, { report: report.file, generatedAt: report.generatedAt, ...result });
        }
      }
      const source = result.source || "unknown";
      sourceCounts[source] = (sourceCounts[source] || 0) + 1;
      providerCounts[provider] = (providerCounts[provider] || 0) + 1;
      const domain = result.domain || expectedAgents.find((agent) => agent.id === result.id)?.domain || "unknown";
      if (!domainCoverage[domain]) domainCoverage[domain] = { total: 0, ok: 0 };
      domainCoverage[domain].total += 1;
      if (result.ok) domainCoverage[domain].ok += 1;
    }
  }

  const antigravityExpected = expectedAgents.filter((agent) => agent.provider === "antigravity").map((agent) => agent.id);
  const antigravityDirectSuccesses = antigravityExpected.filter((id) => {
    return isVerifiedAntigravityDirectSuccess(successById.get(id));
  });
  const missingIds = expectedIds.filter((id) => {
    const expected = expectedAgents.find((agent) => agent.id === id);
    if (expected?.provider === "antigravity") return !antigravityDirectSuccesses.includes(id);
    return !successById.has(id);
  });
  const latestFailures = Array.from(latestById.values()).filter((result) => !result.ok).map((result) => result.id);
  const antigravityFallbackSuccesses = antigravityExpected.filter((id) => {
    return antigravityFallbackById.has(id);
  });
  const actionItems = Array.from(successById.values())
    .map(extractSwarmActionItem)
    .filter(Boolean)
    .sort((a, b) => a.id.localeCompare(b.id));
  const successfulLaneResults = Array.from(successById.values()).filter((result) => {
    if (result.provider === "antigravity") return isVerifiedAntigravityDirectSuccess(result);
    return true;
  });
  const observedModels = Array.from(new Set(successfulLaneResults
    .map((result) => result.observedModelLabel || result.requestedModelLabel || "")
    .filter(Boolean)))
    .sort();
  const modelDiversity = {
    observedCount: observedModels.length,
    observedModels,
    minimumFourModelTargetMet: observedModels.length >= 4,
    note: "Gemini CLI lanes are explicit --model selections; Antigravity lanes are verified from CLI logs.",
  };

  return {
    generatedAt: new Date().toISOString(),
    root,
    reportsDir: path.join(root, "reports", "deep-debug-swarm"),
    reportCount: reports.length,
    newestReport: reports.length ? reports[reports.length - 1].file : "",
    newestReportGeneratedAt,
    newestReportAgeHours,
    maxAgeHours,
    freshnessOk,
    sinceHours,
    expectedCount: expectedIds.length,
    coveredCount: expectedIds.length - missingIds.length,
    coverageOk: missingIds.length === 0,
    missingIds,
    latestFailures,
    sourceCounts,
    providerCounts,
    domainCoverage,
    antigravity: {
      expected: antigravityExpected.length,
      covered: antigravityDirectSuccesses.length,
      directSuccesses: antigravityDirectSuccesses.length,
      fallbackSuccesses: antigravityFallbackSuccesses.length,
      directCoverageOk: antigravityDirectSuccesses.length === antigravityExpected.length,
    },
    actionItemCount: actionItems.length,
    actionItems,
    modelDiversity,
    successfulLanes: successfulLaneResults.map((result) => ({
      id: result.id,
      provider: result.provider,
      domain: result.domain,
      source: result.source,
      requestedModelLabel: result.requestedModelLabel || "",
      observedModelLabel: result.observedModelLabel || "",
      modelSelectionEnforced: result.modelSelectionEnforced ?? null,
      report: result.report,
      generatedAt: result.generatedAt,
    })).sort((a, b) => a.id.localeCompare(b.id)),
  };
}

function formatHuman(summary) {
  const lines = [];
  lines.push("Connect AI deep-debug swarm status (read-only)");
  lines.push("");
  lines.push(`reports: ${summary.reportCount}`);
  lines.push(`coverage: ${summary.coveredCount}/${summary.expectedCount} ${summary.coverageOk ? "ok" : "incomplete"}`);
  lines.push(`freshness: ${summary.freshnessOk ? "ok" : "stale"}${summary.newestReportAgeHours === null ? "" : ` (${summary.newestReportAgeHours.toFixed(2)}h old, max ${summary.maxAgeHours}h)`}`);
  lines.push(`newest report: ${summary.newestReport || "(none)"}`);
  lines.push(`antigravity: ${summary.antigravity.covered}/${summary.antigravity.expected} covered, direct=${summary.antigravity.directSuccesses}, fallback=${summary.antigravity.fallbackSuccesses}`);
  lines.push(`models: ${summary.modelDiversity?.observedCount || 0} observed (${summary.modelDiversity?.minimumFourModelTargetMet ? "4-model target met" : "below target"})`);
  for (const model of summary.modelDiversity?.observedModels || []) lines.push(`  - ${model}`);
  lines.push(`action items: ${summary.actionItemCount || 0}`);
  lines.push("");
  lines.push("sources:");
  for (const [source, count] of Object.entries(summary.sourceCounts)) lines.push(`- ${source}: ${count}`);
  if (!Object.keys(summary.sourceCounts).length) lines.push("- none");
  lines.push("");
  lines.push("missing lanes:");
  if (!summary.missingIds.length) lines.push("- none");
  for (const id of summary.missingIds) lines.push(`- ${id}`);
  lines.push("");
  lines.push("latest failed lanes:");
  if (!summary.latestFailures.length) lines.push("- none");
  for (const id of summary.latestFailures) lines.push(`- ${id}`);
  lines.push("");
  lines.push("top action items:");
  if (!summary.actionItems?.length) {
    lines.push("- none");
  } else {
    for (const item of summary.actionItems.slice(0, 6)) {
      lines.push(`- ${item.id}: ${actionSummary(item)}`);
    }
  }
  return lines.join("\n");
}

function main() {
  const summary = summarizeSwarmReports({ sinceHours: getArg("since-hours", "0") });
  if (hasFlag("json")) console.log(JSON.stringify(summary, null, 2));
  else console.log(formatHuman(summary));
  process.exit(summary.coverageOk ? 0 : 1);
}

if (require.main === module) main();

module.exports = { listReportFiles, summarizeSwarmReports, formatHuman, sectionBody, extractSwarmActionItem, actionSummary, isAntigravityDirectSource, isVerifiedAntigravityDirectSuccess };
