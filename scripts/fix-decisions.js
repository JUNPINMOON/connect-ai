#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const envPaths = require("./env-paths.js");
const { replaceExistingNoteContent } = require("./vault-writer.js");

function vaultRoot() {
  return envPaths.vaultRoot();
}

function writerStorageRoot() {
  return path.resolve(path.dirname(envPaths.agentQueuePath()), "..");
}

function parseArgs(argv) {
  return {
    execute: argv.includes("--execute"),
    json: argv.includes("--json"),
  };
}

function compactTimestamp(value = new Date()) {
  return value.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function stripFrontmatter(content) {
  if (!content.startsWith("---")) return content;
  const end = content.indexOf("\n---", 3);
  if (end === -1) return content;
  return content.slice(end + 4);
}

function humanizeTitle(fileName) {
  return path.basename(fileName, ".md")
    .replace(/^\d{4}-\d{2}-\d{2}-?/, "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim() || path.basename(fileName, ".md");
}

function firstUsefulText(content) {
  const body = stripFrontmatter(content)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && !line.startsWith("- 결정:") && !line.startsWith("- 근거:") && !line.startsWith("- 관련:"))
    .join(" ");
  return body.slice(0, 200).replace(/\s+/g, " ").trim();
}

function fieldValue(content, label) {
  const match = content.match(new RegExp(`^-\\s*${label}:\\s*(.*)$`, "m"));
  if (!match) return null;
  return match[1].trim();
}

function needsFix(content) {
  return !fieldValue(content, "결정") || !fieldValue(content, "근거");
}

function insertAfterHeader(content, lines) {
  const h1 = content.match(/^# .+$/m);
  if (h1) {
    const insertAt = h1.index + h1[0].length;
    return `${content.slice(0, insertAt)}\n${lines.join("\n")}${content.slice(insertAt)}`;
  }

  if (content.startsWith("---")) {
    const end = content.indexOf("\n---", 3);
    if (end !== -1) {
      const insertAt = end + 4;
      return `${content.slice(0, insertAt)}\n${lines.join("\n")}\n${content.slice(insertAt).replace(/^\r?\n/, "")}`;
    }
  }

  return `${lines.join("\n")}\n\n${content}`;
}

function upsertField(content, label, value) {
  const pattern = new RegExp(`^-\\s*${label}:\\s*(.*)$`, "m");
  if (pattern.test(content)) {
    return content.replace(pattern, `- ${label}: ${value}`);
  }
  return insertAfterHeader(content, [`- ${label}: ${value}`]);
}

function fixContent(content, fileName) {
  const title = humanizeTitle(fileName);
  const evidence = firstUsefulText(content);
  const decision = `${title} 관련 결정 기록을 보존한다.`;
  const reason = evidence
    ? `파일명과 본문 근거: ${evidence}`
    : `파일명 ${path.basename(fileName)} 기준으로 누락된 근거 필드를 보완했다.`;

  let next = content;
  if (!fieldValue(next, "결정")) next = upsertField(next, "결정", decision);
  if (!fieldValue(next, "근거")) next = upsertField(next, "근거", reason);
  return next;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const memoryRoot = vaultRoot();
  const storageRoot = writerStorageRoot();
  const batchId = `fix-decisions-${compactTimestamp()}`;
  const decisionDir = path.join(memoryRoot, "decisions");
  if (!fs.existsSync(decisionDir)) throw new Error(`decisions directory missing: ${decisionDir}`);

  const files = fs.readdirSync(decisionDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
    .map((entry) => path.join(decisionDir, entry.name));

  const candidates = [];
  for (const filePath of files) {
    const before = fs.readFileSync(filePath, "utf8");
    if (!needsFix(before)) continue;
    const after = fixContent(before, filePath);
    const candidate = {
      file: filePath,
      name: path.basename(filePath),
      relPath: path.relative(memoryRoot, filePath).replace(/\\/g, "/"),
      changed: after !== before,
      missing_decision: !fieldValue(before, "결정"),
      missing_reason: !fieldValue(before, "근거"),
      preview_decision: fieldValue(after, "결정"),
      preview_reason: fieldValue(after, "근거"),
    };

    if (args.execute && after !== before) {
      const writeResult = replaceExistingNoteContent({
        memoryRoot,
        storageRoot,
        batchId,
        operation: "fix-decisions-repair",
        relPath: candidate.relPath,
        content: after,
      });
      candidate.write_ok = writeResult.ok;
      candidate.write_reason = writeResult.reason || "";
      candidate.backupPath = writeResult.backupPath || "";
      if (!writeResult.ok) {
        throw new Error(`vault_writer_rejected ${candidate.relPath}: ${writeResult.reason}`);
      }
    }
    candidates.push(candidate);
  }

  const result = {
    success: true,
    dry_run: !args.execute,
    decision_dir: decisionDir,
    scanned_count: files.length,
    candidate_count: candidates.length,
    changed_count: args.execute ? candidates.filter((item) => item.changed && item.write_ok !== false).length : 0,
    batch_id: args.execute ? batchId : "",
    candidates,
  };

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`${args.execute ? "EXECUTE" : "DRY-RUN"} fix-decisions`);
  console.log(`decisions: ${decisionDir}`);
  console.log(`scanned: ${files.length}`);
  console.log(`candidates: ${candidates.length}`);
  for (const item of candidates) {
    const missing = [
      item.missing_decision ? "결정" : null,
      item.missing_reason ? "근거" : null,
    ].filter(Boolean).join(", ");
    console.log(`- ${item.name}: missing ${missing}`);
  }
  if (!args.execute) console.log("No files changed. Re-run with --execute to apply and create .bak files.");
}

if (require.main === module) main();

module.exports = {
  fieldValue,
  fixContent,
  firstUsefulText,
  humanizeTitle,
  needsFix,
  parseArgs,
  stripFrontmatter,
  upsertField,
  writerStorageRoot,
};
