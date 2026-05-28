#!/usr/bin/env node

/**
 * Connect AI Model Router
 * 
 * 자동 모델 라우팅 엔진 - 작업 유형과 리스크에 따라 최적의 모델을 선택
 */

const fs = require('fs');
const path = require('path');

class ModelRouter {
  constructor(configPath = null) {
    this.configPath = configPath || path.join(__dirname, '../config/model-routing.json');
    this.config = this.loadConfig();
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
      routing_rules: [
        {
          task_type: "analysis",
          risk: "low",
          model: "z-ai/glm-4.6",
          provider: "openrouter"
        },
        {
          task_type: "implementation",
          risk: "medium", 
          model: "codex",
          provider: "delegate"
        },
        {
          task_type: "sensitive",
          risk: "high",
          model: "local",
          provider: "local"
        },
        {
          task_type: "creative",
          risk: "low",
          model: "claude-sonnet-4",
          provider: "bedrock"
        }
      ],
      fallback_model: {
        provider: "openrouter",
        model: "z-ai/glm-4.6"
      }
    };
  }

  /**
   * 작업에 대한 최적 모델 선택
   * @param {Object} task - 작업 정보
   * @param {string} task.action - 작업 유형
   * @param {string} task.risk - 리스크 레벨 (low/medium/high)
   * @param {Object} task.context - 추가 컨텍스트
   * @returns {Object} 선택된 모델 정보
   */
  selectModel(task) {
    const { action, risk = 'low', context = {} } = task;
    
    // 작업 유형 분류
    const taskType = this.classifyTask(action);
    
    // 라우팅 규칙 검색
    const rule = this.config.routing_rules.find(rule => 
      rule.task_type === taskType && rule.risk === risk
    );

    if (rule) {
      return {
        provider: rule.provider,
        model: rule.model,
        reasoning: `Matched rule: ${taskType}/${risk}`,
        confidence: 0.9
      };
    }

    // 부분 매칭 시도
    const partialRule = this.config.routing_rules.find(rule => 
      rule.task_type === taskType || rule.risk === risk
    );

    if (partialRule) {
      return {
        provider: partialRule.provider,
        model: partialRule.model,
        reasoning: `Partial match: ${taskType}/${risk}`,
        confidence: 0.7
      };
    }

    // fallback
    return {
      provider: this.config.fallback_model.provider,
      model: this.config.fallback_model.model,
      reasoning: 'No matching rule, using fallback',
      confidence: 0.5
    };
  }

  /**
   * 작업 유형 분류
   * @param {string} action - 작업 액션
   * @returns {string} 분류된 작업 유형
   */
  classifyTask(action) {
    const actionLower = action.toLowerCase();
    
    // 분석 작업
    if (actionLower.includes('analyze') || 
        actionLower.includes('review') || 
        actionLower.includes('read') ||
        actionLower.includes('status') ||
        actionLower.includes('diagnose')) {
      return 'analysis';
    }

    // 구현 작업
    if (actionLower.includes('implement') || 
        actionLower.includes('create') || 
        actionLower.includes('build') ||
        actionLower.includes('write') ||
        actionLower.includes('develop')) {
      return 'implementation';
    }

    // 민감 작업
    if (actionLower.includes('delete') || 
        actionLower.includes('deploy') || 
        actionLower.includes('publish') ||
        actionLower.includes('secret') ||
        actionLower.includes('credential')) {
      return 'sensitive';
    }

    // 창의적 작업
    if (actionLower.includes('design') || 
        actionLower.includes('generate') || 
        actionLower.includes('create') ||
        actionLower.includes('compose')) {
      return 'creative';
    }

    // 기본값
    return 'analysis';
  }

  /**
   * 라우팅 결정 로깅
   * @param {Object} task - 원본 작업
   * @param {Object} decision - 라우팅 결정
   */
  logDecision(task, decision) {
    const logEntry = {
      timestamp: new Date().toISOString(),
      task: {
        action: task.action,
        risk: task.risk
      },
      decision: decision
    };

    console.log('Model Routing Decision:', JSON.stringify(logEntry, null, 2));
  }

  /**
   * 설정 저장
   */
  saveConfig() {
    const configDir = path.dirname(this.configPath);
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    
    fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2));
    console.log(`Config saved to ${this.configPath}`);
  }
}

// CLI 인터페이스
if (require.main === module) {
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    console.log(`
Connect AI Model Router

Usage:
  node src/model-router.js <action> [risk] [context]

Examples:
  node src/model-router.js analyze low
  node src/model-router.js implement medium
  node src/model-router.js deploy high
    `);
    process.exit(0);
  }

  const router = new ModelRouter();
  const task = {
    action: args[0],
    risk: args[1] || 'low',
    context: args[2] ? JSON.parse(args[2]) : {}
  };

  const decision = router.selectModel(task);
  router.logDecision(task, decision);
  
  console.log(`\nRecommended: ${decision.provider}:${decision.model}`);
  console.log(`Confidence: ${decision.confidence}`);
  console.log(`Reasoning: ${decision.reasoning}`);
}

module.exports = ModelRouter;
