#!/usr/bin/env node
/**
 * session-search.js
 * Full-text search across all Codex/Claude sessions.
 * Uses session-porter search only.
 *
 * Usage:
 *   node scripts/session-search.js "query"
 *   node scripts/session-search.js "query" --agent codex
 *   node scripts/session-search.js "fn\s+\w+" --regex
 *
 * Complements Everything (filename search): this searches session CONTENT.
 */

const { execFileSync } = require('child_process');

function main() {
  const args = process.argv.slice(2);
  const query = args.find(a => !a.startsWith('--'));
  if (!query) {
    console.error('Usage: node session-search.js "<query>" [--agent codex|claude] [--regex] [-n N]');
    process.exit(1);
  }

  const spArgs = ['--yes', 'session-porter@latest', 'search', query];

  const agentIdx = args.indexOf('--agent');
  if (agentIdx >= 0 && args[agentIdx + 1]) {
    spArgs.push('--agent', args[agentIdx + 1]);
  }
  if (args.includes('--regex')) spArgs.push('--regex');
  const nIdx = args.indexOf('-n');
  if (nIdx >= 0 && args[nIdx + 1]) {
    spArgs.push('-n', args[nIdx + 1]);
  }

  console.log(`[search] "${query}"\n`);
  try {
    execFileSync('npx', spArgs, { stdio: 'inherit', shell: true });
  } catch (e) {
    process.exit(e.status || 1);
  }
}

main();
