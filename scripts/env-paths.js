"use strict";
// env-paths.js — Connect AI 경로의 단일 진실 공급원(Single Source of Truth).
// WSL과 Windows 어디서 실행되든 "같은 환경처럼" 동작하도록 경로를 일원화한다.
//
// 핵심 규칙:
// 1. 사용자 식별자(mjb58 등)를 하드코딩하지 않는다. 환경에서 유추한다.
// 2. 같은 물리 경로를 Windows형/WSL형으로 자유 변환한다.
// 3. 환경변수로 override 가능(CONNECT_AI_VAULT, CONNECT_AI_AGENT_QUEUE 등).

const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");

const isLinux = process.platform === "linux";
const isWsl = isLinux && (
  /microsoft/i.test(os.release() || "") ||
  !!process.env.WSL_DISTRO_NAME ||
  fs.existsSync("/mnt/c")
);

// Windows 사용자명 유추: 환경변수 우선, 없으면 /mnt/c/Users 스캔, 최후로 현재 사용자.
function windowsUser() {
  if (process.env.CONNECT_AI_WIN_USER) return process.env.CONNECT_AI_WIN_USER;
  if (process.platform === "win32") return process.env.USERNAME || os.userInfo().username;
  // WSL: USERPROFILE이 상속되면 거기서, 아니면 /mnt/c/Users에서 추정
  if (process.env.USERPROFILE) {
    const m = process.env.USERPROFILE.match(/Users[\\/]([^\\/]+)/);
    if (m) return m[1];
  }
  try {
    const users = fs.readdirSync("/mnt/c/Users").filter((u) => !/^(Public|Default|All Users|Default User)$/i.test(u) && !u.endsWith(".ini"));
    // connect-ai-vault를 가진 사용자를 우선 선택
    for (const u of users) {
      if (fs.existsSync(`/mnt/c/Users/${u}/connect-ai-vault`)) return u;
    }
    if (users.length) return users[0];
  } catch { /* ignore */ }
  return os.userInfo().username;
}

const WIN_USER = windowsUser();

// 경로 변환 -------------------------------------------------------------
function winToWsl(p) {
  if (!p) return p;
  const m = String(p).match(/^([A-Za-z]):[\\/](.*)$/);
  if (!m) return String(p).replace(/\\/g, "/");
  return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, "/")}`;
}
function wslToWin(p) {
  if (!p) return p;
  const m = String(p).match(/^\/mnt\/([a-z])\/(.*)$/i);
  if (!m) return p;
  return `${m[1].toUpperCase()}:\\${m[2].replace(/\//g, "\\")}`;
}
// 현재 실행 환경(Windows or WSL)에 맞는 형태로 정규화
function toNative(winPath) {
  return isLinux ? winToWsl(winPath) : winPath;
}

// 기준 경로 -------------------------------------------------------------
// 모든 경로는 "Windows 절대경로"를 기준으로 정의하고, 실행환경에 맞게 toNative한다.
const winHome = `C:\\Users\\${WIN_USER}`;

function vaultRoot() {
  if (process.env.CONNECT_AI_VAULT) return toNative(process.env.CONNECT_AI_VAULT);
  return toNative(`${winHome}\\connect-ai-vault`);
}

function companyDir() {
  if (process.env.CONNECT_AI_COMPANY_DIR) return toNative(process.env.CONNECT_AI_COMPANY_DIR);
  return toNative(`${winHome}\\connect-ai-runtime\\company`);
}

function repoRoot() {
  // 이 모듈 기준 상위가 repo. 단 호출자가 override 가능.
  if (process.env.CONNECT_AI_REPO) return toNative(process.env.CONNECT_AI_REPO);
  return path.resolve(__dirname, "..");
}

function agentQueuePath() {
  if (process.env.CONNECT_AI_AGENT_QUEUE) return toNative(process.env.CONNECT_AI_AGENT_QUEUE);
  const winQueue = `${winHome}\\AppData\\Roaming\\Code\\User\\globalStorage\\connectailab.connect-ai-lab\\phase3\\agent-queue.json`;
  return toNative(winQueue);
}

module.exports = {
  isLinux, isWsl, WIN_USER, winHome,
  winToWsl, wslToWin, toNative,
  vaultRoot, companyDir, repoRoot, agentQueuePath,
};
