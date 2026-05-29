#!/usr/bin/env node
/**
 * agent-sync-lint.js  (v2)
 * 3-way 동기화 검사: config/agent-roles.json ↔ agent-guides/*.md ↔ config/agent-contracts.json
 *
 * truth = roles.json / contracts.json. 페르소나 노트는 거울. join key = 노트 frontmatter `roleKey`.
 * 사용: node scripts/agent-sync-lint.js   (FAIL/CONFLICT 있으면 exit 1)
 * env: REPO_ROOT, VAULT_ROOT
 *
 * v2 변경점:
 *  - rule 4 실제 구현: dispatch/queue 변경 도구는 그 권한을 가진 contract가 있어야 함(CONFLICT).
 *  - mirrorRoles 화이트리스트: 노트-존재(rule 7-a)는 백필 대상만 FAIL, 그 외는 WARN(단계적 백필).
 *  - CRLF 내성(\r?\n), frontmatter 인라인 주석 내성.
 *  - 심각도: FAIL/CONFLICT → exit1, WARN → 보고만.
 */
const fs = require("fs");
const path = require("path");

const REPO_ROOT  = process.env.REPO_ROOT  || "C:\\Users\\mjb58\\antigravity-projects\\connect-ai";
const VAULT_ROOT = process.env.VAULT_ROOT || "C:\\Users\\mjb58\\connect-ai-vault";

const ROLES_PATH      = path.join(REPO_ROOT, "config", "agent-roles.json");
const CONTRACTS_PATH  = path.join(REPO_ROOT, "config", "agent-contracts.json");
const GUIDES_DIR      = path.join(VAULT_ROOT, "agent-guides");
const MOC_AGENTS_PATH = path.join(VAULT_ROOT, "00_MOC", "moc-agents.md");

// 페르소나 노트 거울을 강제할 역할(이번 백필 범위). 그 외 active/optional 역할의
// 노트 부재는 WARN(후속 백필 추적). roles.json 에 "mirror": true 로 옮겨도 됨.
const MIRROR_ROLES = new Set(["developer", "ceo", "verifier"]);

// 큐/디스패치를 '변경'하는 도구. 이 도구를 가지려면 그 권한을 모델링한 contract가 있어야 함.
const DISPATCH_TOOLS = new Set([
  "task_enqueue", "task_dispatch_goal", "task_dispatch_verification",
  "task_apply_verification", "task_update_status", "task_claim",
]);
// dispatch 권한을 부여하는 contract workerClass.
// orchestration 도구(task_dispatch_* 등)는 mcp/server.js 에서 departmentId:"orchestration" 으로 분류됨.
// 따라서 그 권한은 orchestrator workerClass contract 가 모델링해야 함.
const DISPATCH_AUTHORIZED_WORKERCLASS = new Set(["orchestrator"]);

const problems = []; // {sev, key, msg}
const fail     = (key, msg) => problems.push({ sev: "FAIL", key, msg });
const conflict = (key, msg) => problems.push({ sev: "CONFLICT", key, msg });
const warn     = (key, msg) => problems.push({ sev: "WARN", key, msg });

// --- 최소 frontmatter 파서 (의존성 없음, CRLF/인라인주석 내성) ---
function parseNote(file) {
  const raw = fs.readFileSync(file, "utf8");
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!m) return null;
  const fmText = m[1], body = m[2];
  const get = (k) => {
    // 값 뒤 인라인 `# 주석` 허용
    const r = fmText.match(new RegExp(`^${k}:\\s*"?([^"#\\n]+?)"?\\s*(?:#.*)?$`, "m"));
    return r ? r[1].trim() : null;
  };
  const linksAgents = /\[\[00_MOC\/Agents\]\]/.test(fmText);
  const sil = body.match(/실체:\s*\[\[([^\]]+)\]\]/);
  return {
    roleKey: get("roleKey"),
    status: get("status"),
    linksAgents,
    executorFromBody: sil ? sil[1].trim() : null,
  };
}

const MODEL_TO_EXEC = { codex: "codex", gemini: "gemini", hermes: "hermes", claude: "claude" };
const normModel = (s) => (s ? MODEL_TO_EXEC[s.toLowerCase()] || s.toLowerCase() : null);
const execTokens = (executor) => (executor || "").split("->").map((t) => t.trim()).filter(Boolean);

// --- 로드 ---
const roles = JSON.parse(fs.readFileSync(ROLES_PATH, "utf8")).agents;
const contracts = JSON.parse(fs.readFileSync(CONTRACTS_PATH, "utf8")).contracts;
const contractsByAssignee = new Map();
for (const c of contracts) {
  if (!contractsByAssignee.has(c.assignee)) contractsByAssignee.set(c.assignee, []);
  contractsByAssignee.get(c.assignee).push(c);
}
const mocText = fs.existsSync(MOC_AGENTS_PATH) ? fs.readFileSync(MOC_AGENTS_PATH, "utf8") : "";

