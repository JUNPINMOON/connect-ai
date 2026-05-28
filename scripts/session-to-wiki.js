#!/usr/bin/env node
/**
 * session-to-wiki.js
 * Codex/Claude session -> markdown export -> connect-ai-vault/references/session-exports/
 * Uses session-porter export only (no transfer/continue).
 *
 * Usage:
 *   node scripts/session-to-wiki.js <session-id>
 *   node scripts/session-to-wiki.js <session-id> --agent claude
 *
 * Policy:
 *   - Redact secret patterns (key/token/api_key/password)
 *   - Write only through vault-writer into references/session-exports/
 *   - session-porter via npx (no global install)
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const envPaths = require('./env-paths.js');
const { writeDurableNote } = require('./vault-writer.js');

const VAULT = process.env.CONNECT_AI_VAULT || envPaths.vaultRoot();
const STORAGE_ROOT = path.resolve(path.dirname(envPaths.agentQueuePath()), '..');

const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9]{20,}/g,
  /Bearer\s+[A-Za-z0-9._\-]+/g,
  /(api[_-]?key\s*[:=]\s*)[^\s"']+/gi,
  /(password\s*[:=]\s*)[^\s"']+/gi,
  /(token\s*[:=]\s*)[A-Za-z0-9._\-]{12,}/gi,
  /OPENROUTER_API_KEY\s*[:=]\s*\S+/gi,
  /ghp_[A-Za-z0-9]{20,}/g,
];

function redact(text) {
  let redactedCount = 0;
  let out = text;
  for (const pat of SECRET_PATTERNS) {
    out = out.replace(pat, (m, g1) => {
      redactedCount++;
      return g1 ? `${g1}[REDACTED]` : '[REDACTED]';
    });
  }
  return { out, redactedCount };
}

function safeName(value) {
  return String(value || "session")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "session";
}

function buildSessionNoteRequest({ sessionId, agent = "codex", redactedCount = 0, exportedAt = "", content = "" }) {
  const shortId = String(sessionId || "").slice(0, 12);
  if (!shortId) throw new Error("session_id_required");
  const safeAgent = safeName(agent);
  const date = exportedAt || new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
  const title = `${safeAgent} session ${shortId}`;
  const body = [
    `# ${title}`,
    "",
    `> Exported via session-porter on ${date}.`,
    `> Agent: ${agent}; redacted patterns: ${redactedCount}.`,
    "",
    "[[00_MOC/AI Agent OS]]",
    "[[00_MOC/Agents]]",
    "",
    String(content || "").trimEnd(),
    "",
  ].join("\n");
  return {
    relPath: `references/session-exports/${safeAgent}-session-${shortId}.md`,
    title,
    type: "evidence",
    status: "draft",
    project: "Connect AI",
    owner: String(agent || "codex"),
    source: "session-porter",
    tags: ["session-export", "agent-os", "evidence"],
    related: ["[[00_MOC/AI Agent OS]]", "[[00_MOC/Agents]]"],
    links: ["[[00_MOC/AI Agent OS]]", "[[00_MOC/Agents]]"],
    body,
  };
}

function main() {
  const args = process.argv.slice(2);
  const sessionId = args.find(a => !a.startsWith('--'));
  if (!sessionId) {
    console.error('Usage: node session-to-wiki.js <session-id> [--agent claude|codex]');
    process.exit(1);
  }
  const agentIdx = args.indexOf('--agent');
  const agent = agentIdx >= 0 ? args[agentIdx + 1] : 'codex';

  const tmp = path.join(os.tmpdir(), `sp-${sessionId.slice(0, 12)}.md`);

  console.log(`[1/3] exporting session ${sessionId}...`);
  execFileSync('npx', ['--yes', 'session-porter@latest', 'export', sessionId, '-f', 'markdown', '-o', tmp], {
    stdio: 'inherit',
  });
  if (!fs.existsSync(tmp)) {
    console.error('export failed: no output file');
    process.exit(1);
  }

  console.log('[2/3] secret scan / redact...');
  const raw = fs.readFileSync(tmp, 'utf-8');
  const { out, redactedCount } = redact(raw);
  if (redactedCount > 0) {
    console.log(`  WARNING: ${redactedCount} secrets redacted`);
  } else {
    console.log('  OK: no secret patterns');
  }

  console.log('[3/3] saving to references/session-exports/ through vault-writer...');
  const request = buildSessionNoteRequest({
    sessionId,
    agent,
    redactedCount,
    content: out,
  });
  const writeResult = writeDurableNote({
    memoryRoot: VAULT,
    storageRoot: STORAGE_ROOT,
    ...request,
  });
  if (!writeResult.ok) {
    console.error(`vault-writer rejected session export: ${writeResult.reason}`);
    process.exit(1);
  }

  try { fs.unlinkSync(tmp); } catch {}

  console.log(`\nREADY_FOR_VERIFICATION: ${writeResult.path}`);
  console.log('Next: run wiki ingest to absorb into the wiki');
}

if (require.main === module) main();

module.exports = {
  buildSessionNoteRequest,
  redact,
  safeName,
};
