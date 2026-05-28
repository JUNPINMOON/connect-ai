#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const INPUT_PER_M = 0.43;
const OUTPUT_PER_M = 1.74;
const EST_INPUT_TOKENS = 2500;
const EST_OUTPUT_TOKENS = 900;

function isWsl() {
  return process.platform === "linux" && fs.existsSync("/mnt/c");
}

function currentWindowsUser() {
  try {
    return process.env.CONNECT_AI_WINDOWS_USER || process.env.USERNAME || process.env.USER || os.userInfo().username || path.basename(os.homedir());
  } catch {
    return process.env.CONNECT_AI_WINDOWS_USER || process.env.USERNAME || process.env.USER || path.basename(os.homedir());
  }
}

function storageRoot() {
  if (process.env.APPDATA) {
    return path.join(process.env.APPDATA, "Code", "User", "globalStorage", "connectailab.connect-ai-lab");
  }
  if (isWsl()) {
    const user = currentWindowsUser();
    return `/mnt/c/Users/${user}/AppData/Roaming/Code/User/globalStorage/connectailab.connect-ai-lab`;
  }
  return path.join(os.homedir(), ".connect-ai", "globalStorage", "connectailab.connect-ai-lab");
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function startOfWeek(date) {
  const day = date.getDay() || 7;
  const start = startOfDay(date);
  start.setDate(start.getDate() - day + 1);
  return start;
}

function isHermes(record) {
  return /hermes/i.test([
    record.actor,
    record.type,
    record.detail?.actor,
    record.detail?.tool,
    record.detail?.source,
  ].filter(Boolean).join(" "));
}

function estimate(count) {
  const inputCost = count * EST_INPUT_TOKENS / 1_000_000 * INPUT_PER_M;
  const outputCost = count * EST_OUTPUT_TOKENS / 1_000_000 * OUTPUT_PER_M;
  return {
    calls: count,
    estimated_input_tokens: count * EST_INPUT_TOKENS,
    estimated_output_tokens: count * EST_OUTPUT_TOKENS,
    estimated_cost_usd: Number((inputCost + outputCost).toFixed(4)),
  };
}

function main() {
  const auditPath = path.join(storageRoot(), "phase2", "audit-log.jsonl");
  const records = readJsonl(auditPath);
  const now = new Date();
  const todayStart = startOfDay(now).getTime();
  const weekStart = startOfWeek(now).getTime();
  const hermes = records.filter(isHermes);
  const today = hermes.filter((record) => Date.parse(record.ts || "") >= todayStart);
  const week = hermes.filter((record) => Date.parse(record.ts || "") >= weekStart);

  const byType = {};
  for (const record of hermes) {
    const key = `${record.type || "unknown"}:${record.decision || record.detail?.decision || "n/a"}`;
    byType[key] = (byType[key] || 0) + 1;
  }

  console.log(JSON.stringify({
    success: true,
    error: null,
    data: {
      audit_path: auditPath,
      audit_count: records.length,
      pricing_note: "Estimate only. Uses GLM-4.6 proxy rates: input $0.43/M, output $1.74/M, assumed 2500 input + 900 output tokens per Hermes audit event.",
      today: estimate(today.length),
      this_week: estimate(week.length),
      total: estimate(hermes.length),
      by_type: byType,
      recent_hermes_events: hermes.slice(-10).map((record) => ({
        ts: record.ts,
        type: record.type,
        decision: record.decision,
        actor: record.actor,
        detail: record.detail,
      })),
    },
  }, null, 2));
}

main();
