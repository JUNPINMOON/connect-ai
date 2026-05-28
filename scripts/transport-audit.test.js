const test = require("node:test");
const assert = require("node:assert/strict");
const { riskFindings, formatHuman } = require("./transport-audit.js");

function baseAudit(overrides = {}) {
  return {
    package: {
      plannerProviderDefault: "antigravity",
      localLlmEnabledDefault: false,
    },
    queue: {
      file: { exists: true },
      count: 0,
      counts: {
        queued: 0,
        copied: 0,
        running: 0,
        blocked: 0,
        ready_for_verification: 0,
        done: 0,
      },
      activeSample: [],
    },
    blockedTriage: {
      success: true,
      totalBlocked: 0,
      buckets: {},
      recommendations: {},
      candidateCounts: {
        verifiedArchiveCandidates: 0,
        retryCandidates: 0,
        userDecisionRequired: 0,
        evidenceOnly: 0,
      },
    },
    blockedRetryPlan: {
      success: true,
      plannedCount: 0,
      backlogCount: 0,
      backlogCutoffHours: 6,
      plans: [],
      backlog: [],
    },
    sourcePolicy: {
      classifierLocalLlmGuarded: true,
    },
    userSettings: [],
    lock: {
      file: { exists: false },
      ageMs: null,
    },
    workers: {
      status: {},
      healthAgents: {},
    },
    bundle: {
      installs: [
        { dir: "vscode", bundleFile: { exists: true }, matchesSourceBundle: true },
      ],
    },
    dryRun: {
      exitCode: 0,
    },
    webviewRoundtrip: {
      success: true,
      failedChecks: [],
      checkCount: 9,
    },
    verificationDispatch: {
      success: true,
      readyForVerificationCount: 0,
      plannedCount: 0,
      activeVerifierCount: 0,
    },
    uiRuntime: {
      success: true,
      failedChecks: [],
      checkCount: 2,
      sidebarChipText: "Planner: Gemini fallback",
      antigravityClass: "office-person blocked office-person-antigravity",
    },
    swarmStatus: {
      reportCount: 1,
      expectedCount: 12,
      coveredCount: 12,
      coverageOk: true,
      freshnessOk: true,
      newestReportAgeHours: 1,
      maxAgeHours: 24,
      missingIds: [],
      antigravity: {
        expected: 6,
        covered: 6,
        directSuccesses: 0,
        fallbackSuccesses: 6,
      },
      sourceCounts: {
        gemini: 6,
        "gemini-fallback": 6,
      },
      actionItemCount: 1,
      topActionItems: [
        {
          id: "gemini-transport",
          domain: "chat-to-worker transport",
          recommendation: "queue runner action bridge를 유지한다.",
          verificationCommand: "npm run agent:transport-audit",
        },
      ],
    },
    plannerCliSmoke: null,
    antigravityQuota: {
      source: "user_relogin_paid_account_2026-05-28",
      liveCliQuotaApi: false,
      refreshWindow: "5h rolling window",
      overages: "OFF",
      models: [
        { model: "Claude Sonnet 4.6", remaining: "full" },
        { model: "Claude Opus 4.6", remaining: "full" },
        { model: "Gemini 3.1 Pro", remaining: "full" },
        { model: "Gemini 3.5 Flash", remaining: "full" },
        { model: "GPT-OSS 120B", remaining: "full" },
      ],
    },
    findings: [],
    ...overrides,
  };
}

test("transport audit flags local LLM default and stale installed bundle", () => {
  const findings = riskFindings(baseAudit({
    package: {
      plannerProviderDefault: "local",
      localLlmEnabledDefault: true,
    },
    bundle: {
      installs: [
        { dir: "vscode", bundleFile: { exists: true }, matchesSourceBundle: false },
      ],
    },
  }));
  assert.equal(findings.some((finding) => finding.code === "LOCAL_LLM_DEFAULT_ENABLED"), true);
  assert.equal(findings.some((finding) => finding.code === "PLANNER_NOT_ANTIGRAVITY"), true);
  assert.equal(findings.some((finding) => finding.code === "INSTALLED_BUNDLE_STALE"), true);
});

test("transport audit flags failed planner CLI smoke when enabled", () => {
  const findings = riskFindings(baseAudit({
    plannerCliSmoke: {
      success: false,
      source: "",
      exitCode: 1,
      reason: "NO_TASKS_JSON",
      taskCount: 0,
    },
  }));
  assert.equal(findings.some((finding) => finding.code === "PLANNER_CLI_SMOKE_FAILED"), true);
});

