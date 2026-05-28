"use strict";

const path = require("node:path");
const { execFile } = require("node:child_process");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { z } = require("zod");
const taskDispatchGoal = require("../scripts/task-dispatch-goal.js");

const repoRoot = path.resolve(__dirname, "..");
const scriptsDir = path.join(repoRoot, "scripts");
const nodeBin = process.execPath || "node";

function runCli(scriptName, args = [], options = {}) {
  return new Promise((resolve) => {
    const child = execFile(
      nodeBin,
      [path.join(scriptsDir, scriptName), ...args],
      {
        cwd: repoRoot,
        env: process.env,
        input: options.stdin,
        maxBuffer: 10 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const exitCode = error && typeof error.code === "number" ? error.code : 0;
        const text = stdout || stderr || (error ? error.message : "");
        resolve({
          content: [{ type: "text", text }],
          isError: Boolean(error),
          _meta: { exitCode, stderr: stderr || undefined },
        });
      }
    );

    if (options.stdin !== undefined) {
      child.stdin.end(options.stdin);
    }
  });
}

function textResult(text, isError = false, meta = {}) {
  return {
    content: [{ type: "text", text }],
    isError,
    _meta: meta,
  };
}

async function checkMcpGate(request) {
  const result = await runCli("gate-check.js", [], { stdin: JSON.stringify(request) });
  const text = result.content?.[0]?.text || "";
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { decision: "APPROVAL", reason: "policy_gate_parse_failed", raw: text };
  }
  return parsed;
}

async function runCliWithGate(scriptName, args, gateRequest, options = {}) {
  const gate = await checkMcpGate(gateRequest);
  if (gate.decision === "FORBIDDEN") {
    return textResult(JSON.stringify({
      success: false,
      error: "policy_forbidden",
      gate,
    }, null, 2), true, { gate });
  }
  if (gate.decision === "APPROVAL") {
    return textResult(JSON.stringify({
      success: false,
      error: "approval_required",
      message: "Policy gate requires human approval. Tool execution was not started.",
      gate,
    }, null, 2), true, { gate });
  }
  return runCli(scriptName, args, options);
}

const server = new McpServer({
  name: "connect-ai",
  version: "1.0.0",
});

server.registerTool(
  "connect_ai_status",
  {
    title: "Check Connect AI status",
    description: "Return a non-secret health snapshot for the Connect AI repo, Obsidian vault, policies, scripts, and audit log.",
    inputSchema: z.object({}),
  },
  async () => runCli("connect-ai-status.js", [])
);

server.registerTool(
  "audit_recent",
  {
    title: "Read recent audit log",
    description: "Read recent non-secret Connect AI audit-log entries from globalStorage phase2/audit-log.jsonl.",
    inputSchema: z.object({
      limit: z.number().int().min(1).max(200).optional().describe("Number of recent records to return. Defaults to 20."),
    }),
  },
  async ({ limit }) => runCli("audit-log.js", ["recent", String(limit || 20)])
);

server.registerTool(
  "memory_list",
  {
    title: "List memory notes",
    description: "List Connect AI Obsidian memory notes via scripts/memory-cli.js list.",
    inputSchema: z.object({}),
  },
  async () => runCli("memory-cli.js", ["list"])
);

server.registerTool(
  "memory_read",
  {
    title: "Read memory note",
    description: "Read a Connect AI memory note by relative path.",
    inputSchema: z.object({
      relPath: z.string().min(1).describe("Relative path inside the Connect AI memory vault."),
    }),
  },
  async ({ relPath }) => runCli("memory-cli.js", ["read", relPath])
);

server.registerTool(
  "memory_write_decision",
  {
    title: "Write decision memory",
    description: "Write a Connect AI decision note with a title and body.",
    inputSchema: z.object({
      title: z.string().min(1).describe("Decision title."),
      body: z.string().min(1).describe("Markdown body for the decision note."),
    }),
  },
  async ({ title, body }) => runCliWithGate(
    "memory-cli.js",
    ["write-decision", title, body],
    {
      action: "memory_write",
      departmentId: "memory",
      risk: "low",
      toolId: "memory_write_decision",
      payload: { title },
      reversible: true,
      dryRun: false,
    }
  )
);

