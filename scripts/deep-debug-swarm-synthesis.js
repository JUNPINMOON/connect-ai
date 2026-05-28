#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const envPaths = require("./env-paths.js");

const repoRoot = envPaths.repoRoot();
const reportsRoot = path.join(repoRoot, "reports", "deep-debug-swarm");

const THEMES = [
  {
    id: "source-control-integrity",
    priority: "P0",
    title: "핵심 코드와 테스트가 대량 untracked 상태라 감사/롤백/배포 기준이 약하다",
    patterns: [/untracked|미추적|추적되지|git status|형상 관리|버전 관리/i],
    repair: [
      "현재 변경을 기능군별로 분류한다: extension/runtime, queue/worker, vault policy, reviewer swarm, reports.",
      "폐기 명령(git clean/reset)은 금지하고, 필요한 파일만 의도적으로 추적 대상으로 편입하거나 별도 보관 목록을 만든다.",
      "각 기능군별 targeted test를 붙여 작은 단위로 검증한다.",
    ],
  },
  {
    id: "transport-contract",
    priority: "P0",
    title: "chat -> planner -> queue -> worker 전송 계약과 JSON/transcript 파싱이 취약하다",
    patterns: [/transport|handoff|chat-to-worker|planner|JSON|transcript|파싱|전송|핸드오프/i],
    repair: [
      "planner 출력 스키마를 단일 계약으로 고정하고, markdown fence/전후 설명/trailing comma를 거부 또는 정규화한다.",
      "transcript JSONL은 line 단위 fault-tolerant parser로 읽고 marker/correlation id를 필수화한다.",
      "실제 chat 명령 1건이 queue item 1건으로 이어지는 read-only E2E probe를 유지한다.",
    ],
  },
  {
    id: "queue-safety",
    priority: "P0",
    title: "agent queue의 lock, copied recovery, ready_for_verification 전이가 핵심 위험이다",
    patterns: [/queue|agent-queue|lock|race|ready_for_verification|copied|blocked|재시도|락|큐/i],
    repair: [
      "queue 파일 쓰기는 단일 writer/lock으로 제한하고 stale lock 복구 조건을 테스트한다.",
      "executor는 DONE이 아니라 READY_FOR_VERIFICATION까지만 올리게 강제한다.",
      "blocked backlog는 자동 완료하지 말고 사람 승인/검증자 판정으로만 닫는다.",
    ],
  },
  {
    id: "runtime-vault-separation",
    priority: "P0",
    title: "runtime evidence와 Obsidian vault durable note 경계가 계속 오염 위험을 만든다",
    patterns: [/vault|Obsidian|runtime|verified\.md|decisions|frontmatter|memory|볼트|메모리/i],
    repair: [
      "ad hoc script의 vault 직접 쓰기를 금지하고 vault-writer 정책 경유만 허용한다.",
      "evidence dump는 runtime/reports에만 쓰고 durable note는 frontmatter 정책 검사를 통과해야 한다.",
      "verified 승격은 current-run evidence와 verifier 판정이 있을 때만 허용한다.",
    ],
  },
  {
    id: "extension-bundle-freshness",
    priority: "P1",
    title: "VS Code extension/webview bundle freshness와 Reload Window 의존성이 사용자 신뢰를 깎는다",
    patterns: [/stale|bundle|extension|webview|Reload Window|sidebar|dashboard|UI|런타임|익스텐션/i],
    repair: [
      "source bundle hash와 installed extension bundle hash를 비교하는 검증을 릴리즈 전 게이트로 둔다.",
      "UI 상태는 worker-status/health/report 경로에서 읽고 stale 표시를 명확히 한다.",
      "수정 후 compile과 실제 VS Code reload/smoke를 분리해 검증한다.",
    ],
  },
  {
    id: "windows-cli-process",
    priority: "P1",
    title: "Windows CLI shim, PowerShell policy, stderr noise 처리가 executor 안정성 병목이다",
    patterns: [/Windows|PowerShell|ExecutionPolicy|cmd|shim|stderr|stdout|ENOENT|Hang|timeout|타임아웃/i],
    repair: [
      "npm/cmd shim은 shell 옵션과 timeout/stdin 닫힘을 명시한다.",
      "PowerShell 스크립트는 -NoProfile -ExecutionPolicy Bypass 호출 규칙을 표준화한다.",
      "stderr 존재만으로 실패 처리하지 말고 exit code와 known warning filter를 함께 본다.",
    ],
  },
  {
    id: "local-llm-fallback",
    priority: "P2",
    title: "local LLM fallback은 안정화 전까지 짧은 분류용으로만 제한해야 한다",
    patterns: [/local LLM|Ollama|fallback|로컬 LLM|qwen|LM Studio/i],
    repair: [
      "기본 planner/executor 라우팅에서 local LLM을 제외하고 명시적 fallback으로만 둔다.",
      "fallback 사용 시 결과 source와 제한을 보고서에 표시한다.",
      "긴 컨텍스트/파일 판단은 Gemini/Antigravity/Codex/Claude 쪽으로 보낸다.",
    ],
  },
];

function getArg(argv, name, fallback = "") {
  const idx = argv.indexOf(`--${name}`);
  return idx === -1 ? fallback : (argv[idx + 1] || fallback);
}

