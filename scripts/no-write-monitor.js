#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function listDirectoryFiles(root, dir = root, results = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) listDirectoryFiles(root, fullPath, results);
    else if (entry.isFile()) results.push(fullPath);
  }
  return results;
}

function fingerprintEntry(targetPath) {
  const fullPath = path.resolve(targetPath);
  if (!fs.existsSync(fullPath)) return { path: fullPath, kind: "missing" };
  const stat = fs.statSync(fullPath);
  if (stat.isDirectory()) {
    return {
      path: fullPath,
      kind: "directory",
      files: listDirectoryFiles(fullPath)
        .map((absolute) => ({
          relPath: path.relative(fullPath, absolute).replace(/\\/g, "/"),
          size: fs.statSync(absolute).size,
          sha256: sha256File(absolute),
        }))
        .sort((a, b) => a.relPath.localeCompare(b.relPath)),
    };
  }
  if (stat.isFile()) return { path: fullPath, kind: "file", size: stat.size, sha256: sha256File(fullPath) };
  return { path: fullPath, kind: "other", size: stat.size };
}

function uniqueResolved(paths = []) {
  return [...new Set(paths.map(String).filter((item) => item && item !== "read-only").map((item) => path.resolve(item)))]
    .sort((a, b) => a.localeCompare(b));
}

function fingerprintPaths(paths = []) {
  return uniqueResolved(paths).map((item) => fingerprintEntry(item));
}

function fingerprintDiff(before = [], after = []) {
  const afterMap = new Map(after.map((entry) => [entry.path, entry]));
  return before
    .map((entry) => {
      const current = afterMap.get(entry.path) || { path: entry.path, kind: "missing" };
      return JSON.stringify(entry) === JSON.stringify(current) ? null : {
        path: entry.path,
        before: entry.kind,
        after: current.kind,
      };
    })
    .filter(Boolean);
}

function isSameOrInside(parentPath, childPath) {
  const parent = path.resolve(String(parentPath || ""));
  const child = path.resolve(String(childPath || ""));
  const rel = path.relative(parent, child);
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

function taskPathsFor(item = {}) {
  return uniqueResolved([
    ...(Array.isArray(item.files) ? item.files : []),
    ...(Array.isArray(item.writeScope) ? item.writeScope : []),
  ]);
}

function startNoWriteMonitor(item = {}) {
  const taskPaths = taskPathsFor(item);
  return { taskPaths, before: fingerprintPaths(taskPaths) };
}

function reportedTaskWrites(result = {}, monitor = {}) {
  const parsed = result.parsedStdout || result || {};
  const filesChanged = Array.isArray(parsed.filesChanged) ? parsed.filesChanged.map(String).filter(Boolean) : [];
  return filesChanged.filter((filePath) => (monitor.taskPaths || []).some((taskPath) => isSameOrInside(taskPath, filePath)));
}

function noWriteTaskViolations(monitor = {}, result = {}) {
  const modified = fingerprintDiff(monitor.before || [], fingerprintPaths(monitor.taskPaths || []));
  const reported = reportedTaskWrites(result, monitor).map((filePath) => ({ path: path.resolve(filePath), before: "reported", after: "reported" }));
  return [...modified, ...reported];
}

function fileSnapshot(filePath) {
  const fullPath = path.resolve(filePath);
  return {
    path: fullPath,
    size: fs.statSync(fullPath).size,
    sha256: sha256File(fullPath),
  };
}

function snapshotBoundaryFiles(boundaryPaths = []) {
  const results = [];
  for (const boundary of uniqueResolved(boundaryPaths)) {
    if (!fs.existsSync(boundary)) continue;
    const stat = fs.statSync(boundary);
    if (stat.isFile()) {
      results.push(fileSnapshot(boundary));
    } else if (stat.isDirectory()) {
      for (const filePath of listDirectoryFiles(boundary)) results.push(fileSnapshot(filePath));
    }
  }
  return results.sort((a, b) => a.path.localeCompare(b.path));
}

function directoryBoundaryFor(scopePath) {
  const fullPath = path.resolve(scopePath);
  if (fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory()) return fullPath;
  return path.dirname(fullPath);
}

function writeScopePathsFor(item = {}) {
  const scopes = Array.isArray(item.writeScope) && item.writeScope.length ? item.writeScope : item.files;
  return uniqueResolved(Array.isArray(scopes) ? scopes : []);
}

function startWriteScopeMonitor(item = {}) {
  const allowedPaths = writeScopePathsFor(item);
  const boundaryPaths = uniqueResolved(allowedPaths.map(directoryBoundaryFor));
  return {
    allowedPaths,
    boundaryPaths,
    before: snapshotBoundaryFiles(boundaryPaths),
  };
}

function boundaryFileDiff(before = [], after = []) {
  const beforeMap = new Map(before.map((entry) => [entry.path, entry]));
  const afterMap = new Map(after.map((entry) => [entry.path, entry]));
  const keys = [...new Set([...beforeMap.keys(), ...afterMap.keys()])].sort();
  return keys
    .map((key) => {
      const previous = beforeMap.get(key);
      const current = afterMap.get(key);
      if (!previous && current) return { path: current.path, before: "missing", after: "file" };
      if (previous && !current) return { path: previous.path, before: "file", after: "missing" };
      if (previous && current && (previous.size !== current.size || previous.sha256 !== current.sha256)) {
        return { path: current.path, before: "file", after: "file" };
      }
      return null;
    })
    .filter(Boolean);
}

function isAllowedWrite(filePath, allowedPaths = []) {
  return allowedPaths.some((allowed) => isSameOrInside(allowed, filePath));
}

function writeScopeViolations(monitor = {}, result = {}) {
  const allowedPaths = monitor.allowedPaths || [];
  const modified = boundaryFileDiff(monitor.before || [], snapshotBoundaryFiles(monitor.boundaryPaths || []))
    .filter((entry) => !isAllowedWrite(entry.path, allowedPaths));
  const parsed = result.parsedStdout || result || {};
  const reported = (Array.isArray(parsed.filesChanged) ? parsed.filesChanged : [])
    .map(String)
    .filter(Boolean)
    .map((filePath) => path.resolve(filePath))
    .filter((filePath) => !isAllowedWrite(filePath, allowedPaths))
    .map((filePath) => ({ path: filePath, before: "reported", after: "reported" }));
  const byPath = new Map();
  for (const entry of [...modified, ...reported]) byPath.set(entry.path, entry);
  return [...byPath.values()];
}

module.exports = {
  fingerprintPaths,
  noWriteTaskViolations,
  startNoWriteMonitor,
  startWriteScopeMonitor,
  writeScopeViolations,
};
