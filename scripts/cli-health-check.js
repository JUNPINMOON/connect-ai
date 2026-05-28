#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { AGENT_ROLES } = require("./agent-policy.js");
const envPaths = require("./env-paths.js");
const { latestAgyDiagnostic } = require("./antigravity-reviewer.js");

function isWsl() {
  return process.platform === "linux" && fs.existsSync("/mnt/c");
}

function storageRoot() {
  if (process.env.CONNECT_AI_AGENT_QUEUE) return path.dirname(envPaths.toNative(process.env.CONNECT_AI_AGENT_QUEUE));
  return path.dirname(envPaths.agentQueuePath());
}

function healthPath() {
  return path.join(storageRoot(), "worker-health.json");
}

function run(cmd, args, options = {}) {
  const started = Date.now();
  const result = spawnSync(cmd, args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: options.timeoutMs || 30000,
    shell: Boolean(options.shell),
    env: options.env || process.env,
    input: options.input,
  });
  return {
    exitCode: result.status ?? 1,
    timedOut: result.error && result.error.code === "ETIMEDOUT",
    stdout: String(result.stdout || "").trim(),
    stderr: String(result.stderr || result.error?.message || "").trim(),
    ms: Date.now() - started,
  };
}

function quoteCmdArg(value) {
  const text = String(value);
  if (!/[ "'&()<>^|]/.test(text)) return text;
  return `"${text.replace(/"/g, '\\"')}"`;
}

function runPathCli(cmd, args, options = {}) {
  if (process.platform === "win32" && !/[\\/]/.test(cmd)) {
    return run("cmd.exe", ["/d", "/s", "/c", [cmd, ...args].map(quoteCmdArg).join(" ")], {
      ...options,
      shell: false,
    });
  }
  return run(cmd, args, { ...options, shell: false });
}

function classify(result, okPattern = /./) {
  const output = `${result.stdout}\n${result.stderr}`;
  if (result.timedOut) return "TIMEOUT";
  if (/not recognized|not found|could not be found|ENOENT/i.test(output)) return "CLI_MISSING";
  if (/auth|login|sign in|not logged|consent|unauthorized|expired/i.test(output)) return "AUTH_EXPIRED";
  if (/rate|quota|429|limit/i.test(output)) return "RATE_LIMITED";
  if (result.exitCode !== 0) return "UNKNOWN";
  if (okPattern && !okPattern.test(output)) return "BROKEN_OUTPUT";
  return "READY";
}

function checkCodex() {
  const result = runPathCli("codex", ["--version"]);
  return { status: classify(result, /\d/), detail: result.stdout || result.stderr, latencyMs: result.ms };
}

function checkClaude() {
  let result = runPathCli("claude", ["--version"], { timeoutMs: 20000 });
  if (result.exitCode !== 0 && process.platform === "win32") {
    result = run("wsl", ["bash", "-lc", "claude --version"], { timeoutMs: 30000 });
  }
  return { status: classify(result, /\d/), detail: result.stdout || result.stderr, latencyMs: result.ms };
}

function checkGemini() {
  const env = { ...process.env };
  delete env.GEMINI_API_KEY;
  const result = runPathCli("gemini", ["--version"], { env, timeoutMs: 20000 });
  return { status: classify(result, /\d/), detail: result.stdout || result.stderr, latencyMs: result.ms };
}

function checkAntigravity() {
  const agy = process.platform === "win32" && process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, "agy", "bin", "agy.exe")
    : "agy";
  const result = run(agy, ["--version"], { timeoutMs: 20000 });
  const status = classify(result, /\d/);
  const diagnostic = latestAgyDiagnostic(undefined, Date.now() - 24 * 60 * 60 * 1000);
  if (status === "READY" && diagnostic.status === "RATE_LIMITED") {
    return {
      status: "RATE_LIMITED",
      detail: `${result.stdout || result.stderr}; direct agy print recently hit quota: ${diagnostic.message}`,
      latencyMs: result.ms,
    };
  }
  if (status === "READY" && diagnostic.status === "AUTH_EXPIRED") {
    return {
      status: "AUTH_EXPIRED",
      detail: `${result.stdout || result.stderr}; direct agy print recently had auth issue: ${diagnostic.message}`,
      latencyMs: result.ms,
    };
  }
  return { status, detail: result.stdout || result.stderr, latencyMs: result.ms };
}

function checkHermes() {
  let result = runPathCli("hermes", ["--version"], { timeoutMs: 15000 });
  if (result.exitCode !== 0 && process.platform === "win32") {
    result = run("wsl", ["bash", "-lc", "command -v hermes >/dev/null && hermes --version || true"], { timeoutMs: 20000 });
  }
  return { status: result.stdout || result.stderr ? classify(result, /hermes|\d|\/home|\.local/i) : "CLI_MISSING", detail: result.stdout || result.stderr, latencyMs: result.ms };
}

function main() {
  const checks = {
    codex: checkCodex(),
    claude: checkClaude(),
    gemini: checkGemini(),
    antigravity: checkAntigravity(),
    hermes: checkHermes(),
  };
  const now = new Date().toISOString();
  const payload = {
    generatedAt: now,
    agents: Object.fromEntries(Object.entries(checks).map(([agent, check]) => [agent, {
      agent,
      workerClass: (AGENT_ROLES[agent] || {}).workerClass || "worker",
      ...check,
      updatedAt: now,
    }])),
  };
  fs.mkdirSync(path.dirname(healthPath()), { recursive: true });
  fs.writeFileSync(healthPath(), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ success: true, path: healthPath(), ...payload }, null, 2));
}

if (require.main === module) main();

module.exports = { classify, quoteCmdArg };
