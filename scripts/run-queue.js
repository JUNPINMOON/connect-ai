#!/usr/bin/env node
"use strict";

// run-queue.js — Connect AI 통합 큐 러너
// Hermes를 루프 드라이버로 쓰지 않고, claude-worker/codex-worker로 직접 처리한다.
// 한 번에 하나씩 claim되므로 작업 간 겹침이 없다.
//
// Usage:
//   node scripts/run-queue.js              (dry-run: 무엇을 돌릴지만 표시)
//   node scripts/run-queue.js --execute    (실제 실행)
//   node scripts/run-queue.js --execute --max 5   (최대 5개까지)
//   node scripts/run-queue.js --execute --only codex   (codex만)

const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { canAssigneeRun, hasAutomationContract, normalizeQueueItem } = require("./agent-policy.js");

const repoRoot = path.resolve(__dirname, "..");
const queueCli = path.join(__dirname, "agent-queue.js");
const claudeWorker = path.join(__dirname, "claude-worker.js");
const codexWorker = path.join(__dirname, "codex-worker.js");
const googleReviewerWorker = path.join(__dirname, "google-reviewer-worker.js");
const geminiWorker = path.join(__dirname, "gemini-worker.js");
const localLlmWorker = path.join(__dirname, "local-llm-worker.js");

function getArg(name, fallback = "") {
  const idx = process.argv.indexOf("--" + name);
  if (idx === -1) return fallback;
  return process.argv[idx + 1] || fallback;
}
function getMultiArg(name) {
  const values = [];
  for (let i = 0; i < process.argv.length; i += 1) {
    if (process.argv[i] === "--" + name && process.argv[i + 1]) values.push(process.argv[i + 1]);
  }
  return values;
}
function hasFlag(name) { return process.argv.includes("--" + name); }

const isLinux = process.platform === "linux";

