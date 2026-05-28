#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

test("youtube visual inbox writes route through createDurableNote", () => {
  const source = fs.readFileSync(path.join(__dirname, "youtube-ingest.ts"), "utf8");
  assert.match(source, /createDurableNote/);
  assert.doesNotMatch(source, /fs\.writeFileSync\(notePath/);
  assert.doesNotMatch(source, /relPath = `inbox\/\$\{datePart\}-yt-\$\{slug\}-NEEDS-VISUAL\.md`/);
  assert.match(source, /relPath = `inbox\/yt-\$\{slug\}-NEEDS-VISUAL\.md`/);
});

test("Lilys YouTube durable notes route through vault-writer and markers stay in runtime", () => {
  const source = fs.readFileSync(path.join(__dirname, "lilys-ingest-youtube.js"), "utf8");
  assert.match(source, /writeDurableNote/);
  assert.match(source, /relPath = `youtube\/content\/\$\{safeName\(videoId\)\}\.youtube\.md`/);
  assert.doesNotMatch(source, /fs\.writeFileSync\(notePath/);
  assert.match(source, /return path\.join\(companyDir\(\), "youtube", "processed"\)/);
  assert.match(source, /legacyProcessedDir/);
});

test("runtime maintenance no longer hard-codes vault _company sessions", () => {
  const source = fs.readFileSync(path.join(__dirname, "maintenance.js"), "utf8");
  assert.doesNotMatch(source, /vaultRoot[^\n]+_company[^\n]+sessions|"_company",\s*"sessions"/);
});

test("decision repair execution routes through vault-writer instead of direct note writes", () => {
  const source = fs.readFileSync(path.join(__dirname, "fix-decisions.js"), "utf8");
  assert.match(source, /replaceExistingNoteContent/);
  assert.doesNotMatch(source, /fs\.writeFileSync\(filePath,\s*after/);
  assert.doesNotMatch(source, /\.bak`\s*;\s*\n\s*if \(!fs\.existsSync\(backup\)\) fs\.writeFileSync\(backup/);
});

test("extension brain-inject durable notes route through memory-bridge single writer", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "extension.ts"), "utf8");
  const match = source.match(/else if \(req\.method === 'POST' && req\.url === '\/api\/brain-inject'\) \{[\s\S]*?else if \(req\.method === 'POST' && req\.url === '\/api\/skill-inject'\)/);
  assert.ok(match, "brain-inject endpoint block must exist");
  assert.match(source, /import \{ createDurableNote/);
  assert.match(source, /function buildBrainInjectNoteRequest/);
  assert.match(source, /references\/brain-injects\/\$\{safeTitle\}\.md/);
  assert.match(match[0], /writeBrainInjectNote/);
  assert.doesNotMatch(match[0], /fs\.writeFileSync\(filePath,\s*markdown/);
  assert.doesNotMatch(match[0], /path\.join\(brainDir,\s*'00_Raw'/);
});

test("skill injection stores agent tools in runtime without requiring or syncing the vault", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "extension.ts"), "utf8");
  const match = source.match(/else if \(req\.method === 'POST' && req\.url === '\/api\/skill-inject'\) \{[\s\S]*?else if \(req\.method === 'POST' && req\.url === '\/api\/template-inject'\)/);
  assert.ok(match, "skill-inject endpoint block must exist");
  assert.match(match[0], /ensureCompanyStructure\(\)/);
  assert.match(match[0], /path\.join\(getCompanyDir\(\),\s*'_agents',\s*agentId,\s*'tools'\)/);
  assert.match(match[0], /_safeGitAutoSyncCompany\(`Auto-Inject Skill/);
  assert.doesNotMatch(match[0], /_isBrainDirExplicitlySet\(\)/);
  assert.doesNotMatch(match[0], /_ensureBrainDir\(\)/);
  assert.doesNotMatch(match[0], /_safeGitAutoSync\(_getBrainDir\(\),\s*`Auto-Inject Skill/);
});

test("sidebar local brain file injection does not direct-write raw vault files or tell agents to create wiki files", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "extension.ts"), "utf8");
  const match = source.match(/private async _handleInjectLocalBrain\(files: any\[\]\) \{[\s\S]*?\n    }\n\n    \/\/ --------------------------------------------------------\n    \/\/ Fetch installed Ollama models/);
  assert.ok(match, "_handleInjectLocalBrain block must exist");
  assert.match(source, /function buildLocalBrainAttachmentNoteRequest/);
  assert.match(match[0], /writeLocalBrainAttachmentNote/);
  assert.match(match[0], /references\/brain-injects/);
  assert.doesNotMatch(match[0], /fs\.writeFileSync\(filePath,\s*fileContent/);
  assert.doesNotMatch(match[0], /path\.join\(brainDir,\s*'00_Raw'/);
  assert.doesNotMatch(match[0], /<create_file path="\$\{brainDir\}\/10_Wiki/);
  assert.doesNotMatch(match[0], /절대 경로인 `\$\{brainDir\}\/10_Wiki\/`/);
});

test("template injection stores agent runtime templates outside the Obsidian vault", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "extension.ts"), "utf8");
  const match = source.match(/else if \(req\.method === 'POST' && req\.url === '\/api\/template-inject'\) \{[\s\S]*?\n            }\n            else \{/);
  assert.ok(match, "template-inject endpoint block must exist");
  assert.match(source, /function getAgentTemplateRuntimeDir/);
  assert.match(match[0], /getAgentTemplateRuntimeDir\(agentId,\s*safeName\)/);
  assert.match(match[0], /_safeGitAutoSyncCompany/);
  assert.doesNotMatch(match[0], /const brainDir = _getBrainDir\(\)/);
  assert.doesNotMatch(match[0], /path\.join\(brainDir,\s*'40_템플릿'/);
  assert.doesNotMatch(match[0], /_safeGitAutoSync\(_getBrainDir\(\),\s*`Auto-Inject Template/);
});

test("agent template reader seeds bundled templates into runtime, not the vault", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "extension.ts"), "utf8");
  const match = source.match(/function readAgentTemplates\(agentId: string, maxChars = 2000\): string \{[\s\S]*?\n\}/);
  assert.ok(match, "readAgentTemplates function must exist");
  assert.match(source, /function getAgentTemplateRuntimeDir/);
  assert.match(match[0], /getAgentTemplateRuntimeDir\(agentId\)/);
  assert.match(match[0], /legacyBrainTemplateDirs/);
  assert.doesNotMatch(match[0], /const brainDir = _getBrainDir\(\)/);
  assert.doesNotMatch(match[0], /_seedBundledTemplates\(agentId,\s*path\.join\(_getBrainDir\(\)/);
});

test("generic agent file tools block direct Obsidian vault writes", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "extension.ts"), "utf8");
  const actionBlock = source.match(/private async _executeActions\([\s\S]*?\n        return report;\n    \}/);
  assert.ok(actionBlock, "_executeActions block must exist");
  assert.match(source, /function assertAgentFileToolNotVaultWrite/);
  assert.match(source, /Obsidian vault에는 \\`<create_file>\\`\/\\`<edit_file>\\`\/\\`<delete_file>\\`로 직접 쓰지 마십시오/);
  assert.match(actionBlock[0], /assertAgentFileToolNotVaultWrite\(absPath,\s*'create_file'\)[\s\S]*?fs\.writeFileSync\(absPath,\s*content,\s*'utf-8'\)/);
  assert.match(actionBlock[0], /assertAgentFileToolNotVaultWrite\(absPath,\s*'edit_file'\)[\s\S]*?fs\.writeFileSync\(absPath,\s*fileContent,\s*'utf-8'\)/);
  assert.match(actionBlock[0], /assertAgentFileToolNotVaultWrite\(absPath,\s*'delete_file'\)[\s\S]*?fs\.(?:rmSync|unlinkSync)\(absPath/);
  assert.match(actionBlock[0], /assertAgentFileToolNotVaultWrite\(absPath,\s*'fallback_create_file'\)[\s\S]*?fs\.writeFileSync\(absPath,\s*content,\s*'utf-8'\)/);
});

test("run_command safety blocks direct Obsidian vault mutations while allowing read-only references", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "extension.ts"), "utf8");
  const safetyBlock = source.match(/function validateCommandSafety\(cmd: string(?:,\s*cwd(?:\?:|:) string(?: = '')?)?\): \{ safe: boolean; reason\?: string \} \{[\s\S]*?\n\}/);
  const runnerBlock = source.match(/function runCommandCaptured\([\s\S]*?\n\): Promise<\{ exitCode: number; output: string; timedOut: boolean \}> \{[\s\S]*?\n\}/);
  assert.ok(safetyBlock, "validateCommandSafety block must exist");
  assert.ok(runnerBlock, "runCommandCaptured block must exist");
  assert.match(source, /function commandAttemptsDirectVaultMutation/);
  assert.match(source, /function commandMentionsVaultRoot/);
  assert.match(source, /function commandRunsInsideVaultRoot/);
  assert.match(safetyBlock[0], /commandAttemptsDirectVaultMutation\(normalized,\s*cwd\)/);
  assert.match(runnerBlock[0], /validateCommandSafety\(cmd,\s*cwd\)/);
  assert.match(source, /direct Obsidian vault writes are forbidden for run_command/);
  assert.match(source, /set-content\|add-content\|out-file\|new-item\|copy-item\|move-item\|remove-item/);
  assert.match(source, /writeFileSync\|writeFile\|appendFileSync\|appendFile\|rmSync\|unlinkSync/);
  assert.match(source, /Read-only vault references are allowed/);
  assert.match(source, /vault cwd relative mutations are blocked/);
  assert.match(source, /Obsidian vault에는 \\`<run_command>\\`로 직접 쓰거나 지우지 마십시오/);
});