server.registerTool(
  "gate_check",
  {
    title: "Check policy gate",
    description: "Run the Connect AI policy gate with a JSON request on stdin.",
    inputSchema: z.object({
      action: z.string().min(1),
      departmentId: z.string().min(1),
      risk: z.string().min(1),
      command: z.string().optional(),
    }),
  },
  async (input) => runCli("gate-check.js", [], { stdin: JSON.stringify(input) })
);

server.registerTool(
  "everything_search",
  {
    title: "Search local files with Everything",
    description: "Read-only filename/path search through Everything es.exe. Returns paths only; does not read file contents.",
    inputSchema: z.object({
      query: z.string().optional().describe("Filename or path query. Optional when ext or path is provided."),
      ext: z.string().optional().describe("Optional extension filter without dot, for example md, js, json."),
      path: z.string().optional().describe("Optional path fragment filter, for example connect-ai-vault."),
      limit: z.number().int().min(1).max(100).optional().describe("Maximum results. Defaults to 30, capped at 100."),
      sort: z.enum(["name", "date", "size"]).optional().describe("Sort order. Defaults to name."),
      regex: z.boolean().optional().describe("Treat query as regex. Do not combine with ext/path for best results."),
      count: z.boolean().optional().describe("Return only result count."),
      includeTemp: z.boolean().optional().describe("Include AppData Local Temp results. Defaults to false."),
    }),
  },
  async ({ query, ext, path: pathFilter, limit, sort, regex, count, includeTemp }) => {
    const args = [];
    if (query) args.push("--query", query);
    if (ext) args.push("--ext", ext);
    if (pathFilter) args.push("--path", pathFilter);
    if (limit) args.push("--limit", String(limit));
    if (sort) args.push("--sort", sort);
    if (regex) args.push("--regex");
    if (count) args.push("--count");
    if (includeTemp) args.push("--include-temp");
    return runCli("everything-search.js", args);
  }
);

server.registerTool(
  "task_list",
  {
    title: "List Agent Manager tasks",
    description: "List queued Agent Manager tasks from globalStorage phase3/agent-queue.json. Read-only.",
    inputSchema: z.object({
      status: z.enum(["queued", "copied", "running", "ready_for_verification", "done", "blocked"]).optional().describe("Optional task status filter."),
    }),
  },
  async ({ status }) => {
    const args = ["list"];
    if (status) args.push("--status", status);
    return runCli("agent-queue.js", args);
  }
);

server.registerTool(
  "task_get",
  {
    title: "Get Agent Manager task",
    description: "Retrieve a single Agent Manager task by ID from globalStorage phase3/agent-queue.json. Read-only.",
    inputSchema: z.object({
      id: z.string().min(1).describe("Agent Manager task id, for example aq-..."),
    }),
  },
  async ({ id }) => runCli("agent-queue.js", ["get", "--id", id])
);

server.registerTool(
  "task_replan",
  {
    title: "Summarize Agent Manager queue and propose next wave",
    description: "Read the Agent Manager queue, write an append-only replan event/report, and return done/blocked/running/queued summaries plus next recommended claims.",
    inputSchema: z.object({
      worker: z.string().min(1).max(120).optional().describe("Optional orchestrator/session name. Defaults to hermes."),
      autoEscalateRisks: z.boolean().optional().describe("When true, enqueue one Hermes decision-request task for completed work that reports residual risks and has no existing decision task."),
    }),
  },
  async ({ worker, autoEscalateRisks }) => {
    const args = ["replan"];
    if (worker) args.push("--worker", worker);
    if (autoEscalateRisks) args.push("--auto-escalate-risks");
    return runCli("agent-queue.js", args);
  }
);

server.registerTool(
  "task_enqueue",
  {
    title: "Enqueue Agent Manager task",
    description: "Create a task in the Agent Manager queue for a Codex, Claude, Hermes, Gemini, Antigravity, or local-LLM session. This only queues a prompt; it does not auto-run another agent.",
    inputSchema: z.object({
      assignee: z.enum(["codex", "claude", "hermes", "gemini", "antigravity", "local-llm"]).describe("Target session type."),
      title: z.string().min(1).max(180).describe("Short task title."),
      prompt: z.string().min(1).max(12000).describe("Prompt to copy into the target session. Secrets are redacted by the queue CLI."),
      priority: z.enum(["P0", "P1", "P2"]).optional().describe("Task priority. Defaults to P1."),
      files: z.array(z.string().min(1).max(260)).max(20).optional().describe("Relevant file paths for the task."),
    }),
  },
  async ({ assignee, title, prompt, priority, files }) => {
    const args = ["add", "--assignee", assignee, "--title", title, "--prompt", prompt];
    if (priority) args.push("--priority", priority);
    for (const file of files || []) args.push("--file", file);
    return runCliWithGate(
      "agent-queue.js",
      args,
      {
        action: "prepare",
        departmentId: "orchestration",
        risk: "low",
        toolId: "task_enqueue",
        payload: { assignee, title, priority: priority || "P1", files: files || [] },
        reversible: true,
        dryRun: false,
      }
    );
  }
);

