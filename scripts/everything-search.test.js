#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { filterResults, parseResult } = require("./everything-search.js");

test("filterResults removes Windows and POSIX temp paths unless explicitly included", () => {
  const results = [
    "C:\\Users\\mjb58\\antigravity-projects\\connect-ai\\scripts\\agent-queue.js",
    "C:\\Users\\mjb58\\AppData\\Local\\Temp\\connect-ai-queue\\agent-queue.json",
    "C:/Users/mjb58/AppData/Local/Temp/connect-ai-queue/agent-queue.json",
  ];

  assert.deepEqual(filterResults(results, false), [
    "C:\\Users\\mjb58\\antigravity-projects\\connect-ai\\scripts\\agent-queue.js",
  ]);
  assert.equal(filterResults(results, true).length, 3);
});

test("parseResult accepts a single JSON string result from PowerShell", () => {
  assert.deepEqual(parseResult('"C:\\\\one.txt"', false), {
    count: 1,
    results: ["C:\\one.txt"],
  });
});
