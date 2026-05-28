#!/usr/bin/env node

/**
 * Connect AI Codex Integration
 * 
 * Codex 위임 기능 구현 - MCP를 통한 Codex 연동
 */

const { spawn } = require('child_process');

class CodexIntegration {
  constructor() {
    this.codexAvailable = this.checkCodexAvailability();
  }

  /**
   * Codex 사용 가능 여부 확인
   */
  checkCodexAvailability() {
    try {
      // Hermes delegate_task 기능 확인
      const result = spawn('hermes', ['--help'], { stdio: 'pipe' });
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Codex에 작업 위임
   * @param {string} goal - 위임할 작업 목표
   * @param {string} context - 작업 컨텍스트
   * @param {Array} toolsets - 필요한 툴셋
   */
  async delegateToCodex(goal, context = '', toolsets = ['terminal', 'file']) {
    if (!this.codexAvailable) {
      throw new Error('Codex integration not available');
    }

    return new Promise((resolve, reject) => {
      const hermes = spawn('hermes', ['delegate', '--goal', goal, '--toolsets', toolsets.join(',')], {
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
            provider: 'codex',
            response: stdout.trim(),
            execution_time: Date.now()
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
   * MCP를 통한 Codex 연동 (대안)
   */
  async codexViaMCP(goal, context = '') {
    // TODO: MCP를 통한 Codex 직접 연동 구현
    return {
      provider: 'codex-mcp',
      response: 'MCP Codex integration not yet implemented',
      execution_time: Date.now()
    };
  }

  /**
   * Codex 작업 상태 확인
   */
  async checkCodexStatus() {
    try {
      const result = await this.delegateToCodex('status check', 'Check Codex availability', ['status']);
      return { available: true, status: result };
    } catch (error) {
      return { available: false, error: error.message };
    }
  }
}

// CLI 인터페이스
if (require.main === module) {
  const args = process.argv.slice(2);
  const command = args[0];
  
  const codex = new CodexIntegration();

  switch (command) {
    case 'delegate':
      if (args.length < 2) {
        console.error('Usage: node codex-integration.js delegate <goal> [context]');
        process.exit(1);
      }
      
      const goal = args[1];
      const context = args[2] || '';
      
      codex.delegateToCodex(goal, context)
        .then(result => {
          console.log('Codex delegation result:', JSON.stringify(result, null, 2));
        })
        .catch(error => {
          console.error('Codex delegation failed:', error.message);
          process.exit(1);
        });
      break;

    case 'status':
      codex.checkCodexStatus()
        .then(result => {
          console.log('Codex status:', JSON.stringify(result, null, 2));
        })
        .catch(error => {
          console.error('Status check failed:', error.message);
          process.exit(1);
        });
      break;

    default:
      console.log(`
Connect AI Codex Integration

Usage:
  node codex-integration.js delegate <goal> [context]  - Delegate task to Codex
  node codex-integration.js status                     - Check Codex availability

Examples:
  node codex-integration.js delegate "Implement new feature" "For YouTube processor"
  node codex-integration.js status
      `);
      break;
  }
}

module.exports = CodexIntegration;