server.registerTool(
  "task_dispatch_goal",
  {
    title: "Dispatch one natural-language goal",
    description: "Create one guarded queue item from a natural-language goal and dispatch it to one executor. Executor output must stop at READY_FOR_VERIFICATION; DONE remains verifier-gated.",
    inputSchema: z.object({
      goal: z.string().min(1).max(4000).describe("Natural-language task goal from Pin or Connect AI."),
      executor: z.enum(["auto", "antigravity", "codex", "gemini", "local-llm"]).optional().describe("Executor route. Defaults to auto."),
      files: z.array(z.string().min(1).max(500)).min(1).max(10).describe("Target files. Obsidian vault paths are rejected."),
      writeScope: z.array(z.string().min(1).max(500)).max(10).optional().describe("Allowed write scope. Defaults to files."),
      expectedTests: z.array(z.string().min(1).max(500)).max(10).optional().describe("Current-run tests or evidence required from the executor."),
      rollbackPath: z.string().min(1).max(1000).optional().describe("How to undo this bounded task."),
      risk: z.enum(["Green", "Yellow", "Red"]).optional().describe("Queue risk class. Red requires approval."),
      priority: z.enum(["P0", "P1", "P2"]).optional().describe("Queue priority. Defaults to P2."),
      reviewer: z.string().min(1).max(120).optional().describe("Reviewer label. Defaults to pending-s7."),
      tokenBudget: z.string().min(1).max(120).optional().describe("Executor token budget label."),
      retryBudget: z.number().int().min(0).max(3).optional().describe("Retry budget."),
      runDir: z.string().min(1).max(500).optional().describe("Runtime artifact directory under companyDir."),
      ensureFile: z.boolean().optional().describe("Create missing target files with a smoke body before dispatch."),
      localModel: z.string().min(1).max(120).optional().describe("Optional Ollama model for local-llm."),
      geminiModel: z.enum(["gemini-2.5-flash", "gemini-2.5-pro", "gemini-3-pro-preview"]).optional().describe("Optional Gemini CLI model for executor=gemini or model-specific auto routing."),
      processTimeoutMs: z.number().int().min(1000).max(900000).optional().describe("Process timeout for executor adapters."),
      executorTimeoutMs: z.number().int().min(1000).max(900000).optional().describe("Executor timeout override."),
    }),
  },
  async (input) => {
    let request;
    let args;
    try {
      request = taskDispatchGoal.normalizeRequest(input);
      args = taskDispatchGoal.buildDispatchArgs(request);
    } catch (error) {
      return textResult(JSON.stringify({
        success: false,
        error: "task_dispatch_goal_invalid_request",
        message: error.message || String(error),
      }, null, 2), true);
    }

    const gateRisk = request.risk === "Red" ? "high" : request.risk === "Yellow" ? "medium" : "low";
    return runCliWithGate(
      "queue-dispatcher.js",
      args,
      {
        action: "run",
        departmentId: "orchestration",
        risk: gateRisk,
        toolId: "task_dispatch_goal",
        payload: {
          executor: request.executor,
          geminiModel: request.geminiModel,
          files: request.files,
          writeScope: request.writeScope,
          expectedTests: request.expectedTests,
          priority: request.priority,
        },
        reversible: true,
        dryRun: false,
      }
    );
  }
);

