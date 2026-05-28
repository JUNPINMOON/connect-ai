#!/usr/bin/env node

/**
 * Connect AI Hermes Integration
 * 
 * Hermes와 모델 라우터 연동 - 자동 모델 선택 및 실행
 */

const ModelRouter = require('./model-router');
const { spawn } = require('child_process');
const { inferRiskClass } = require('../scripts/agent-policy.js');

class HermesIntegration {
  constructor() {
    this.router = new ModelRouter();
  }

  /**
   * 자동 모델 선택으로 Hermes 실행
   * @param {string} prompt - 실행할 프롬프트
   * @param {string} action - 작업 유형 (선택사항, 자동 분류됨)
   * @param {string} risk - 리스크 레벨 (기본값: low)
   */
  async executeWithRouting(prompt, action = null, risk = null) {
    const riskClass = this.classifyRiskClass(prompt, action);
    if (riskClass === 'Red') {
      throw new Error('Hermes observer cannot execute Red-risk tasks. Human approval and executor dispatch are required.');
    }
    // 작업 유형 자동 분류
    const taskAction = action || this.classifyAction(prompt);
    const routerRisk = risk || this.toRouterRisk(riskClass);
    
    // 최적 모델 선택
    const task = {
      action: taskAction,
      risk: routerRisk,
      riskClass,
      context: { prompt }
    };
    
    const decision = this.router.selectModel(task);
    this.router.logDecision(task, decision);

    // 모델에 따라 실행 방식 선택
    switch (decision.provider) {
      case 'openrouter':
        return this.requireQueueDispatch('antigravity', decision, task);
      
      case 'delegate':
        return this.executeDelegate(prompt, decision.model, decision, task);
      
      case 'local':
        return this.requireQueueDispatch('local-llm', decision, task);
      
      case 'bedrock':
        return this.requireQueueDispatch('antigravity', decision, task);
      
      default:
        throw new Error(`Unknown provider: ${decision.provider}`);
    }
  }

  /**
   * 프롬프트에서 작업 유형 자동 분류
   */
  classifyAction(prompt) {
    const riskClass = this.classifyRiskClass(prompt);
    if (riskClass === 'Red') return 'sensitive';
    if (riskClass === 'Yellow') return 'implementation';
    const promptLower = prompt.toLowerCase();
    
    if (promptLower.includes('analyze') || 
        promptLower.includes('분석') || 
        promptLower.includes('review') || 
        promptLower.includes('status') ||
        promptLower.includes('diagnose')) {
      return 'analysis';
    }

    if (promptLower.includes('implement') || 
        promptLower.includes('create') || 
        promptLower.includes('build') ||
        promptLower.includes('write') ||
        promptLower.includes('develop') ||
        promptLower.includes('구현') ||
        promptLower.includes('만들') ||
        promptLower.includes('개발')) {
      return 'implementation';
    }

    if (promptLower.includes('delete') || 
        promptLower.includes('deploy') || 
        promptLower.includes('publish') ||
        promptLower.includes('secret') ||
        promptLower.includes('credential') ||
        promptLower.includes('삭제') ||
        promptLower.includes('배포') ||
        promptLower.includes('비밀')) {
      return 'sensitive';
    }

    if (promptLower.includes('design') || 
        promptLower.includes('generate') || 
        promptLower.includes('compose') ||
        promptLower.includes('design') ||
        promptLower.includes('생성') ||
        promptLower.includes('디자인')) {
      return 'creative';
    }

    return 'analysis';
  }

  classifyRiskClass(prompt, action = null) {
    return inferRiskClass({
      title: action || '',
      prompt: String(prompt || ''),
      assignee: 'hermes',
    });
  }

  toRouterRisk(riskClass) {
    if (riskClass === 'Red') return 'high';
    if (riskClass === 'Yellow') return 'medium';
    return 'low';
  }

  /**
   * Hermes 직접 실행 (OpenRouter 모델)
   */
  async executeHermes(prompt, model) {
    return new Promise((resolve, reject) => {
      const hermes = spawn('hermes', ['-z', prompt, '-m', model], {
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
            provider: 'openrouter',
            model: model,
            response: stdout.trim(),
            execution_time: Date.now()
          });
        } else {
          reject(new Error(`Hermes execution failed: ${stderr.trim()}`));
        }
      });