// Windows 경로를 WSL 경로로 변환 (claude 작업을 WSL node로 돌릴 때 사용)
function toWslPath(p) {
  const m = String(p).match(/^([A-Za-z]):[\\/](.*)$/);
  if (!m) return String(p).replace(/\\/g, "/");
  return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, "/")}`;
}

// script를 실행한다. opts.viaWsl이면 WSL node로 실행(claude 작업용).
// run-queue가 Windows에서 돌더라도 claude 계열은 WSL에서 완결되게 하여
// "Windows node -> WSL claude" 이중 hop의 불안정을 제거한다.
function runJson(script, args, opts = {}) {
  if (opts.viaWsl && !isLinux) {
    // Windows에서 WSL node로 worker 실행
    const wslScript = toWslPath(script);
    const wslArgs = args.map((a) => "'" + String(a).replace(/'/g, "'\\''") + "'").join(" ");
    const wslRepo = toWslPath(repoRoot);
    const shellCmd = `cd '${wslRepo}' && node '${wslScript}' ${wslArgs}`;
    try {
      const out = execFileSync("wsl", ["bash", "-lc", shellCmd], {
        env: process.env, encoding: "utf8", maxBuffer: 20 * 1024 * 1024,
      });
      // WSL stdout에 로그가 섞일 수 있으니 마지막 JSON 블록만 파싱
      return parseLastJson(out);
    } catch (error) {
      if (error.stdout) return parseLastJson(error.stdout);
      throw error;
    }
  }
  try {
    const out = execFileSync(process.execPath, [script, ...args], {
      cwd: repoRoot, env: process.env, encoding: "utf8", maxBuffer: 20 * 1024 * 1024,
    });
    return parseLastJson(out);
  } catch (error) {
    if (error.stdout) return parseLastJson(error.stdout);
    throw error;
  }
}

// stdout에서 마지막 유효 JSON 객체를 추출(앞에 로그가 섞여도 안전)
function parseLastJson(text) {
  const s = String(text).trim();
  try { return JSON.parse(s); } catch { /* 아래로 */ }
  // 마지막 '{'부터 끝까지 시도
  const lastBrace = s.lastIndexOf("\n{");
  if (lastBrace >= 0) {
    try { return JSON.parse(s.slice(lastBrace + 1)); } catch { /* */ }
  }
  // 첫 '{'부터
  const firstBrace = s.indexOf("{");
  if (firstBrace >= 0) {
    try { return JSON.parse(s.slice(firstBrace)); } catch { /* */ }
  }
  throw new Error("runJson: JSON 파싱 실패: " + s.slice(0, 200));
}

function listQueued() {
  const q = runJson(queueCli, ["list"]);
  return (q.items || []).filter((it) => it.status === "queued");
}

function isVerifierTask(item = {}) {
  return item.role === "verifier" || item.intent === "verification" || /^Verification request:/i.test(String(item.title || ""));
}

function workerScriptFor(item = {}) {
  if ((item.assignee === "gemini" || item.assignee === "antigravity") && isVerifierTask(item)) return googleReviewerWorker;
  if (item.assignee === "codex") return codexWorker;
  if (item.assignee === "claude") return claudeWorker;
  if (item.assignee === "local-llm") return localLlmWorker;
  if (item.assignee === "gemini") return geminiWorker;
  return googleReviewerWorker;
}

function workerRunFailed(item = {}) {
  const status = String(item.status || "").toLowerCase();
  return item.success === false || status === "blocked" || status === "failed";
}

function main() {
  const execute = hasFlag("execute");
  const only = getArg("only", "");          // "" | "codex" | "claude" | "gemini" | "antigravity" | "local-llm"
  const taskId = getArg("id", "");
  const max = parseInt(getArg("max", "10"), 10) || 10;
  const codexModel = getArg("codex-model", "");
  const claudeTimeout = getArg("claude-timeout-ms", "180000");
  const claudeMaxTurns = getArg("claude-max-turns", "20");
  const codexTimeout = getArg("codex-timeout-ms", "600000");
  const executorCommand = getArg("executor-command", "");
  const executorArgs = getMultiArg("executor-arg");

  const results = [];
  let processed = 0;

  while (processed < max) {
    const queued = listQueued();
    // hermes(사람 결정 필요) 작업과 Decision request는 자동 실행 대상에서 제외
    const auto = queued
      .filter(hasAutomationContract)
      .map(normalizeQueueItem)
      .filter((it) =>
        (it.assignee === "claude" || it.assignee === "codex" || it.assignee === "gemini" || it.assignee === "antigravity" || it.assignee === "local-llm") &&
        !/^Decision request:/i.test(it.title || "") &&
        canAssigneeRun(it, it.assignee).ok
      );
    if (only) {
      for (let i = auto.length - 1; i >= 0; i -= 1) if (auto[i].assignee !== only) auto.splice(i, 1);
    }
    if (taskId) {
      for (let i = auto.length - 1; i >= 0; i -= 1) if (auto[i].id !== taskId) auto.splice(i, 1);
    }
    // 우선순위 정렬
    const rank = { P0: 0, P1: 1, P2: 2 };
    auto.sort((a, b) => (rank[a.priority] ?? 9) - (rank[b.priority] ?? 9) ||
      String(a.createdAt).localeCompare(String(b.createdAt)));

    const next = auto[0];
    if (!next) break;

    if (!execute) {
      results.push({ dryRun: true, assignee: next.assignee, priority: next.priority, title: next.title });
      // dry-run에서는 무한루프 방지 위해 한 종류씩만 미리보기
      const seen = new Set();
      for (const it of auto) {
        if (!seen.has(it.id)) { seen.add(it.id); }
      }
      results.length = 0;
      auto.forEach((it) => results.push({ dryRun: true, assignee: it.assignee, priority: it.priority, title: it.title, id: it.id }));
      break;
    }

    // 실제 실행: assignee에 맞는 worker
    let res;
    const workerScript = workerScriptFor(next);
    if (workerScript === codexWorker) {
      const args = ["--worker", "codex-run-queue", "--timeout-ms", codexTimeout];
      args.push("--id", next.id);
      if (codexModel) args.push("--model", codexModel);
      res = runJson(codexWorker, args);
    } else if (workerScript === claudeWorker) {
      // claude CLI는 WSL에 있으므로 worker도 WSL node로 실행(이중 hop 제거).
      res = runJson(claudeWorker, ["--worker", "claude-run-queue", "--max-turns", claudeMaxTurns,
        "--permission-mode", "default", "--timeout-ms", claudeTimeout, "--id", next.id],
        { viaWsl: true });
    } else if (workerScript === localLlmWorker) {
      res = runJson(localLlmWorker, ["--worker", "local-llm-run-queue", "--id", next.id]);
    } else if (workerScript === geminiWorker) {
      const args = ["--worker", "gemini-run-queue", "--id", next.id];
      if (executorCommand) args.push("--executor-command", executorCommand);
      for (const executorArg of executorArgs) args.push("--executor-arg", executorArg);
      res = runJson(geminiWorker, args);
    } else {
      res = runJson(googleReviewerWorker, ["--assignee", next.assignee, "--worker", `${next.assignee}-run-queue`, "--id", next.id]);
    }
    results.push({
      assignee: next.assignee, title: (res.task && res.task.title) || next.title,
      status: res.status, success: res.success,
    });
    processed += 1;
    if (!res.claimed && res.claimed !== undefined) break; // 더 claim할 게 없음
  }

  const output = {
    mode: execute ? "execute" : "dry-run",
    processed,
    results,
  };
  console.log(JSON.stringify(output, null, 2));
  if (execute && results.some(workerRunFailed)) process.exit(1);
}

if (require.main === module) {
  try { main(); }
  catch (e) { console.log(JSON.stringify({ success: false, error: String(e.message) }, null, 2)); process.exit(1); }
}

module.exports = {
  isVerifierTask,
  workerRunFailed,
  workerScriptFor,
};
