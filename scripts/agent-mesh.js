#!/usr/bin/env node

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const crypto = require("crypto");
const envPaths = require("./env-paths.js");

const allowedQueueStatuses = new Set(["queued", "copied", "running", "ready_for_verification", "done", "blocked"]);

function isWsl() {
    return process.platform === "linux" && fs.existsSync("/mnt/c");
}

function currentWindowsUser() {
    try {
        return process.env.CONNECT_AI_WINDOWS_USER || process.env.USERNAME || process.env.USER || os.userInfo().username || path.basename(os.homedir());
    } catch {
        return process.env.CONNECT_AI_WINDOWS_USER || process.env.USERNAME || process.env.USER || path.basename(os.homedir());
    }
}

function defaultAgentQueuePath() {
    if (process.env.CONNECT_AI_AGENT_QUEUE) return process.env.CONNECT_AI_AGENT_QUEUE;
    if (process.env.APPDATA) {
        return path.join(process.env.APPDATA, "Code", "User", "globalStorage", "connectailab.connect-ai-lab", "phase3", "agent-queue.json");
    }
    if (isWsl()) {
        const user = currentWindowsUser();
        return `/mnt/c/Users/${user}/AppData/Roaming/Code/User/globalStorage/connectailab.connect-ai-lab/phase3/agent-queue.json`;
    }
    return path.join(os.homedir(), ".connect-ai", "globalStorage", "connectailab.connect-ai-lab", "phase3", "agent-queue.json");
}

function defaultMeshRootPath() {
    if (process.env.CONNECT_AI_AGENT_MESH_ROOT) return process.env.CONNECT_AI_AGENT_MESH_ROOT;
    return path.join(envPaths.companyDir(), "agent-mesh");
}