server.registerTool(
  "task_dispatch_verification",
  {
    title: "Dispatch verifier tasks for RFV queue items",
    description: "Plan or enqueue read-only verifier tasks for Agent Manager items waiting in READY_FOR_VERIFICATION. This does not run reviewers or mark source tasks DONE.",
    inputSchema: z.object({
      execute: z.boolean().optional().describe("When true, enqueue verifier tasks. Defaults to dry-run planning only."),
      reviewer: z.enum(["gemini", "antigravity"]).optional().describe("Optional verifier route. Defaults to alternating Gemini/Antigravity."),
      max: z.number().int().min(1).max(20).optional().describe("Maximum verifier tasks to plan or enqueue. Defaults to verification-dispatch.js default."),
      includeUnverifiedDone: z.boolean().optional().describe("Include legacy done items that lack verifier evidence. Defaults to false."),
    }),
  },
  async ({ execute, reviewer, max, includeUnverifiedDone }) => {
    const args = [];
    if (execute) args.push("--execute");
    if (reviewer) args.push("--reviewer", reviewer);
    if (max) args.push("--max", String(max));
    if (includeUnverifiedDone) args.push("--include-unverified-done");
    return runCliWithGate(
      "verification-dispatch.js",
      args,
      {
        action: "prepare",
        departmentId: "orchestration",
        risk: "low",
        toolId: "task_dispatch_verification",
        payload: {
          execute: Boolean(execute),
          reviewer: reviewer || "auto",
          max: max || null,
          includeUnverifiedDone: Boolean(includeUnverifiedDone),
        },
        reversible: true,
        dryRun: !execute,
      }
    );
  }
);

server.registerTool(
  "task_apply_verification",
  {
    title: "Apply verifier evidence to RFV queue items",
    description: "Plan or apply existing verified verifier evidence from verification-dispatch.js. This never runs reviewers; it only closes source tasks when a verifier task already contains accepted verifier evidence.",
    inputSchema: z.object({
      execute: z.boolean().optional().describe("When true, apply verified verifier evidence to source tasks. Defaults to dry-run planning only."),
    }),
  },
  async ({ execute }) => {
    const args = ["--apply"];
    if (execute) args.push("--execute");
    return runCliWithGate(
      "verification-dispatch.js",
      args,
      {
        action: "prepare",
        departmentId: "orchestration",
        risk: "low",
        toolId: "task_apply_verification",
        payload: {
          execute: Boolean(execute),
          source: "existing verified verifier evidence",
        },
        reversible: true,
        dryRun: !execute,
      }
    );
  }
);

server.registerTool(
  "task_update_status",
  {
    title: "Update Agent Manager task status",
    description: "Update a task status in the Agent Manager queue. This does not execute code; it only tracks coordination state.",
    inputSchema: z.object({
      id: z.string().min(1).describe("Agent Manager task id, for example aq-..."),
      status: z.enum(["queued", "copied", "running", "ready_for_verification", "done", "blocked"]).describe("New coordination status."),
      resultSummary: z.string().max(3000).optional().describe("Optional non-secret result summary."),
    }),
  },
  async ({ id, status, resultSummary }) => {
    const args = ["update", "--id", id, "--status", status];
    if (resultSummary) args.push("--result-summary", resultSummary);
    return runCliWithGate(
      "agent-queue.js",
      args,
      {
        action: "prepare",
        departmentId: "orchestration",
        risk: "low",
        toolId: "task_update_status",
        payload: { id, status },
        reversible: true,
        dryRun: false,
      }
    );
  }
);

server.registerTool(
  "task_claim",
  {
    title: "Claim next Agent Manager task",
    description: "Atomically claim the next queued or copied task for a Codex, Claude, Hermes, Gemini, Antigravity, or local-LLM worker. Copied tasks are recovered first, then queued tasks. The task is moved to running and its prompt is returned.",
    inputSchema: z.object({
      assignee: z.enum(["codex", "claude", "hermes", "gemini", "antigravity", "local-llm"]).describe("Worker type to claim work for."),
      worker: z.string().min(1).max(120).optional().describe("Optional worker/session name."),
    }),
  },
  async ({ assignee, worker }) => {
    const args = ["claim", "--assignee", assignee];
    if (worker) args.push("--worker", worker);
    return runCliWithGate(
      "agent-queue.js",
      args,
      {
        action: "prepare",
        departmentId: "orchestration",
        risk: "low",
        toolId: "task_claim",
        payload: { assignee, worker: worker || null },
        reversible: true,
        dryRun: false,
      }
    );
  }
);

