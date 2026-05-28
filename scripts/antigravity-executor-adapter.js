#!/usr/bin/env node
"use strict";

const fs = require("node:fs");

function clean(value) {
  return String(value || "").trim();
}

function validateAntigravityExecutorResult(result = {}) {
  const requestedModelLabel = clean(result.requestedModelLabel);
  const observedModelLabel = clean(result.observedModelLabel);
  const base = {
    ...result,
    executor: "antigravity",
    requestedModelLabel,
    observedModelLabel,
  };

  if (!observedModelLabel) {
    return {
      ...base,
      success: false,
      status: "BLOCKED",
      reason: "MISSING_OBSERVED_MODEL",
      unresolvedFailures: [
        ...(Array.isArray(result.unresolvedFailures) ? result.unresolvedFailures : []),
        "MISSING_OBSERVED_MODEL",
      ],
    };
  }

  if (requestedModelLabel && requestedModelLabel !== observedModelLabel) {
    return {
      ...base,
      success: false,
      status: "BLOCKED",
      reason: "MODEL_MISMATCH",
      unresolvedFailures: [
        ...(Array.isArray(result.unresolvedFailures) ? result.unresolvedFailures : []),
        "MODEL_MISMATCH",
      ],
    };
  }

  return {
    ...base,
    success: result.success !== false,
    status: result.status || "READY_FOR_VERIFICATION",
    reason: result.reason || "",
    unresolvedFailures: Array.isArray(result.unresolvedFailures) ? result.unresolvedFailures : [],
  };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function main(argv = process.argv.slice(2)) {
  const inputIdx = argv.indexOf("--input");
  if (inputIdx === -1 || !argv[inputIdx + 1]) throw new Error("antigravity-executor-adapter requires --input result.json");
  const output = validateAntigravityExecutorResult(readJson(argv[inputIdx + 1]));
  console.log(JSON.stringify(output, null, 2));
  if (output.status === "BLOCKED") process.exitCode = 1;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.log(JSON.stringify({
      success: false,
      status: "BLOCKED",
      reason: "ADAPTER_ERROR",
      error: String(error?.message || error),
    }, null, 2));
    process.exit(1);
  }
}

module.exports = {
  validateAntigravityExecutorResult,
};