      hermes.on('error', (error) => {
        reject(new Error(`Failed to spawn hermes: ${error.message}`));
      });
    });
  }

  /**
   * Codex 위임 실행
   */
  async executeDelegate(prompt, model, decision = {}, task = {}) {
    return this.requireQueueDispatch(String(model || decision.model || 'codex'), decision, task);
  }

  requireQueueDispatch(executor, decision = {}, task = {}) {
    const targetExecutor = String(executor || 'codex');
    const requestedModel = String(decision.model || targetExecutor);
    const error = new Error(
      `QUEUE_DISPATCH_REQUIRED: Hermes observer cannot execute routed ${task.action || 'model'} tasks directly. ` +
      `Use task_dispatch_goal with executor=${targetExecutor}; queue workers must return READY_FOR_VERIFICATION before verifier review.`
    );
    error.code = 'QUEUE_DISPATCH_REQUIRED';
    error.details = {
      status: 'BLOCKED',
      reason: 'QUEUE_DISPATCH_REQUIRED',
      queueTool: 'task_dispatch_goal',
      executor: targetExecutor,
      reviewer: 'pending-s7',
      requestedProvider: decision.provider || 'delegate',
      requestedModel,
      riskClass: task.riskClass || '',
      routerRisk: task.risk || '',
    };
    throw error;
  }

  /**
   * 로컬 모델 실행
   */
  async executeLocal(prompt) {
    // TODO: 로컬 모델 연동 구현
    return {
      provider: 'local',
      model: 'local',
      response: 'Local model execution not yet implemented',
      execution_time: Date.now()
    };
  }

  /**
   * Bedrock 모델 실행 (Claude)
   */
  async executeBedrock(prompt) {
    // TODO: Bedrock API 연동 구현
    return new Promise((resolve, reject) => {
      const hermes = spawn('hermes', ['-z', prompt], {
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
            provider: 'bedrock',
            model: 'claude-sonnet-4',
            response: stdout.trim(),
            execution_time: Date.now()
          });
        } else {
          reject(new Error(`Bedrock execution failed: ${stderr.trim()}`));
        }
      });

      hermes.on('error', (error) => {
        reject(new Error(`Failed to execute bedrock: ${error.message}`));
      });
    });
  }

  /**
   * 배치 실행
   */
  async executeBatch(prompts, defaultRisk = 'low') {
    const results = [];
    
    for (const prompt of prompts) {
      try {
        const result = await this.executeWithRouting(prompt, null, defaultRisk);
        results.push({
          prompt: prompt.substring(0, 50) + '...',
          success: true,
          result
        });
      } catch (error) {
        results.push({
          prompt: prompt.substring(0, 50) + '...',
          success: false,
          error: error.message
        });
      }
    }
    
    return results;
  }
}

// CLI 인터페이스
if (require.main === module) {
  const args = process.argv.slice(2);
  const command = args[0];
  
  const integration = new HermesIntegration();

  switch (command) {
    case 'execute':
      if (args.length < 2) {
        console.error('Usage: node hermes-integration.js execute <prompt> [risk]');
        process.exit(1);
      }
      
      const prompt = args[1];
      const risk = args[2] || 'low';
      
      integration.executeWithRouting(prompt, null, risk)
        .then(result => {
          console.log('Execution result:', JSON.stringify(result, null, 2));
        })
        .catch(error => {
          console.error('Execution failed:', error.message);
          process.exit(1);
        });
      break;

    case 'batch':
      if (args.length < 2) {
        console.error('Usage: node hermes-integration.js batch <prompt1,prompt2,...> [risk]');
        process.exit(1);
      }
      
      const prompts = args[1].split(',').map(p => p.trim());
      const batchRisk = args[2] || 'low';
      
      integration.executeBatch(prompts, batchRisk)
        .then(results => {
          console.log('Batch execution results:');
          results.forEach((result, index) => {
            console.log(`\n${index + 1}. ${result.prompt}`);
            if (result.success) {
              console.log('✅ Success:', result.result.provider, result.result.model);
            } else {
              console.log('❌ Failed:', result.error);
            }
          });
        })
        .catch(error => {
          console.error('Batch execution failed:', error.message);
          process.exit(1);
        });
      break;

    default:
      console.log(`
Connect AI Hermes Integration

Usage:
  node hermes-integration.js execute <prompt> [risk]     - Classify routing and require guarded queue dispatch
  node hermes-integration.js batch <prompts> [risk]      - Classify batch routing without direct model execution

Examples:
  node hermes-integration.js execute "Analyze system performance"
  node hermes-integration.js execute "Implement new feature" medium
  node hermes-integration.js batch "task1,task2,task3" low

The system will automatically:
1. Classify the task type (analysis/implementation/sensitive/creative)
2. Select the optimal model based on routing rules
3. Require task_dispatch_goal / guarded queue dispatch before any executor or reviewer runs
      `);
      break;
  }
}

module.exports = HermesIntegration;
