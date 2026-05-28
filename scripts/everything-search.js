#!/usr/bin/env node
"use strict";

const { execFile } = require("node:child_process");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");
const wrapperWin = "C:\\Users\\mjb58\\antigravity-projects\\connect-ai\\tools\\es-search.ps1";

function parseArgs(argv) {
  const args = {
    query: "",
    ext: "",
    path: "",
    limit: 30,
    sort: "name",
    regex: false,
    count: false,
    includeTemp: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    const next = argv[index + 1];
    if (item === "--query" || item === "-q") {
      args.query = String(next || "");
      index += 1;
    } else if (item === "--ext") {
      args.ext = String(next || "");
      index += 1;
    } else if (item === "--path") {
      args.path = String(next || "");
      index += 1;
    } else if (item === "--limit") {
      args.limit = Math.max(1, Math.min(100, Number(next || 30) || 30));
      index += 1;
    } else if (item === "--sort") {
      args.sort = ["name", "date", "size"].includes(next) ? next : "name";
      index += 1;
    } else if (item === "--regex") {
      args.regex = true;
    } else if (item === "--count") {
      args.count = true;
    } else if (item === "--include-temp") {
      args.includeTemp = true;
    } else if (!item.startsWith("-") && !args.query) {
      args.query = item;
    }
  }

  return args;
}

function run(command, args) {
  return new Promise((resolve) => {
    execFile(command, args, {
      cwd: repoRoot,
      windowsHide: true,
      maxBuffer: 20 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      const exitCode = error && typeof error.code === "number" ? error.code : 0;
      resolve({
        ok: !error,
        exitCode,
        stdout,
        stderr,
        text: stdout || stderr || (error ? error.message : ""),
      });
    });
  });
}

async function runPowerShell(args) {
  const candidates = process.platform === "linux" ? ["pwsh.exe", "powershell.exe"] : ["pwsh", "powershell.exe"];
  let lastResult = null;
  for (const command of candidates) {
    const result = await run(command, args);
    lastResult = result;
    if (result.ok || !/ENOENT|not found|not recognized/i.test(result.text)) return result;
  }
  return lastResult;
}

function redact(text) {
  return String(text || "")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi, "Bearer ***")
    .replace(/\b(?:password|token|cookie|authorization)\b\s*[:=]\s*("[^"]+"|'[^']+'|[^\s,;}]+)/gi, "$1=***");
}

function parseResult(text, count) {
  const clean = String(text || "").trim();
  if (count) return { count: Number(clean) || 0, results: [] };
  if (!clean) return { count: 0, results: [] };
  try {
    const parsed = JSON.parse(clean);
    const results = Array.isArray(parsed) ? parsed.map(String) : [parsed].filter((item) => item !== null && item !== undefined).map(String);
    return { count: results.length, results };
  } catch {
    const results = clean.split(/\r?\n/).filter(Boolean);
    return { count: results.length, results };
  }
}

function filterResults(results, includeTemp) {
  if (includeTemp) return results;
  return results.filter((item) => !/[\\/]AppData[\\/]Local[\\/]Temp[\\/]/i.test(item));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.query && !args.ext && !args.path) {
    console.log(JSON.stringify({
      success: false,
      error: "query, ext, or path is required",
      data: null,
    }, null, 2));
    process.exit(2);
  }

  const psArgs = [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    wrapperWin,
    args.query,
    "-Limit",
    String(args.limit),
    "-Sort",
    args.sort,
  ];
  if (args.ext) psArgs.push("-Ext", args.ext);
  if (args.path) psArgs.push("-Path", args.path);
  if (args.regex) psArgs.push("-Regex");
  if (args.count) psArgs.push("-Count");
  else psArgs.push("-Json");

  const result = await runPowerShell(psArgs);
  const parsed = parseResult(result.text, args.count);
  const filteredResults = filterResults(parsed.results, args.includeTemp);
  const output = {
    success: result.ok,
    error: result.ok ? null : redact(result.text).slice(0, 1200),
    data: {
      query: args.query,
      ext: args.ext || null,
      path: args.path || null,
      limit: args.limit,
      sort: args.sort,
      regex: args.regex,
      count_only: args.count,
      include_temp: args.includeTemp,
      raw_result_count: parsed.count,
      result_count: args.count ? parsed.count : filteredResults.length,
      results: filteredResults,
    },
  };

  console.log(JSON.stringify(output, null, 2));
  if (!result.ok) process.exit(result.exitCode || 1);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(JSON.stringify({ success: false, error: redact(error.message), data: null }, null, 2));
    process.exit(1);
  });
}

module.exports = {
  filterResults,
  parseArgs,
  parseResult,
  redact,
};