function redactQueueText(text, maxLen = 3000) {
    let value = String(text ?? "");
    value = value.replace(/\b((?:token|secret|password|passwd|api[_-]?key|client[_-]?secret|authorization|cookie|localStorage)\b\s*[:=]\s*)["']?[^"'\s,}]+/gi, "$1<redacted>");
    value = value.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi, "Bearer <redacted>");
    value = value.trim();
    return value.length > maxLen ? `${value.slice(0, maxLen)}\n...[truncated]` : value;
}

class AgentMesh {
    constructor(options = {}) {
        this.repoRoot = path.resolve(__dirname, "..");
        this.agentQueuePath = options.agentQueuePath || defaultAgentQueuePath();
        this.meshRoot = path.resolve(options.meshRoot || defaultMeshRootPath());
        this.agentsDir = path.join(this.meshRoot, "agents");
        this.coordinationDir = path.join(this.meshRoot, "coordination");
        this.stateDir = path.join(this.meshRoot, "agent-state");
        this.ensureDirectories();
        this.initializeAgents();
    }

    ensureDirectories() {
        [this.agentsDir, this.coordinationDir, this.stateDir].forEach(dir => {
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
        });
    }

    initializeAgents() {
        this.agents = {
            hermes: {
                name: "Hermes",
                type: "orchestrator",
                capabilities: ["coordination", "routing", "policy_enforcement"],
                endpoint: "hermes-cli",
                status: "active"
            },
            codex: {
                name: "Codex",
                type: "worker",
                capabilities: ["coding", "analysis", "implementation"],
                endpoint: "openai-codex",
                status: "active"
            },
            claude: {
                name: "Claude",
                type: "specialist",
                capabilities: ["design", "review", "complex_reasoning"],
                endpoint: "bedrock",
                status: "standby"
            },
            local: {
                name: "Local LLM",
                type: "worker",
                capabilities: ["quick_tasks", "simple_analysis"],
                endpoint: "local",
                status: "active"
            }
        };

        this.saveAgentState();
    }

    saveAgentState() {
        const stateFile = path.join(this.agentsDir, "registry.json");
        fs.writeFileSync(stateFile, JSON.stringify(this.agents, null, 2));
    }

    loadAgentState() {
        const stateFile = path.join(this.agentsDir, "registry.json");
        if (fs.existsSync(stateFile)) {
            const content = fs.readFileSync(stateFile, 'utf8');
            this.agents = JSON.parse(content);
        }
    }

    createTask(sourceAgent, targetAgent, task, priority = "normal") {
        const taskId = this.generateTaskId();
        const taskFile = path.join(this.coordinationDir, `${taskId}.json`);
        const taskText = typeof task === "object" && task !== null ? (task.description || task.prompt || "") : task;
        const agentQueueId = typeof task === "object" && task !== null
            ? (task.agentQueueId || task.agent_queue_id || task.queueId || task.queue_id || null)
            : null;
        
        const taskObj = {
            id: taskId,
            source: sourceAgent,
            target: targetAgent,
            task: taskText,
            agentQueueId,
            priority,
            status: "pending",
            created_at: new Date().toISOString(),
            metadata: {
                type: this.classifyTaskType(taskText),
                estimated_duration: this.estimateDuration(taskText),
                dependencies: []
            }
        };

        fs.writeFileSync(taskFile, JSON.stringify(taskObj, null, 2));
        console.log(`Created task ${taskId}: ${sourceAgent} → ${targetAgent}`);
        return taskId;
    }

    classifyTaskType(task) {
        const patterns = {
            coding: /코드|code|프로그래밍|programming|구현|implement/i,
            analysis: /분석|analyze|리서치|research|조사|investigate/i,
            design: /설계|design|아키텍처|architecture|검토|review/i,
            coordination: /조정|coordinate|위임|delegate|관리|manage/i
        };

        for (const [type, pattern] of Object.entries(patterns)) {
            if (pattern.test(task)) {
                return type;
            }
        }
        return "general";
    }

    estimateDuration(task) {
        const complexity = task.length > 200 ? "long" : task.length > 100 ? "medium" : "short";
        const durations = {
            short: 60,      // 1 minute
            medium: 300,    // 5 minutes
            long: 900       // 15 minutes
        };
        return durations[complexity];
    }

    executeTask(taskId) {
        const taskFile = path.join(this.coordinationDir, `${taskId}.json`);
        if (!fs.existsSync(taskFile)) {
            throw new Error(`Task ${taskId} not found`);
        }

        const task = JSON.parse(fs.readFileSync(taskFile, 'utf8'));
        const targetAgent = this.agents[task.target];

        if (!targetAgent) {
            throw new Error(`Agent ${task.target} not found`);
        }

        // Update task status
        task.status = "running";
        task.started_at = new Date().toISOString();
        fs.writeFileSync(taskFile, JSON.stringify(task, null, 2));

        // Execute based on agent type
        return this.executeAgentTask(task, targetAgent);
    }

    async executeAgentTask(task, agent) {
        console.log(`Executing task ${task.id} on ${agent.name}`);
        
        try {
            let result;
            
            switch (agent.endpoint) {
                case "hermes-cli":
                    result = await this.executeHermesTask(task);
                    break;
                case "openai-codex":
                    result = await this.executeCodexTask(task);
                    break;
                case "bedrock":
                    result = await this.executeClaudeTask(task);
                    break;
                case "local":
                    result = await this.executeLocalTask(task);
                    break;
                default:
                    throw new Error(`Unknown agent endpoint: ${agent.endpoint}`);
            }

            // Update task with result
            this.updateTaskResult(task.id, "completed", result);
            return result;

        } catch (error) {
            this.updateTaskResult(task.id, "failed", { error: error.message });
            throw error;
        }
    }

    async executeHermesTask(task) {
        // For Hermes, we use the current process
        return {
            agent: "hermes",
            result: "Task executed by Hermes orchestrator",
            metadata: {
                execution_time: Date.now() - new Date(task.started_at).getTime()
            }
        };
    }

    async executeCodexTask(task) {
        // This would integrate with Codex via MCP
        return new Promise((resolve) => {
            const result = {
                agent: "codex",
                result: "Task executed by Codex worker",
                metadata: {
                    execution_time: Date.now() - new Date(task.started_at).getTime()
                }
            };
            resolve(result);
        });
    }

    async executeClaudeTask(task) {
        // This would integrate with Claude via Bedrock
        return new Promise((resolve) => {
            const result = {
                agent: "claude",
                result: "Task executed by Claude specialist",
                metadata: {
                    execution_time: Date.now() - new Date(task.started_at).getTime()
                }
            };
            resolve(result);
        });
    }

    async executeLocalTask(task) {
        // This would integrate with local LLM
        return new Promise((resolve) => {
            const result = {
                agent: "local",
                result: "Task executed by Local LLM",
                metadata: {
                    execution_time: Date.now() - new Date(task.started_at).getTime()
                }
            };
            resolve(result);
        });
    }

    updateTaskResult(taskId, status, result) {
        const taskFile = path.join(this.coordinationDir, `${taskId}.json`);
        if (fs.existsSync(taskFile)) {
            const task = JSON.parse(fs.readFileSync(taskFile, 'utf8'));
            task.status = status;
            task.completed_at = new Date().toISOString();
            task.result = result;
            task.resultSummary = this.formatResultSummary(result);
            
            // Move to completed
            const completedDir = path.join(this.coordinationDir, "completed");
            if (!fs.existsSync(completedDir)) {
                fs.mkdirSync(completedDir);
            }
            
            fs.writeFileSync(path.join(completedDir, `${taskId}.json`), JSON.stringify(task, null, 2));
            fs.unlinkSync(taskFile);

            const queueId = task.agentQueueId || task.agent_queue_id || task.queueId || task.queue_id;
            if (queueId) {
                this.updateAgentQueueResult(
                    queueId,
                    status === "completed" ? "ready_for_verification" : status === "failed" ? "blocked" : status,
                    task.resultSummary
                );
            }
        }
    }

    formatResultSummary(result) {
        if (typeof result === "string") return redactQueueText(result);
        if (!result || typeof result !== "object") return redactQueueText(String(result ?? ""));
        const parts = [];
        if (result.agent) parts.push(`agent=${result.agent}`);
        if (result.result) parts.push(String(result.result));
        if (result.error) parts.push(`error=${result.error}`);
        if (result.metadata && typeof result.metadata.execution_time === "number") {
            parts.push(`execution_time_ms=${result.metadata.execution_time}`);
        }
        const summary = parts.length ? parts.join("; ") : JSON.stringify(result);
        return redactQueueText(summary);
    }

    atomicWriteJson(file, data) {
        const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
        fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
        fs.renameSync(tmp, file);
    }

    updateAgentQueueResult(queueId, status, resultSummary) {
        if (!queueId || !fs.existsSync(this.agentQueuePath)) return false;
        const queue = JSON.parse(fs.readFileSync(this.agentQueuePath, "utf8") || "[]");
        if (!Array.isArray(queue)) return false;
        const item = queue.find((entry) => entry && entry.id === queueId);
        if (!item) return false;
        const nextStatus = allowedQueueStatuses.has(status) ? status : item.status;
        item.status = nextStatus;
        item.resultSummary = redactQueueText(
            nextStatus === "ready_for_verification"
                ? `READY_FOR_VERIFICATION: ${resultSummary || "Agent mesh executor completed; separate verifier must confirm before DONE."}`
                : resultSummary
        );
        item.updatedAt = new Date().toISOString();
        if (nextStatus === "done" || nextStatus === "blocked") item.completedAt = item.updatedAt;
        if (nextStatus === "ready_for_verification") {
            item.agentOsStatus = "READY_FOR_VERIFICATION";
            delete item.completedAt;
        }
        this.atomicWriteJson(this.agentQueuePath, queue);
        return true;
    }

    createRecursiveChain(chainDescription) {
        const chainId = this.generateChainId();
        const chainFile = path.join(this.coordinationDir, `chain-${chainId}.json`);
        
        const chain = {
            id: chainId,
            description: chainDescription,
            status: "pending",
            created_at: new Date().toISOString(),
            steps: []
        };

        fs.writeFileSync(chainFile, JSON.stringify(chain, null, 2));
        return chainId;
    }

    addChainStep(chainId, agent, task, dependencies = []) {
        const chainFile = path.join(this.coordinationDir, `chain-${chainId}.json`);
        if (!fs.existsSync(chainFile)) {
            throw new Error(`Chain ${chainId} not found`);
        }

        const chain = JSON.parse(fs.readFileSync(chainFile, 'utf8'));
        const stepId = this.generateStepId();
        
        const step = {
            id: stepId,
            agent,
            task,
            dependencies,
            status: "pending",
            created_at: new Date().toISOString()
        };

        chain.steps.push(step);
        fs.writeFileSync(chainFile, JSON.stringify(chain, null, 2));
        
        return stepId;
    }

    executeChain(chainId) {
        const chainFile = path.join(this.coordinationDir, `chain-${chainId}.json`);
        if (!fs.existsSync(chainFile)) {
            throw new Error(`Chain ${chainId} not found`);
        }

        const chain = JSON.parse(fs.readFileSync(chainFile, 'utf8'));
        chain.status = "running";
        chain.started_at = new Date().toISOString();
        fs.writeFileSync(chainFile, JSON.stringify(chain, null, 2));

        console.log(`Executing recursive chain ${chainId}: ${chain.description}`);
        
        // Execute steps in dependency order
        return this.executeChainSteps(chain);
    }

    async executeChainSteps(chain) {
        const completedSteps = new Set();
        const results = {};

        while (completedSteps.size < chain.steps.length) {
            let progress = false;
            
            for (const step of chain.steps) {
                if (completedSteps.has(step.id)) continue;
                
                // Check dependencies
                const depsReady = step.dependencies.every(dep => completedSteps.has(dep));
                if (!depsReady) continue;
                
                // Execute step
                try {
                    const taskId = this.createTask("chain", step.agent, step.task);
                    const result = await this.executeTask(taskId);
                    results[step.id] = result;
                    completedSteps.add(step.id);
                    progress = true;
                    
                    console.log(`Chain step ${step.id} completed`);
                } catch (error) {
                    console.error(`Chain step ${step.id} failed:`, error.message);
                    throw error;
                }
            }
            
            if (!progress) {
                throw new Error("Chain execution stalled - circular dependency or unresolved dependencies");
            }
        }

        // Update chain status
        chain.status = "completed";
        chain.completed_at = new Date().toISOString();
        chain.results = results;
        
        const chainFile = path.join(this.coordinationDir, `chain-${chain.id}.json`);
        fs.writeFileSync(chainFile, JSON.stringify(chain, null, 2));
        
        return results;
    }

    shareState(fromAgent, toAgent, stateData) {
        const stateId = this.generateStateId();
        const stateFile = path.join(this.stateDir, `state-${stateId}.json`);
        
        const state = {
            id: stateId,
            from: fromAgent,
            to: toAgent,
            timestamp: new Date().toISOString(),
            data: stateData
        };

        fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
        console.log(`State shared: ${fromAgent} → ${toAgent} (${stateId})`);
        return stateId;
    }

    getState(stateId) {
        const stateFile = path.join(this.stateDir, `state-${stateId}.json`);
        if (fs.existsSync(stateFile)) {
            return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        }
        return null;
    }

    generateTaskId() {
        return `task_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    }

    generateChainId() {
        return `chain_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    }

    generateStepId() {
        return `step_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    }

    generateStateId() {
        return `state_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    }

    getStatus() {
        this.loadAgentState();
        
        const pendingTasks = fs.readdirSync(this.coordinationDir).filter(f => f.endsWith('.json'));
        const completedDir = path.join(this.coordinationDir, "completed");
        const completedTasks = fs.existsSync(completedDir)
            ? fs.readdirSync(completedDir).filter(f => f.endsWith('.json'))
            : [];
        const states = fs.readdirSync(this.stateDir).filter(f => f.startsWith('state-') && f.endsWith('.json'));
        
        return {
            agents: this.agents,
            tasks: {
                pending: pendingTasks.length,
                completed: completedTasks.length
            },
            states: states.length,
            timestamp: new Date().toISOString()
        };
    }
}

// CLI interface
function main() {
    const mesh = new AgentMesh();
    const command = process.argv[2];

    switch (command) {
        case "task":
            if (process.argv.length < 5) {
                console.error("Usage: agent-mesh.js task <source> <target> \"<task description>\"");
                process.exit(1);
            }
            const source = process.argv[3];
            const target = process.argv[4];
            const task = process.argv.slice(5).join(" ");
            const taskId = mesh.createTask(source, target, task);
            console.log(`Task ID: ${taskId}`);
            break;

        case "execute":
            if (!process.argv[3]) {
                console.error("Usage: agent-mesh.js execute <task_id>");
                process.exit(1);
            }
            mesh.executeTask(process.argv[3]).catch(console.error);
            break;

        case "chain":
            if (!process.argv[3]) {
                console.error("Usage: agent-mesh.js chain \"<chain description>\"");
                process.exit(1);
            }
            const chainId = mesh.createRecursiveChain(process.argv.slice(3).join(" "));
            console.log(`Chain ID: ${chainId}`);
            break;

        case "add-step":
            if (process.argv.length < 5) {
                console.error("Usage: agent-mesh.js add-step <chain_id> <agent> \"<task description>\"");
                process.exit(1);
            }
            const stepChainId = process.argv[3];
            const stepAgent = process.argv[4];
            const stepTask = process.argv.slice(5).join(" ");
            const stepId = mesh.addChainStep(stepChainId, stepAgent, stepTask);
            console.log(`Step ID: ${stepId}`);
            break;

        case "run-chain":
            if (!process.argv[3]) {
                console.error("Usage: agent-mesh.js run-chain <chain_id>");
                process.exit(1);
            }
            mesh.executeChain(process.argv[3]).catch(console.error);
            break;

        case "share-state":
            if (process.argv.length < 5) {
                console.error("Usage: agent-mesh.js share-state <from> <to> \"<state_data>\"");
                process.exit(1);
            }
            const fromAgent = process.argv[3];
            const toAgent = process.argv[4];
            const stateData = process.argv.slice(5).join(" ");
            const stateId = mesh.shareState(fromAgent, toAgent, stateData);
            console.log(`State ID: ${stateId}`);
            break;

        case "status":
            const status = mesh.getStatus();
            console.log(JSON.stringify(status, null, 2));
            break;

        default:
            console.log("Agent Mesh - Recursive Agent Interconnection");
            console.log("Commands:");
            console.log("  task <source> <target> \"<task>\"    - Create agent task");
            console.log("  execute <task_id>                  - Execute a task");
            console.log("  chain \"<description>\"              - Create recursive chain");
            console.log("  add-step <chain_id> <agent> \"<task>\" - Add step to chain");
            console.log("  run-chain <chain_id>               - Execute recursive chain");
            console.log("  share-state <from> <to> \"<data>\"  - Share agent state");
            console.log("  status                             - Show mesh status");
            break;
    }
}

if (require.main === module) {
    main();
}

module.exports = AgentMesh;
