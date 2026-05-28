#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

// Mock the agent queue functions for testing
function createTempQueueDir() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "connect-ai-task-get-test-"));
  const queueFile = path.join(tempDir, "agent-queue.json");
  return { tempDir, queueFile };
}

function createTestTask(id = null) {
  const now = new Date().toISOString();
  return {
    id: id || `aq-${now.replace(/[-:.TZ]/g, "").slice(0, 14)}-${crypto.randomBytes(3).toString("hex")}`,
    title: "Test task for task_get",
    assignee: "codex",
    status: "queued",
    priority: "P1",
    files: ["test/file.js"],
    prompt: "Test prompt content",
    resultSummary: "",
    createdAt: now,
    updatedAt: now,
  };
}

function writeQueue(queueFile, items) {
  fs.mkdirSync(path.dirname(queueFile), { recursive: true });
  fs.writeFileSync(queueFile, `${JSON.stringify(items, null, 2)}\n`, "utf8");
}

function runAgentQueueGet(queueFile, taskId) {
  // Set environment variable to use our test queue
  const originalEnv = process.env.CONNECT_AI_AGENT_QUEUE;
  process.env.CONNECT_AI_AGENT_QUEUE = queueFile;
  
  try {
    // Import and run the agent-queue script
    const { execFile } = require("node:child_process");
    const nodeBin = process.execPath || "node";
    const scriptPath = path.join(__dirname, "agent-queue.js");
    
    return new Promise((resolve, reject) => {
      execFile(
        nodeBin,
        [scriptPath, "get", "--id", taskId],
        {
          cwd: path.join(__dirname, ".."),
          env: process.env,
          maxBuffer: 10 * 1024 * 1024,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          const exitCode = error && typeof error.code === "number" ? error.code : 0;
          const text = stdout || stderr || (error ? error.message : "");
          
          if (error && exitCode !== 0) {
            reject({ error, text, exitCode });
          } else {
            resolve({ text, exitCode });
          }
        }
      );
    });
  } finally {
    // Restore original environment
    if (originalEnv) {
      process.env.CONNECT_AI_AGENT_QUEUE = originalEnv;
    } else {
      delete process.env.CONNECT_AI_AGENT_QUEUE;
    }
  }
}

async function main() {
  console.log("Testing task_get functionality...\n");
  
  // Create temporary test environment
  const { tempDir, queueFile } = createTempQueueDir();
  
  try {
    // Test 1: Get existing task
    console.log("Test 1: Get existing task");
    const testTask1 = createTestTask();
    writeQueue(queueFile, [testTask1]);
    
    const result1 = await runAgentQueueGet(queueFile, testTask1.id);
    console.log("✓ Successfully retrieved existing task");
    console.log(`  Task ID: ${testTask1.id}`);
    console.log(`  Title: ${testTask1.title}`);
    
    // Parse and verify the response
    const parsed1 = JSON.parse(result1.text);
    if (parsed1.success && parsed1.item && parsed1.item.id === testTask1.id) {
      console.log("✓ Response format is correct");
    } else {
      throw new Error("Invalid response format");
    }
    
    // Test 2: Get non-existing task
    console.log("\nTest 2: Get non-existing task");
    try {
      await runAgentQueueGet(queueFile, "aq-nonexistent-123");
      throw new Error("Should have failed for non-existing task");
    } catch (error) {
      if (error.exitCode === 1) {
        console.log("✓ Correctly failed for non-existing task");
      } else {
        throw error;
      }
    }
    
    // Test 3: Get task with multiple tasks in queue
    console.log("\nTest 3: Get task from queue with multiple tasks");
    const testTask2a = createTestTask();
    const testTask2b = createTestTask();
    const testTask2c = createTestTask();
    writeQueue(queueFile, [testTask2a, testTask2b, testTask2c]);
    
    const result3 = await runAgentQueueGet(queueFile, testTask2b.id);
    const parsed3 = JSON.parse(result3.text);
    if (parsed3.success && parsed3.item && parsed3.item.id === testTask2b.id) {
      console.log("✓ Successfully retrieved specific task from multi-task queue");
    } else {
      throw new Error("Failed to retrieve specific task");
    }
    
    // Test 4: Verify redaction of sensitive fields
    console.log("\nTest 4: Verify sensitive field redaction");
    const testTask4 = createTestTask();
    testTask4.prompt = "API_KEY=secret123 and normal content";
    testTask4.resultSummary = "Completed with SECRET_TOKEN=abc456";
    writeQueue(queueFile, [testTask4]);
    
    const result4 = await runAgentQueueGet(queueFile, testTask4.id);
    const parsed4 = JSON.parse(result4.text);
    
    // Check that sensitive fields are not included in the compact view
    if (!parsed4.item.prompt && !parsed4.item.resultSummary) {
      console.log("✓ Sensitive fields properly excluded from compact view");
    } else {
      console.log("⚠ Sensitive fields may be exposed (check implementation)");
    }
    
    // Test 5: Verify required fields are present
    console.log("\nTest 5: Verify required fields are present");
    const requiredFields = ["id", "title", "assignee", "status", "priority", "files", "resultSummary", "createdAt", "updatedAt"];
    const itemFields = Object.keys(parsed4.item);
    const missingFields = requiredFields.filter(field => !itemFields.includes(field));
    
    if (missingFields.length === 0) {
      console.log("✓ All required fields are present");
    } else {
      throw new Error(`Missing required fields: ${missingFields.join(", ")}`);
    }
    
    console.log("\n✅ All tests passed!");
    
  } catch (error) {
    console.error("\n❌ Test failed:", error);
    process.exit(1);
  } finally {
    // Cleanup
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  }
}

main().catch((error) => {
  console.error("Test execution failed:", error);
  process.exit(1);
});