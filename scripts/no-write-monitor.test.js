#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const monitor = require("./no-write-monitor.js");

test("read-only write scope sentinel does not expand to the repo root", () => {
  const scoped = monitor.startWriteScopeMonitor({ writeScope: ["read-only"] });
  assert.deepEqual(scoped.allowedPaths, []);
  assert.deepEqual(scoped.boundaryPaths, []);
  assert.deepEqual(scoped.before, []);

  const noWrite = monitor.startNoWriteMonitor({ writeScope: ["read-only"] });
  assert.deepEqual(noWrite.taskPaths, []);
  assert.deepEqual(noWrite.before, []);
});
