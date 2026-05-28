#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const envPaths = require("./env-paths.js");

const CATEGORY_RULES = [
  { id: "extension-runtime", patterns: [/^(src|assets|config|mcp)\//, /^package(-lock)?\.json$/, /^\.vscodeignore$/, /^\.gitignore$/] },
  { id: "repo-metadata", patterns: [/^\.gitattributes$/, /^README-IMPLEMENTATION\.md$/, /^COPIED-RECOVERY-IMPLEMENTATION\.md$/, /^phase2-improvement\.md$/] },
  { id: "queue-worker", patterns: [/^scripts\/(agent-queue|queue-dispatcher|run-queue|run-queue-parallel|codex-worker|claude-worker|gemini-worker|local-llm-worker|result-validator|verification-dispatch|agent-mesh|no-write-monitor)/] },
  { id: "agent-os-control-plane", patterns: [/^scripts\/(agent-loop|agent-policy|agent-contracts|agent-os-dashboard|agent-os-nightly-audit|approval-watcher|blocked-|cycle|gate-check|task-dispatch-goal|mcp-task-dispatch|maintenance|nightly-maintenance|register-approval-watcher|audit-log)/] },
  { id: "executor-adapters", patterns: [/^scripts\/(codex-executor-adapter|local-llm-executor|gemini-executor|antigravity-reviewer|antigravity-executor-adapter)/] },
  { id: "cli-health-and-routing", patterns: [/^scripts\/(cli-health-check|connect-ai-readiness|connect-ai-status|cost-tracker|env-doctor|env-paths|model-router|google-reviewer-worker|hermes-integration|planner-cli-smoke)/] },
  { id: "validation-and-smoke", patterns: [/^scripts\/(coderabbit-regression|e2e-queue-probe|extension-agent-dispatch|memory-bridge-policy|validate-agent-|test-|ui-runtime-smoke|webview-roundtrip-smoke|smoke-test|transport-audit|swarm-status|source-control-inventory|windows-notify)/, /^tools\//] },
  { id: "vault-policy", patterns: [/^scripts\/(vault-writer|obsidian-graph-audit|vault-direct-writes-policy|runtime-separation-policy|memory-cli|lint-wiki|cleanup-content|fix-decisions)/, /^src\/our\//, /^docs\/agent-os\/.*vault/i] },
  { id: "reviewer-swarm", patterns: [/^scripts\/deep-debug-swarm/, /^reports\/deep-debug-swarm\//, /^docs\/deep-debug-swarm\.md$/] },
  { id: "operating-docs", patterns: [/^docs\/(CONNECT_AI_DEPARTMENT_REGISTRY|agent-operating-model|antigravity-cli-setup|cli-health-runbook|connect-ai-control-plane-handoff.*|connect-ai-next-hardening|hermes-guardrails|parallel-work-policy|result-validation-policy|team-room-ui|transport-audit-runbook|validate-registry)\.md$/] },
  { id: "agent-os-docs", patterns: [/^docs\/agent-os\//, /^docs\/agent-prompts\//, /^AGENTS\.md$/] },
  { id: "reports-artifacts", patterns: [/^reports\//, /^docs\/agent-os\/preflight\//] },
  { id: "pipelines-and-domains", patterns: [/^(pipelines|youtube|us-execution|agent-coordinator)\//, /^scripts\/(youtube|lilys|everything-search)/] },
];

const CATEGORY_ACTIONS = {
  "extension-runtime": {
    action: "review-then-track",
    rationale: "Runtime extension/UI changes affect shipped behavior; inspect diffs and tests before staging.",
  },
  "agent-os-control-plane": {
    action: "review-then-track",
    rationale: "Control-plane scripts define dispatch, guards, and readiness; keep only verified code paths.",
  },
  "queue-worker": {
    action: "review-then-track",
    rationale: "Queue and worker files are core execution infrastructure; stage with focused tests.",
  },
  "executor-adapters": {
    action: "review-then-track",
    rationale: "Executor adapters are part of the multi-agent goal and should be versioned after smoke tests.",
  },
  "vault-policy": {
    action: "review-then-track",
    rationale: "Vault policy code is safety-critical; require policy tests before staging.",
  },
  "cli-health-and-routing": {
    action: "review-then-track",
    rationale: "Health/routing scripts support operational reliability; stage after CLI smoke coverage.",
  },
  "validation-and-smoke": {
    action: "track-or-merge-with-test-suite",
    rationale: "Validation scripts preserve evidence; keep useful checks and merge duplicates.",
  },
  "agent-os-docs": {
    action: "review-then-track",
    rationale: "Agent OS docs are operating contracts; keep current ones and avoid stale duplicate policy.",
  },
  "operating-docs": {
    action: "review-then-track",
    rationale: "Runbooks and handoffs are useful but should be deduplicated before staging.",
  },
  "reviewer-swarm": {
    action: "track-code-archive-run-reports",
    rationale: "Swarm code/docs are durable; generated run reports usually belong in runtime or ignored artifacts.",
  },
  "reports-artifacts": {
    action: "archive-runtime-or-ignore",
    rationale: "Generated reports should not normally be staged from repo reports unless chosen as fixtures.",
  },
  "pipelines-and-domains": {
    action: "domain-review",
    rationale: "Domain assets need owner review because they may affect YouTube/job/stock workflows.",
  },
  "repo-metadata": {
    action: "review-then-track",
    rationale: "Repo metadata can improve portability but should be checked for stale notes.",
  },
  "other": {
    action: "manual-triage",
    rationale: "No category matched; inspect individually before staging or archiving.",
  },
};

const REVIEW_BUNDLE_RULES = [
  {
    id: "queue-worker-core",
    title: "Queue and worker execution core",
    categories: ["queue-worker"],
    verificationCommands: [
      "node --test scripts/agent-queue.test.js scripts/queue-dispatcher.test.js scripts/run-queue.test.js scripts/run-queue-parallel.test.js",
      "node --test scripts/agent-mesh.test.js scripts/e2e-queue-probe.test.js scripts/no-write-monitor.test.js",
    ],
  },
  {
    id: "executor-adapters-and-swarm",
    title: "Gemini/Antigravity executor adapters and deep-debug swarm code",
    categories: ["executor-adapters", "reviewer-swarm"],
    excludePathPatterns: [/^reports\/deep-debug-swarm\//],
    verificationCommands: [
      "node --test scripts/deep-debug-swarm.test.js scripts/antigravity-reviewer.test.js scripts/gemini-executor.test.js scripts/deep-debug-swarm-synthesis.test.js",
      "Get-Content docs/agent-os/CEILING.md",
    ],
  },
  {
    id: "vault-policy-and-runtime-separation",
    title: "Vault policy and runtime separation guards",
    categories: ["vault-policy"],
    verificationCommands: [
      "node --test scripts/vault-writer.test.js scripts/vault-direct-writes-policy.test.js scripts/runtime-separation-policy.test.js",
      "node --test scripts/obsidian-graph-audit.test.js scripts/memory-bridge-policy.test.js",
    ],
  },
  {
    id: "control-plane-and-dispatch",
    title: "Agent OS control plane and dispatch contracts",
    categories: ["agent-os-control-plane"],
    verificationCommands: [
      "node --test scripts/agent-contracts.test.js scripts/mcp-task-dispatch.test.js scripts/extension-agent-dispatch.test.js",
      "node --test scripts/agent-policy.test.js scripts/blocked-triage.test.js scripts/blocked-closure.test.js",
    ],
  },
  {
    id: "cli-health-routing-and-readiness",
    title: "CLI health, routing, and readiness checks",
    categories: ["cli-health-and-routing"],
    verificationCommands: [
      "node --test scripts/cli-health-check.test.js scripts/connect-ai-readiness.test.js scripts/google-reviewer-worker.test.js",
      "node --test scripts/source-control-inventory.test.js scripts/planner-cli-smoke.test.js",
    ],
  },
  {
    id: "extension-ui-runtime",
    title: "VS Code extension, prompts, and webview runtime",
    categories: ["extension-runtime"],
    verificationCommands: [
      "npm run compile",
      "node --test scripts/ui-runtime-smoke.test.js scripts/webview-roundtrip-smoke.test.js",
    ],
  },
  {
    id: "docs-and-operating-contracts",
    title: "Agent OS docs, runbooks, and repo metadata",
    categories: ["agent-os-docs", "operating-docs", "repo-metadata"],
    verificationCommands: [
      "node --test scripts/agent-contracts.test.js",
      "node scripts/source-control-inventory.js",
    ],
  },
  {
    id: "validation-and-smoke-suite",
    title: "Validation, smoke, and regression harness scripts",
    categories: ["validation-and-smoke"],
    verificationCommands: [
      "node --test scripts/source-control-inventory.test.js scripts/coderabbit-regression.test.js",
      "node --test scripts/transport-audit.test.js scripts/swarm-status.test.js",
    ],
  },
];

const CRITICAL_SOURCE_CATEGORIES = new Set([
  "extension-runtime",
  "queue-worker",
  "agent-os-control-plane",
  "executor-adapters",
  "vault-policy",
  "cli-health-and-routing",
  "validation-and-smoke",
  "reviewer-swarm",
]);

function recommendationForCategory(category) {
  return CATEGORY_ACTIONS[category] || CATEGORY_ACTIONS.other;
}

function actionBucketForEntry(entry) {
  const normalized = normalizePath(entry?.path);
  const recommendation = recommendationForCategory(entry?.category);
  if (/^reports\/source-control-inventory\//.test(normalized)) return "archiveRuntimeOrIgnore";
  if (/^reports\/deep-debug-swarm\//.test(normalized)) return "archiveRuntimeOrIgnore";
  if (/^docs\/agent-os\/preflight\//.test(normalized)) return "ignoreCandidate";
  if (recommendation.action === "archive-runtime-or-ignore") return "archiveRuntimeOrIgnore";
  if (recommendation.action === "track-code-archive-run-reports") return "trackCandidate";
  if (recommendation.action === "domain-review") return "domainReview";
  if (recommendation.action === "manual-triage") return "manualTriage";
  return "trackCandidate";
}

function pushPlanItem(plan, bucket, entry) {
  plan[bucket].push({
    path: entry.path,
    status: entry.status,
    category: entry.category,
    tracked: entry.tracked,
  });
}

function buildActionPlan(entries) {
  const plan = {
    trackCandidate: [],
    archiveRuntimeOrIgnore: [],
    domainReview: [],
    manualTriage: [],
    ignoreCandidate: [],
  };
  for (const entry of entries || []) {
    pushPlanItem(plan, actionBucketForEntry(entry), entry);
  }
  return {
    counts: Object.fromEntries(Object.entries(plan).map(([bucket, items]) => [bucket, items.length])),
    buckets: plan,
    safety: [
      "No git add, git clean, git reset, file delete, or move was performed.",
      "Treat trackCandidate as review input, not automatic staging approval.",
      "Move/archive generated report files only after human approval.",
    ],
  };
}

function matchesBundleRule(entry, rule) {
  if (!rule.categories.includes(entry.category)) return false;
  const normalized = normalizePath(entry.path);
  if ((rule.excludePathPatterns || []).some((pattern) => pattern.test(normalized))) return false;
  return actionBucketForEntry(entry) === "trackCandidate";
}

function buildReviewBundles(entries) {
  const bundles = [];
  const assigned = new Set();
  for (const rule of REVIEW_BUNDLE_RULES) {
    const files = [];
    for (const entry of entries || []) {
      if (!matchesBundleRule(entry, rule)) continue;
      files.push({
        path: entry.path,
        status: entry.status,
        category: entry.category,
        tracked: entry.tracked,
      });
      assigned.add(entry.path);
    }
    if (!files.length) continue;
    bundles.push({
      id: rule.id,
      title: rule.title,
      fileCount: files.length,
      trackedDirtyCount: files.filter((file) => file.tracked).length,
      untrackedCount: files.filter((file) => !file.tracked).length,
      files,
      verificationCommands: rule.verificationCommands,
      recommendedNextAction: "review diff, run listed verification, then stage this bundle only if evidence passes",
    });
  }
  const unbundledTrackCandidates = (entries || [])
    .filter((entry) => actionBucketForEntry(entry) === "trackCandidate" && !assigned.has(entry.path))
    .map((entry) => ({ path: entry.path, status: entry.status, category: entry.category, tracked: entry.tracked }));
  return {
    bundles,
    counts: Object.fromEntries(bundles.map((bundle) => [bundle.id, bundle.fileCount])),
    unbundledTrackCandidates,
  };
}

function buildIntegrityGate(entries) {
  const criticalUntracked = (entries || [])
    .filter((entry) => !entry.tracked)
    .filter((entry) => CRITICAL_SOURCE_CATEGORIES.has(entry.category))
    .filter((entry) => actionBucketForEntry(entry) === "trackCandidate")
    .map((entry) => ({
      path: entry.path,
      status: entry.status,
      category: entry.category,
    }));
  const trackedDirty = (entries || [])
    .filter((entry) => entry.tracked)
    .filter((entry) => CRITICAL_SOURCE_CATEGORIES.has(entry.category))
    .map((entry) => ({
      path: entry.path,
      status: entry.status,
      category: entry.category,
    }));
  const ignoredArtifacts = (entries || [])
    .filter((entry) => ["archiveRuntimeOrIgnore", "ignoreCandidate"].includes(actionBucketForEntry(entry)))
    .map((entry) => ({
      path: entry.path,
      status: entry.status,
      category: entry.category,
    }));
  return {
    ok: criticalUntracked.length === 0,
    reason: criticalUntracked.length ? "CRITICAL_UNTRACKED_AGENT_OS_FILES" : "OK",
    criticalUntrackedCount: criticalUntracked.length,
    trackedDirtyCount: trackedDirty.length,
    ignoredArtifactCount: ignoredArtifacts.length,
    criticalUntracked,
    trackedDirty,
    ignoredArtifacts,
    guidance: criticalUntracked.length
      ? "Review and intentionally stage or archive critical Agent OS files; do not run git clean/reset/checkout."
      : "No critical untracked Agent OS source files detected by this gate.",
  };
}

function buildCriticalBundleSummary(entries, options = {}) {
  const limit = Number(options.limit || 5);
  const bundles = buildReviewBundles(entries).bundles;
  const priority = new Map(REVIEW_BUNDLE_RULES.map((rule, index) => [rule.id, index]));
  const criticalPaths = new Set(buildIntegrityGate(entries).criticalUntracked.map((entry) => entry.path));
  return bundles
    .map((bundle) => {
      const criticalFiles = bundle.files.filter((file) => criticalPaths.has(file.path));
      return {
        id: bundle.id,
        title: bundle.title,
        criticalUntrackedCount: criticalFiles.length,
        totalBundleFiles: bundle.fileCount,
        examples: criticalFiles.slice(0, 8).map((file) => file.path),
        nextCommand: bundle.verificationCommands[0] || "",
      };
    })
    .filter((bundle) => bundle.criticalUntrackedCount > 0)
    .sort((a, b) => (b.criticalUntrackedCount - a.criticalUntrackedCount) || ((priority.get(a.id) ?? 999) - (priority.get(b.id) ?? 999)))
    .slice(0, limit);
}

function normalizePath(filePath) {
  return String(filePath || "").replace(/\\/g, "/").replace(/^\.\//, "");
}

function classifyPath(filePath) {
  const normalized = normalizePath(filePath);
  for (const rule of CATEGORY_RULES) {
    if (rule.patterns.some((pattern) => pattern.test(normalized))) return rule.id;
  }
  return "other";
}

function parsePorcelainZ(output) {
  const parts = String(output || "").split("\0").filter(Boolean);
  const entries = [];
  for (let i = 0; i < parts.length; i += 1) {
    const record = parts[i];
    if (record.length < 4) continue;
    const status = record.slice(0, 2);
    const file = normalizePath(record.slice(3));
    let oldPath = null;
    if (/^[RC]/.test(status.trim()) || /[RC]$/.test(status.trim())) {
      oldPath = normalizePath(parts[i + 1] || "");
      if (oldPath) i += 1;
    }
    entries.push({
      status,
      path: file,
      oldPath,
      category: classifyPath(file),
      tracked: status !== "??",
    });
  }
  return entries;
}

function summarize(entries) {
  const categories = {};
  const statusCounts = {};
  for (const entry of entries) {
    categories[entry.category] = categories[entry.category] || { total: 0, tracked: 0, untracked: 0, statuses: {}, examples: [] };
    const bucket = categories[entry.category];
    bucket.total += 1;
    if (entry.tracked) bucket.tracked += 1;
    else bucket.untracked += 1;
    bucket.statuses[entry.status] = (bucket.statuses[entry.status] || 0) + 1;
    if (bucket.examples.length < 8) bucket.examples.push(entry.path);
    statusCounts[entry.status] = (statusCounts[entry.status] || 0) + 1;
  }
  return {
    total: entries.length,
    tracked: entries.filter((entry) => entry.tracked).length,
    untracked: entries.filter((entry) => !entry.tracked).length,
    statusCounts,
    categories: Object.fromEntries(Object.entries(categories).map(([category, data]) => [
      category,
      { ...data, recommendation: recommendationForCategory(category) },
    ])),
  };
}

function createInventory(options = {}) {
  const repoRoot = path.resolve(options.repoRoot || envPaths.repoRoot());
  const timeoutMs = Number(options.timeoutMs || 60000);
  const result = spawnSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 80 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    return {
      ok: false,
      reason: result.error?.message || result.stderr || `git_status_exit_${result.status}`,
      exitCode: result.status ?? 1,
      timedOut: Boolean(result.error && result.error.code === "ETIMEDOUT"),
      entries: [],
      summary: summarize([]),
    };
  }
  const entries = parsePorcelainZ(result.stdout);
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    repoRoot,
    command: "git status --porcelain=v1 -z --untracked-files=all",
    note: "Non-destructive inventory only. Do not clean, reset, checkout, or delete from this report.",
    entries,
    summary: summarize(entries),
    actionPlan: buildActionPlan(entries),
    reviewBundles: buildReviewBundles(entries),
    integrityGate: buildIntegrityGate(entries),
    criticalBundleSummary: buildCriticalBundleSummary(entries),
  };
}

function writeInventoryReport(inventory, options = {}) {
  const root = path.resolve(options.reportRoot || path.join(envPaths.companyDir(), "source-control-inventory"));
  const stamp = (options.stamp || new Date().toISOString()).replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const outDir = path.join(root, stamp);
  fs.mkdirSync(outDir, { recursive: true });
  const jsonPath = path.join(outDir, "inventory.json");
  const mdPath = path.join(outDir, "inventory.md");
  fs.writeFileSync(jsonPath, `${JSON.stringify(inventory, null, 2)}\n`, "utf8");
  fs.writeFileSync(mdPath, renderMarkdown(inventory), "utf8");
  return { outDir, jsonPath, mdPath };
}

function renderMarkdown(inventory) {
  const lines = [
    "# Source Control Inventory",
    "",
    `Generated: ${inventory.generatedAt || "n/a"}`,
    `Status: ${inventory.ok ? "OK" : "FAILED"}`,
    "",
    "## Summary",
    `- total: ${inventory.summary?.total ?? 0}`,
    `- tracked dirty: ${inventory.summary?.tracked ?? 0}`,
    `- untracked: ${inventory.summary?.untracked ?? 0}`,
    "",
  ];
  if (inventory.integrityGate) {
    lines.push("## Integrity Gate");
    lines.push(`- status: ${inventory.integrityGate.ok ? "OK" : "BLOCKED"}`);
    lines.push(`- reason: ${inventory.integrityGate.reason}`);
    lines.push(`- critical untracked: ${inventory.integrityGate.criticalUntrackedCount}`);
    lines.push(`- tracked dirty: ${inventory.integrityGate.trackedDirtyCount}`);
    lines.push(`- ignored artifacts: ${inventory.integrityGate.ignoredArtifactCount}`);
    lines.push(`- guidance: ${inventory.integrityGate.guidance}`);
    lines.push(`- examples: ${inventory.integrityGate.criticalUntracked?.slice(0, 12).map((item) => item.path).join(", ") || "none"}`);
    lines.push("");
  }
  if (inventory.criticalBundleSummary?.length) {
    lines.push("## Critical Bundle Queue");
    for (const bundle of inventory.criticalBundleSummary) {
      lines.push(`- ${bundle.id}: critical ${bundle.criticalUntrackedCount}/${bundle.totalBundleFiles}; verify: ${bundle.nextCommand}; examples: ${bundle.examples.join(", ")}`);
    }
    lines.push("");
  }
  lines.push(
    "## Action Plan",
  );
  for (const [bucket, items] of Object.entries(inventory.actionPlan?.buckets || {})) {
    lines.push(`### ${bucket}`);
    lines.push(`- count: ${items.length}`);
    const examples = items.slice(0, 12).map((item) => item.path).join(", ");
    lines.push(`- examples: ${examples || "none"}`);
    lines.push("");
  }
  lines.push(
    "## Review Bundles",
  );
  for (const bundle of inventory.reviewBundles?.bundles || []) {
    lines.push(`### ${bundle.id}`);
    lines.push(`- title: ${bundle.title}`);
    lines.push(`- files: ${bundle.fileCount} (tracked ${bundle.trackedDirtyCount}, untracked ${bundle.untrackedCount})`);
    lines.push(`- recommended next action: ${bundle.recommendedNextAction}`);
    lines.push(`- verification: ${bundle.verificationCommands.join(" | ")}`);
    lines.push(`- examples: ${bundle.files.slice(0, 12).map((item) => item.path).join(", ") || "none"}`);
    lines.push("");
  }
  if (inventory.reviewBundles?.unbundledTrackCandidates?.length) {
    lines.push("### unbundled-track-candidates");
    lines.push(`- count: ${inventory.reviewBundles.unbundledTrackCandidates.length}`);
    lines.push(`- examples: ${inventory.reviewBundles.unbundledTrackCandidates.slice(0, 12).map((item) => item.path).join(", ")}`);
    lines.push("");
  }
  lines.push(
    "## Categories",
  );
  for (const [category, data] of Object.entries(inventory.summary?.categories || {}).sort()) {
    lines.push(`### ${category}`);
    lines.push(`- total: ${data.total}`);
    lines.push(`- tracked: ${data.tracked}`);
    lines.push(`- untracked: ${data.untracked}`);
    lines.push(`- recommended action: ${data.recommendation?.action || "manual-triage"}`);
    lines.push(`- rationale: ${data.recommendation?.rationale || CATEGORY_ACTIONS.other.rationale}`);
    lines.push(`- examples: ${data.examples.join(", ") || "none"}`);
    lines.push("");
  }
  lines.push("## Safety");
  lines.push("- This is an inventory, not a cleanup plan.");
  lines.push("- Do not run git clean/reset/checkout from this report.");
  lines.push("- Promote or archive files only after human review of each category.");
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function main() {
  const inventory = createInventory();
  const reportRootArgIndex = process.argv.indexOf("--report-root");
  const reportRoot = reportRootArgIndex === -1 ? undefined : process.argv[reportRootArgIndex + 1];
  const failOnCriticalUntracked = process.argv.includes("--fail-on-critical-untracked");
  const files = writeInventoryReport(inventory, { reportRoot });
  console.log(JSON.stringify({ ok: inventory.ok, summary: inventory.summary, actionPlan: inventory.actionPlan?.counts || {}, reviewBundles: inventory.reviewBundles?.counts || {}, integrityGate: inventory.integrityGate, files }, null, 2));
  if (!inventory.ok) process.exit(1);
  if (failOnCriticalUntracked && inventory.integrityGate && !inventory.integrityGate.ok) process.exit(2);
}

if (require.main === module) main();

module.exports = {
  CATEGORY_RULES,
  REVIEW_BUNDLE_RULES,
  actionBucketForEntry,
  buildActionPlan,
  buildCriticalBundleSummary,
  buildIntegrityGate,
  buildReviewBundles,
  classifyPath,
  createInventory,
  parsePorcelainZ,
  recommendationForCategory,
  renderMarkdown,
  summarize,
  writeInventoryReport,
};
