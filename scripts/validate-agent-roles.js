#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const envPaths = require("./env-paths.js");

const repoRoot = envPaths.repoRoot();
const vaultRoot = envPaths.vaultRoot();
const expectedAgentIds = [
  "ceo",
  "youtube",
  "instagram",
  "designer",
  "developer",
  "business",
  "secretary",
  "editor",
  "writer",
  "researcher",
];
const requiredFields = [
  "executor",
  "status",
  "primaryNotes",
  "allowedTools",
  "approvalTools",
  "forbiddenTools",
  "riskLevel",
  "nextAction",
  "uiBadges",
];

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function loadMcpToolNames() {
  const serverPath = path.join(repoRoot, "mcp", "server.js");
  const source = fs.readFileSync(serverPath, "utf8");
  return new Set([...source.matchAll(/registerTool\(\s*["']([^"']+)["']/g)].map((match) => match[1]));
}

function main() {
  const errors = [];
  const configPath = path.join(repoRoot, "config", "agent-roles.json");
  const config = readJson(configPath);
  const agents = config.agents && typeof config.agents === "object" ? config.agents : {};
  const mcpTools = loadMcpToolNames();

  if (config.enforcement !== "partial-mcp-gated") {
    errors.push(`expected enforcement partial-mcp-gated, got ${config.enforcement || "(missing)"}`);
  }

  for (const id of expectedAgentIds) {
    const agent = agents[id];
    if (!agent) {
      errors.push(`missing agent: ${id}`);
      continue;
    }
    for (const field of requiredFields) {
      if (!(field in agent)) errors.push(`${id}: missing field ${field}`);
    }
    for (const note of agent.primaryNotes || []) {
      const notePath = path.join(vaultRoot, note);
      if (!fs.existsSync(notePath)) errors.push(`${id}: missing note ${note}`);
    }
    for (const field of ["allowedTools", "approvalTools", "forbiddenTools"]) {
      for (const tool of agent[field] || []) {
        if (!mcpTools.has(tool)) errors.push(`${id}: ${field} references unknown MCP tool ${tool}`);
      }
    }
  }

  for (const id of Object.keys(agents)) {
    if (!expectedAgentIds.includes(id)) errors.push(`unexpected agent: ${id}`);
  }

  if (errors.length) {
    console.error(JSON.stringify({ success: false, errors }, null, 2));
    process.exit(1);
  }

  console.log(JSON.stringify({
    success: true,
    enforcement: config.enforcement,
    agentCount: expectedAgentIds.length,
    mcpToolCount: mcpTools.size,
  }, null, 2));
}

main();