test("transport audit reports Antigravity quota fallback without fatal direct coverage gate", () => {
  const findings = riskFindings(baseAudit({
    workers: {
      status: {},
      healthAgents: {
        antigravity: { status: "RATE_LIMITED" },
      },
    },
    plannerCliSmoke: {
      success: true,
      source: "gemini-fallback",
      directStatus: "RATE_LIMITED",
      exitCode: 0,
      reason: "",
      taskCount: 1,
    },
  }));
  assert.equal(findings.some((finding) => finding.code === "ANTIGRAVITY_DIRECT_RATE_LIMITED" && finding.severity === "P2"), true);
  assert.equal(findings.some((finding) => finding.code === "PLANNER_USING_GEMINI_FALLBACK_FOR_ANTIGRAVITY_QUOTA" && finding.severity === "P2"), true);
  assert.equal(findings.some((finding) => finding.code === "ANTIGRAVITY_DIRECT_COVERAGE_MISSING" && finding.severity === "P0"), false);
  assert.equal(findings.some((finding) => finding.code === "ANTIGRAVITY_DIRECT_COVERAGE_MISSING" && finding.severity === "P2"), true);
});

test("transport audit labels old Antigravity fallback evidence as historical", () => {
  const text = formatHuman(baseAudit({
    swarmStatus: {
      reportCount: 31,
      expectedCount: 12,
      coveredCount: 12,
      coverageOk: true,
      freshnessOk: true,
      newestReportAgeHours: 1,
      maxAgeHours: 24,
      missingIds: [],
      antigravity: {
        expected: 6,
        covered: 6,
        directSuccesses: 6,
        fallbackSuccesses: 6,
      },
      modelDiversity: {
        observedCount: 4,
        minimumFourModelTargetMet: true,
        observedModels: [],
      },
      sourceCounts: {},
      actionItemCount: 1,
      topActionItems: [],
    },
  }));

  assert.match(text, /antigravity direct=6/);
  assert.match(text, /historicalFallback=6/);
  assert.doesNotMatch(text, /, fallback=6\)/);
});

test("transport audit surfaces ready_for_verification backlog for S7 verifier dispatch", () => {
  const audit = baseAudit({
    queue: {
      file: { exists: true },
      count: 12,
      counts: {
        queued: 0,
        copied: 0,
        running: 0,
        blocked: 2,
        ready_for_verification: 10,
        done: 0,
      },
      activeSample: [],
    },
    verificationDispatch: {
      success: true,
      readyForVerificationCount: 10,
      plannedCount: 10,
      activeVerifierCount: 0,
    },
  });
  const text = formatHuman(audit);
  const findings = riskFindings(audit);

  assert.match(text, /ready_for_verification 10/);
  assert.match(text, /verification backlog: 10 ready_for_verification/);
  assert.equal(findings.some((finding) => finding.code === "S7_VERIFICATION_BACKLOG_PENDING"), true);
});

test("transport audit does not ask to enqueue verifier tasks when they already exist", () => {
  const audit = baseAudit({
    queue: {
      file: { exists: true },
      count: 22,
      counts: {
        queued: 10,
        copied: 0,
        running: 0,
        blocked: 2,
        ready_for_verification: 10,
        done: 0,
      },
      activeSample: [],
    },
    verificationDispatch: {
      success: true,
      readyForVerificationCount: 10,
      plannedCount: 0,
      activeVerifierCount: 10,
    },
  });
  const text = formatHuman(audit);
  const findings = riskFindings(audit);

  assert.match(text, /verification backlog: 10 ready_for_verification item\(s\); 10 verifier task\(s\) already queued\/active/);
  assert.doesNotMatch(text, /run npm run agent:verify-dispatch -- --execute/);
  assert.equal(findings.some((finding) => finding.code === "S7_VERIFICATION_BACKLOG_PENDING"), false);
});

test("transport audit flags incomplete deep-debug swarm coverage as advisory", () => {
  const findings = riskFindings(baseAudit({
    swarmStatus: {
      reportCount: 1,
      expectedCount: 12,
      coveredCount: 8,
      coverageOk: false,
      missingIds: ["antigravity-policy-gates"],
      antigravity: {
        expected: 6,
        covered: 2,
        directSuccesses: 0,
        fallbackSuccesses: 2,
      },
      sourceCounts: {},
    },
  }));
  const finding = findings.find((item) => item.code === "DEEP_DEBUG_SWARM_COVERAGE_INCOMPLETE");
  assert.equal(finding?.severity, "P2");
});

test("transport audit flags stale deep-debug swarm reports as advisory", () => {
  const findings = riskFindings(baseAudit({
    swarmStatus: {
      reportCount: 1,
      expectedCount: 12,
      coveredCount: 12,
      coverageOk: true,
      freshnessOk: false,
      newestReportAgeHours: 49,
      maxAgeHours: 24,
      missingIds: [],
      antigravity: {
        expected: 6,
        covered: 6,
        directSuccesses: 0,
        fallbackSuccesses: 6,
      },
      sourceCounts: {},
    },
  }));
  const finding = findings.find((item) => item.code === "DEEP_DEBUG_SWARM_REPORT_STALE");
  assert.equal(finding?.severity, "P2");
});

