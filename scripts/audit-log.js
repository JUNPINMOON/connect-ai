#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function isWsl() {
  return process.platform === "linux" && fs.existsSync("/mnt/c");
}

function storageRoot() {
  if (process.env.APPDATA) {
    return path.join(process.env.APPDATA, "Code", "User", "globalStorage", "connectailab.connect-ai-lab");
  }
  if (isWsl()) {
    const user = process.env.USER || "mjb58";
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
        return { parse_error: true };
      }
    });
}

function main() {
  const command = process.argv[2] || "recent";
  const limit = Math.max(1, Math.min(200, Number(process.argv[3] || 20)));
  const auditPath = path.join(storageRoot(), "phase2", "audit-log.jsonl");
  const records = readJsonl(auditPath);

  if (command !== "recent") {
    console.log(JSON.stringify({ success: false, error: "Usage: audit-log.js recent [limit]", data: null }, null, 2));
    process.exit(2);
  }

  console.log(JSON.stringify({
    success: true,
    error: null,
    data: {
      path: auditPath,
      exists: fs.existsSync(auditPath),
      count: records.length,
      recent: records.slice(-limit),
    },
  }, null, 2));
}

main();