function latestReportDirs(root = reportsRoot, limit = 2) {
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const fullPath = path.join(root, entry.name);
      return { fullPath, mtimeMs: fs.statSync(fullPath).mtimeMs };
    })
    .filter((entry) => fs.existsSync(path.join(entry.fullPath, "report.json")))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, limit)
    .map((entry) => entry.fullPath);
}

function readReport(reportDir) {
  const reportPath = path.join(reportDir, "report.json");
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  return { reportDir, reportPath, ...report };
}

function compactText(value, maxLen = 500) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > maxLen ? `${text.slice(0, maxLen)}...` : text;
}

function classifyReports(reports) {
  const findings = THEMES.map((theme) => ({
    id: theme.id,
    priority: theme.priority,
    title: theme.title,
    hits: 0,
    agents: [],
    evidence: [],
    repair: theme.repair,
  }));

  for (const source of reports) {
    for (const result of source.results || []) {
      const response = String(result.response || "");
      for (const finding of findings) {
        const theme = THEMES.find((candidate) => candidate.id === finding.id);
        if (!theme.patterns.some((pattern) => pattern.test(response))) continue;
        finding.hits += 1;
        finding.agents.push(result.id);
        finding.evidence.push({
          report: path.basename(source.reportDir),
          agent: result.id,
          provider: result.provider,
          observedModelLabel: result.observedModelLabel || "",
          excerpt: compactText(response),
        });
      }
    }
  }

  return findings
    .filter((finding) => finding.hits > 0)
    .sort((a, b) => {
      const priorityOrder = { P0: 0, P1: 1, P2: 2 };
      return (priorityOrder[a.priority] - priorityOrder[b.priority]) || (b.hits - a.hits) || a.id.localeCompare(b.id);
    });
}

function modelSummary(reports) {
  const rows = [];
  for (const source of reports) {
    for (const result of source.results || []) {
      rows.push({
        report: path.basename(source.reportDir),
        id: result.id,
        provider: result.provider,
        ok: Boolean(result.ok),
        source: result.source || "",
        direct: result.direct ?? null,
        fallbackUsed: result.fallbackUsed ?? null,
        requestedModelLabel: result.requestedModelLabel || "",
        observedModelLabel: result.observedModelLabel || "",
        modelSelectionEnforced: result.modelSelectionEnforced ?? null,
      });
    }
  }
  return {
    laneCount: rows.length,
    okCount: rows.filter((row) => row.ok).length,
    providers: [...new Set(rows.map((row) => row.provider).filter(Boolean))],
    observedModelLabels: [...new Set(rows.map((row) => row.observedModelLabel).filter(Boolean))],
    rows,
  };
}

function synthesize(reportDirs) {
  const reports = reportDirs.map(readReport);
  const summary = modelSummary(reports);
  const findings = classifyReports(reports);
  return {
    generatedAt: new Date().toISOString(),
    sourceReports: reports.map((report) => report.reportDir),
    modelSummary: summary,
    findings,
    nextRepairSlice: findings[0] ? {
      priority: findings[0].priority,
      findingId: findings[0].id,
      title: findings[0].title,
      recommendedStart: findings[0].repair[0],
    } : null,
  };
}

function toMarkdown(result) {
  const lines = [];
  lines.push("# Deep Debug Swarm Synthesis");
  lines.push("");
  lines.push(`Generated: ${result.generatedAt}`);
  lines.push("");
  lines.push("## Source Reports");
  for (const report of result.sourceReports) lines.push(`- ${report}`);
  lines.push("");
  lines.push("## Model Evidence");
  lines.push(`- lanes: ${result.modelSummary.okCount}/${result.modelSummary.laneCount} ok`);
  lines.push(`- providers: ${result.modelSummary.providers.join(", ")}`);
  lines.push(`- observed models: ${result.modelSummary.observedModelLabels.join(", ")}`);
  lines.push("");
  lines.push("## Prioritized Repair Items");
  for (const finding of result.findings) {
    lines.push(`### ${finding.priority} ${finding.id}`);
    lines.push(finding.title);
    lines.push(`- hits: ${finding.hits}`);
    lines.push(`- agents: ${[...new Set(finding.agents)].join(", ")}`);
    lines.push("- repair:");
    for (const item of finding.repair) lines.push(`  - ${item}`);
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

function main(argv = process.argv.slice(2)) {
  const reportsArg = getArg(argv, "reports", "");
  const reportDirs = reportsArg
    ? reportsArg.split(",").map((value) => path.resolve(value.trim())).filter(Boolean)
    : latestReportDirs(reportsRoot, Number(getArg(argv, "latest", "2")) || 2);
  const result = synthesize(reportDirs);
  const outDirArg = getArg(argv, "out-dir", "");
  if (outDirArg) {
    const outDir = path.resolve(outDirArg);
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, "synthesis.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
    fs.writeFileSync(path.join(outDir, "synthesis.md"), toMarkdown(result), "utf8");
    console.log(JSON.stringify({ success: true, outDir, findings: result.findings.length, nextRepairSlice: result.nextRepairSlice }, null, 2));
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
}

if (require.main === module) main();

module.exports = {
  THEMES,
  classifyReports,
  latestReportDirs,
  modelSummary,
  synthesize,
  toMarkdown,
};