server.registerTool(
  "task_claim_copied",
  {
    title: "Claim next copied Agent Manager task (recovery)",
    description: "Atomically claim the next copied task for a Codex, Claude, Hermes, Gemini, Antigravity, or local-LLM worker. Use this to recover tasks stuck in copied state after prompt handoffs. The task is moved to running and its prompt is returned.",
    inputSchema: z.object({
      assignee: z.enum(["codex", "claude", "hermes", "gemini", "antigravity", "local-llm"]).describe("Worker type to claim work for."),
      worker: z.string().min(1).max(120).optional().describe("Optional worker/session name."),
    }),
  },
  async ({ assignee, worker }) => {
    const args = ["claim-copied", "--assignee", assignee];
    if (worker) args.push("--worker", worker);
    return runCliWithGate(
      "agent-queue.js",
      args,
      {
        action: "prepare",
        departmentId: "orchestration",
        risk: "low",
        toolId: "task_claim_copied",
        payload: { assignee, worker: worker || null },
        reversible: true,
        dryRun: false,
      }
    );
  }
);

server.registerTool(
  "youtube_ingest",
  {
    title: "Ingest YouTube URL",
    description: "Run the Connect AI YouTube ingest pipeline for a URL.",
    inputSchema: z.object({
      url: z.string().url().describe("YouTube URL to ingest."),
    }),
  },
  async ({ url }) => runCliWithGate(
    "youtube-ingest.js",
    [url],
    {
      action: "run",
      departmentId: "youtube-intelligence",
      risk: "medium",
      toolId: "youtube_ingest",
      externalSend: true,
      payload: { url },
      reversible: false,
      dryRun: false,
    }
  )
);

server.registerTool(
  "lilys_session_check",
  {
    title: "Check Lilys login session",
    description: "Check whether the Windows Lilys Chrome profile is reachable and logged in.",
    inputSchema: z.object({}),
  },
  async () => runCli("lilys-cli.js", ["session-check"])
);

server.registerTool(
  "lilys_ensure_login",
  {
    title: "Ensure Lilys login",
    description: "Ensure Lilys is logged in through the Windows Chrome profile. Uses locally stored Windows DPAPI credentials if needed.",
    inputSchema: z.object({}),
  },
  async () => runCliWithGate(
    "lilys-cli.js",
    ["ensure-login"],
    {
      action: "run",
      departmentId: "youtube-intelligence",
      risk: "high",
      toolId: "lilys_ensure_login",
      touchesSecrets: true,
      externalSend: true,
      reversible: false,
      dryRun: false,
    }
  )
);

server.registerTool(
  "lilys_export_json",
  {
    title: "Export Lilys JSON",
    description: "Export the current or specified Lilys digest as JSON through the logged-in Windows Chrome profile.",
    inputSchema: z.object({
      digestUrl: z.string().url().optional().describe("Optional Lilys digest URL. Uses the current digest tab when omitted."),
      videoId: z.string().optional().describe("Optional output id prefix. Defaults to the script default when omitted."),
    }),
  },
  async ({ digestUrl, videoId }) => {
    const args = ["export-json"];
    if (digestUrl) args.push(digestUrl);
    if (videoId) args.push(videoId);
    return runCliWithGate(
      "lilys-cli.js",
      args,
      {
        action: "run",
        departmentId: "youtube-intelligence",
        risk: "medium",
        toolId: "lilys_export_json",
        externalSend: true,
        payload: { digestUrl: digestUrl || null, videoId: videoId || null },
        reversible: true,
        dryRun: false,
      }
    );
  }
);

server.registerTool(
  "lilys_ingest_youtube_url",
  {
    title: "Ingest YouTube URL to Lilys",
    description: "Create a new Lilys project from YouTube URL and export as JSON. Includes session check, login ensure, project creation, and JSON export.",
    inputSchema: z.object({
      url: z.string().url().describe("YouTube URL to ingest into Lilys."),
      videoId: z.string().optional().describe("Optional output video ID for the exported JSON file."),
    }),
  },
  async ({ url, videoId }) => {
    const args = [url];
    if (videoId) args.push(videoId);
    return runCliWithGate(
      "lilys-ingest-youtube.js",
      args,
      {
        action: "run",
        departmentId: "youtube-intelligence",
        risk: "medium",
        toolId: "lilys_ingest_youtube_url",
        externalSend: true,
        payload: { url, videoId: videoId || null },
        reversible: false,
        dryRun: false,
      }
    );
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