test("transport audit flags fresh covered swarm reports without actionable extraction", () => {
  const findings = riskFindings(baseAudit({
    swarmStatus: {
      reportCount: 1,
      expectedCount: 12,
      coveredCount: 12,
      coverageOk: true,
      freshnessOk: true,
      newestReportAgeHours: 1,
      maxAgeHours: 24,
      missingIds: [],
      antigravity: {
        expected: 6,
        covered: 6,
        directSuccesses: 0,
        fallbackSuccesses: 6,
      },
      sourceCounts: {},
      actionItemCount: 0,
      topActionItems: [],
    },
  }));
  const finding = findings.find((item) => item.code === "DEEP_DEBUG_SWARM_ACTIONS_MISSING");
  assert.equal(finding?.severity, "P2");
});

test("transport audit flags broken webview roundtrip contract", () => {
  const findings = riskFindings(baseAudit({
    webviewRoundtrip: {
      success: false,
      failedChecks: ["sidebar_prompt_corporate_true"],
      checkCount: 9,
    },
  }));
  assert.equal(findings.some((finding) => finding.code === "WEBVIEW_ROUNDTRIP_CONTRACT_BROKEN"), true);
});

test("transport audit flags broken UI runtime state", () => {
  const findings = riskFindings(baseAudit({
    uiRuntime: {
      success: false,
      failedChecks: ["dashboard_runtime_antigravity_quota"],
      checkCount: 2,
    },
  }));
  assert.equal(findings.some((finding) => finding.code === "UI_RUNTIME_STATE_BROKEN"), true);
});

test("transport audit flags user settings that re-enable local routing", () => {
  const findings = riskFindings(baseAudit({
    userSettings: [
      {
        app: "vscode",
        plannerProvider: "local",
        localLlmEnabled: true,
        defaultModel: "gpt-oss:20b-vibe",
      },
    ],
  }));
  assert.equal(findings.some((finding) => finding.code === "USER_LOCAL_LLM_ENABLED"), true);
  assert.equal(findings.some((finding) => finding.code === "USER_PLANNER_LOCAL"), true);
  assert.equal(findings.some((finding) => finding.code === "USER_HEAVY_LOCAL_MODEL_SELECTED"), true);
});

test("transport audit flags unguarded local LLM classifier path", () => {
  const findings = riskFindings(baseAudit({
    sourcePolicy: {
      classifierLocalLlmGuarded: false,
    },
  }));
  assert.equal(findings.some((finding) => finding.code === "CLASSIFIER_LOCAL_LLM_UNGUARDED"), true);
});

test("transport audit flags stale locks and dry-run failures", () => {
  const findings = riskFindings(baseAudit({
    lock: {
      file: { exists: true },
      ageMs: 61000,
    },
    dryRun: {
      exitCode: 1,
    },
  }));
  assert.equal(findings.some((finding) => finding.code === "STALE_QUEUE_LOCK"), true);
  assert.equal(findings.some((finding) => finding.code === "RUN_QUEUE_DRY_RUN_FAILED"), true);
});

test("transport audit flags blocked triage failures", () => {
  const findings = riskFindings(baseAudit({
    blockedTriage: {
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
    },
  }));
  assert.equal(findings.some((finding) => finding.code === "BLOCKED_TRIAGE_FAILED"), true);
});

test("transport audit separates retry candidates from executable retry plan", () => {
  const text = formatHuman(baseAudit({
    blockedTriage: {
      success: true,
      totalBlocked: 20,
      buckets: { retry_after_health_check: 1 },
      recommendations: { retry_only_after_ready_health: 1 },
      candidateCounts: {
        verifiedArchiveCandidates: 5,
        retryCandidates: 1,
        userDecisionRequired: 18,
        evidenceOnly: 1,
      },
    },
    blockedRetryPlan: {
      success: true,
      plannedCount: 0,
      backlogCount: 1,
      backlogCutoffHours: 6,
      plans: [],
      backlog: [
        {
          id: "aq-old",
          assignee: "antigravity",
          ageHours: 8.8,
          reason: "blocked_backlog_stale_8.8h_gt_6h",
        },
      ],
    },
  }));

  assert.match(text, /blocked triage: total 20, archiveCandidates=5, retryCandidates=1/);
  assert.match(text, /blocked retry plan: planned=0, backlog=1, cutoff=6h/);
  assert.match(text, /aq-old/);
});