// roleKey → 노트 인덱스
const notes = {};
for (const f of fs.readdirSync(GUIDES_DIR).filter((f) => f.endsWith(".md"))) {
  const n = parseNote(path.join(GUIDES_DIR, f));
  if (n && n.roleKey) notes[n.roleKey] = { ...n, file: f, base: path.basename(f, ".md") };
}

// --- role 기준 검사 ---
for (const [key, role] of Object.entries(roles)) {
  const note = notes[key];
  const roleContracts = execTokens(role.executor)
    .filter((t) => t !== "none")
    .flatMap((t) => contractsByAssignee.get(t) || []);

  // (3) executor → contract(assignee) 존재
  for (const tok of execTokens(role.executor)) {
    if (tok !== "none" && !contractsByAssignee.has(tok))
      fail(key, `executor "${tok}" 에 대응하는 contract(assignee)가 contracts.json 에 없음`);
  }

  // (4) 권한 초과: dispatch 도구를 가지면 그 권한을 모델링한 contract가 있어야 함
  const hasDispatchTool = (role.allowedTools || []).some((t) => DISPATCH_TOOLS.has(t));
  if (hasDispatchTool) {
    const authorized = roleContracts.some((c) => DISPATCH_AUTHORIZED_WORKERCLASS.has(c.workerClass));
    if (!authorized) {
      const wc = roleContracts.map((c) => `${c.id}(${c.workerClass})`).join(", ") || "(none)";
      conflict(key, `dispatch/queue 변경 도구를 부여받았으나 그 권한을 모델링한 contract 없음 — executor 계약: ${wc}`);
    }
  }
  // (4b) forbiddenTools 가 allowed/approval 과 동시 존재 금지(간이)
  const forb = new Set(role.forbiddenTools || []);
  for (const t of [...(role.allowedTools || []), ...(role.approvalTools || [])])
    if (forb.has(t)) fail(key, `도구 "${t}" 가 allowed/approval 과 forbidden 에 동시 존재`);

  if (!note) {
    // (7-a) role 있는데 노트 없음: mirror 대상은 FAIL, 그 외 active/optional 은 WARN
    if (role.status === "active" || role.status === "optional") {
      const m = `roles.json 에 있으나 agent-guides 에 roleKey:${key} 노트 없음`;
      MIRROR_ROLES.has(key) ? fail(key, m) : warn(key, `${m} (후속 백필 추적)`);
    }
    continue;
  }

  // (1) status 일치
  if (note.status !== role.status)
    fail(key, `status 불일치 (노트:${note.status} ≠ roles.json:${role.status})`);

  // (2) executor 일치 (노트 실체 ⊆ roles.json executor 토큰)
  const roleExec = new Set(execTokens(role.executor));
  const noteExec = normModel(note.executorFromBody);
  if (role.executor !== "none" && noteExec && !roleExec.has(noteExec))
    fail(key, `실체 불일치 (노트:${noteExec} ∉ roles.json executor:${role.executor})`);

  // (5) MOC 링크 + Persona Notes 등록 (둘 다)
  if (!note.linksAgents) fail(key, `frontmatter 에 [[00_MOC/Agents]] 링크 없음`);
  const reg = new RegExp(`\\[\\[${note.base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]\\]`);
  if (!reg.test(mocText)) fail(key, `moc-agents.md ## Persona Notes 에 [[${note.base}]] 미등록`);

  // (6) primaryNotes 역등록
  const pn = role.primaryNotes || [];
  if (!pn.some((p) => p.endsWith("/" + note.file) || p === note.file))
    fail(key, `roles.json ${key}.primaryNotes 에 agent-guides/${note.file} 역등록 안 됨`);
}

// (7-b) 노트는 있는데 role 없음
for (const key of Object.keys(notes))
  if (!roles[key]) fail(key, `roleKey:${key} 노트는 있으나 roles.json 에 역할 없음`);

// --- 리포트 ---
const blocking = problems.filter((p) => p.sev !== "WARN");
const order = { CONFLICT: 0, FAIL: 1, WARN: 2 };
problems.sort((a, b) => order[a.sev] - order[b.sev]);
for (const p of problems) {
  const line = `[${p.sev}] ${p.key}: ${p.msg}`;
  p.sev === "WARN" ? console.warn(line) : console.error(line);
}
if (blocking.length === 0) {
  console.log(`[PASS] agent 3-way 동기화 OK${problems.length ? ` (WARN ${problems.length}건)` : ""}`);
  process.exit(0);
} else {
  console.error(`\nblocking ${blocking.length}건 (WARN ${problems.length - blocking.length}건).`);
  process.exit(1);
}
