#!/usr/bin/env node

/**
 * Connect AI Agent Coordinator
 * 
 * 에이전트 상호연결 및 작업 조율 - 재귀 MCP 메시 구현
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

class AgentCoordinator {
  constructor(configPath = null) {
    this.configPath = configPath || path.join(__dirname, '../config/agent-coordinator.json');
    this.config = this.loadConfig();
    this.statePath = path.join(__dirname, '../state/agent-coordinator');
    this.initState();
  }

  loadConfig() {
    try {
      if (fs.existsSync(this.configPath)) {
        return JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
      }
    } catch (error) {
      console.warn('Failed to load config, using defaults:', error.message);
    }

    // 기본 설정
    return {
      agents: {
        hermes: {
          type: 'primary',
          endpoint: 'local',
          capabilities: ['routing', 'delegation', 'coordination']
        },
        codex: {
          type: 'worker',
          endpoint: 'delegate',
          capabilities: ['implementation', 'analysis', 'testing']
        },
        claude: {
          type: 'expert',
          endpoint: 'bedrock',
          capabilities: ['design', 'review', 'complex_reasoning']
        }
      },
      routing_rules: {
        analysis: ['hermes', 'codex'],
        implementation: ['codex', 'claude'],
        design: ['claude', 'hermes'],
        review: ['claude', 'codex'],
        coordination: ['hermes']
      }
    };
  }

  initState() {
    if (!fs.existsSync(this.statePath)) {
      fs.mkdirSync(this.statePath, { recursive: true });
    }
  }

  /**
   * 작업 위임
   * @param {Object} task - 작업 정보
   * @param {string} task.type - 작업 유형
   * @param {Object} task.payload - 작업 페이로드
   * @param {Array} task.preferred_agents - 선호 에이전트
   */
  async delegateTask(task) {
    const taskId = this.generateTaskId();
    const taskWithId = {
      ...task,
      id: taskId,
      status: 'pending',
      created_at: new Date().toISOString(),
      history: []
    };

    // 에이전트 선택
    const selectedAgent = this.selectAgent(task);
    
    console.log(`Delegating task ${taskId} to ${selectedAgent}`);
    
    // 작업 상태 저장
    this.saveTaskState(taskWithId);
    
    try {
      // 에이전트에게 작업 전달
      const result = await this.executeTask(selectedAgent, taskWithId);
      
      // 결과 저장
      const completedTask = {
        ...taskWithId,
        status: 'completed',
        completed_at: new Date().toISOString(),
        result,
        executed_by: selectedAgent
      };
      
      this.saveTaskState(completedTask);
      
      console.log(`Task ${taskId} completed by ${selectedAgent}`);
      return completedTask;
      
    } catch (error) {
      console.error(`Task ${taskId} failed:`, error.message);
      
      const failedTask = {
        ...taskWithId,
        status: 'failed',
        failed_at: new Date().toISOString(),
        error: error.message,
        executed_by: selectedAgent
      };
      
      this.saveTaskState(failedTask);
      
      // Fallback 시도
      if (this.config.agents[selectedAgent].type !== 'primary') {
        console.log(`Attempting fallback to primary agent...`);
        return this.delegateTask({
          ...task,
          preferred_agents: ['hermes'],
          fallback_reason: `${selectedAgent} failed: ${error.message}`
        });
      }
      
      throw error;
    }
  }

  /**
   * 에이전트 선택
   */
  selectAgent(task) {
    const { type, preferred_agents = [] } = task;
    
    // 선호 에이전트가 있으면 우선
    if (preferred_agents.length > 0) {
      for (const agent of preferred_agents) {
        if (this.config.agents[agent]) {
          return agent;
        }
      }
    }
    
    // 라우팅 규칙에 따라 선택
    const ruleAgents = this.config.routing_rules[type] || ['hermes'];
    
    for (const agent of ruleAgents) {
      if (this.config.agents[agent]) {
        return agent;
      }
    }
    
    // 기본값
    return 'hermes';
  }

  /**
   * 작업 실행
   */
  async executeTask(agent, task) {
    const agentConfig = this.config.agents[agent];
    
    switch (agentConfig.endpoint) {
      case 'local':
        return this.executeLocalTask(task);
      
      case 'delegate':
        return this.executeDelegateTask(task);
      
      case 'bedrock':
        return this.executeBedrockTask(task);
      
      default:
        throw new Error(`Unknown endpoint: ${agentConfig.endpoint}`);
    }
  }

  /**
   * 로컬 작업 실행 (Hermes)
   */
  async executeLocalTask(task) {
    return new Promise((resolve, reject) => {
      const hermes = spawn('hermes', ['chat'], {
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';

      hermes.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      hermes.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      hermes.on('close', (code) => {
        if (code === 0) {
          resolve({
            stdout: stdout.trim(),
            agent: 'hermes',
            execution_time: Date.now() - new Date(task.created_at).getTime()
          });
        } else {
          reject(new Error(`Hermes execution failed: ${stderr.trim()}`));
        }
      });

      hermes.on('error', (error) => {
        reject(new Error(`Failed to spawn hermes: ${error.message}`));
      });

      // 작업 페이로드 전달
      const prompt = this.buildTaskPrompt(task);
      hermes.stdin.write(prompt);
      hermes.stdin.end();
    });
  }

  /**
   * 위임 작업 실행 (Codex)
   */
  async executeDelegateTask(task) {
    return new Promise((resolve, reject) => {
      const hermes = spawn('hermes', ['delegate', '--goal', task.payload.goal || task.type], {
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';

      hermes.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      hermes.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      hermes.on('close', (code) => {
        if (code === 0) {
          resolve({
            stdout: stdout.trim(),
            agent: 'codex',
            execution_time: Date.now() - new Date(task.created_at).getTime()
          });
        } else {
          reject(new Error(`Codex delegation failed: ${stderr.trim()}`));
        }
      });

      hermes.on('error', (error) => {
        reject(new Error(`Failed to delegate to codex: ${error.message}`));
      });
    });
  }

  /**
   * Bedrock 작업 실행 (Claude)
   */
  async executeBedrockTask(task) {
    // Claude API 연동 (TODO: 구현 필요)
    return new Promise((resolve, reject) => {
      // 임시로 Hermes를 통해 Claude 시뮬레이션
      const hermes = spawn('hermes', ['chat'], {
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';

      hermes.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      hermes.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      hermes.on('close', (code) => {
        if (code === 0) {
          resolve({
            stdout: stdout.trim(),
            agent: 'claude',
            execution_time: Date.now() - new Date(task.created_at).getTime()
          });
        } else {
          reject(new Error(`Claude execution failed: ${stderr.trim()}`));
        }
      });

      hermes.on('error', (error) => {
        reject(new Error(`Failed to execute claude: ${error.message}`));
      });

      const prompt = this.buildTaskPrompt(task);
      hermes.stdin.write(prompt);
      hermes.stdin.end();
    });
  }

  /**
   * 작업 프롬프트 빌드
   */
  buildTaskPrompt(task) {
    const { type, payload } = task;
    
    return `Please execute the following ${type} task:

${JSON.stringify(payload, null, 2)}

Provide a detailed response with:
1. Analysis of the task
2. Step-by-step execution
3. Results and recommendations
4. Any issues encountered

Respond in Korean.`;
  }

  /**
   * 작업 상태 저장
   */
  saveTaskState(task) {
    const stateFile = path.join(this.statePath, `task-${task.id}.json`);
    fs.writeFileSync(stateFile, JSON.stringify(task, null, 2));
  }

  /**
   * 작업 상태 로드
   */
  loadTaskState(taskId) {
    const stateFile = path.join(this.statePath, `task-${taskId}.json`);
    
    if (!fs.existsSync(stateFile)) {
      return null;
    }
    
    return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  }

  /**
   * 작업 ID 생성
   */
  generateTaskId() {
    return `task-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * 에이전트 상태 조회
   */
  getAgentStatus() {
    const agents = {};
    
    Object.keys(this.config.agents).forEach(agentName => {
      const agent = this.config.agents[agentName];
      agents[agentName] = {
        type: agent.type,
        endpoint: agent.endpoint,
        capabilities: agent.capabilities,
        status: 'available' // TODO: 실제 상태 확인
      };
    });
    
    return agents;
  }

  /**
   * 작업 히스토리 조회
   */
  getTaskHistory(limit = 10) {
    if (!fs.existsSync(this.statePath)) {
      return [];
    }

    const files = fs.readdirSync(this.statePath)
      .filter(file => file.startsWith('task-') && file.endsWith('.json'))
      .sort()
      .reverse()
      .slice(0, limit);

    return files.map(file => {
      const filePath = path.join(this.statePath, file);
      const task = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      
      return {
        id: task.id,
        type: task.type,
        status: task.status,
        created_at: task.created_at,
        completed_at: task.completed_at,
        executed_by: task.executed_by
      };
    });
  }
}

// CLI 인터페이스
if (require.main === module) {
  const args = process.argv.slice(2);
  const command = args[0];
  
  const coordinator = new AgentCoordinator();

  switch (command) {
    case 'delegate':
      if (args.length < 2) {
        console.error('Usage: node coordinator.js delegate <taskType> [payload]');
        process.exit(1);
      }
      
      const taskType = args[1];
      const payload = args[2] ? JSON.parse(args[2]) : {};
      
      coordinator.delegateTask({
        type: taskType,
        payload
      })
      .then(result => {
        console.log('Task completed:', JSON.stringify(result, null, 2));
      })
      .catch(error => {
        console.error('Task failed:', error.message);
        process.exit(1);
      });
      break;

    case 'status':
      console.log('Agent Status:', JSON.stringify(coordinator.getAgentStatus(), null, 2));
      break;

    case 'history':
      const limit = parseInt(args[1]) || 10;
      console.log('Task History:', coordinator.getTaskHistory(limit));
      break;

    default:
      console.log(`
Connect AI Agent Coordinator

Usage:
  node coordinator.js delegate <taskType> [payload]  - Delegate task to agent
  node coordinator.js status                         - Show agent status
  node coordinator.js history [limit]               - Show task history

Task types:
  analysis      - Analysis tasks
  implementation - Implementation tasks
  design        - Design tasks
  review        - Review tasks

Examples:
  node coordinator.js delegate analysis '{"goal":"Analyze system performance"}'
  node coordinator.js delegate implementation '{"goal":"Build new feature"}'
  node coordinator.js status
      `);
      break;
  }
}

module.exports = AgentCoordinator;
