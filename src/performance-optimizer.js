#!/usr/bin/env node

/**
 * Connect AI Performance Optimizer
 * 
 * 성능 최적화 - 타임아웃 조정, 병렬 처리, 모니터링
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

class PerformanceOptimizer {
  constructor() {
    this.defaultTimeout = 300; // 5분
    this.maxConcurrent = 3;
    this.metrics = {
      totalTasks: 0,
      completedTasks: 0,
      failedTasks: 0,
      averageTime: 0
    };
  }

  /**
   * 타임아웃 설정 조정
   */
  adjustTimeout(taskType, risk = 'low') {
    const timeouts = {
      'analysis': { low: 60, medium: 120, high: 300 },
      'implementation': { low: 120, medium: 300, high: 600 },
      'creative': { low: 180, medium: 300, high: 600 },
      'sensitive': { low: 300, medium: 600, high: 900 }
    };

    return timeouts[taskType]?.[risk] || this.defaultTimeout;
  }

  /**
   * 병렬 작업 실행
   */
  async executeParallel(tasks, maxConcurrent = null) {
    const concurrency = maxConcurrent || this.maxConcurrent;
    const results = [];
    const executing = [];

    for (const task of tasks) {
      const promise = this.executeTask(task);
      results.push(promise);

      if (results.length >= concurrency) {
        executing.push(promise);
      }

      if (executing.length >= concurrency) {
        await Promise.race(executing);
        // 완료된 작업 제거
        const stillExecuting = executing.filter(p => p.pending);
        executing.length = 0;
        executing.push(...stillExecuting);
      }
    }

    return Promise.allSettled(results);
  }

  /**
   * 개별 작업 실행 (타임아웃 적용)
   */
  async executeTask(task) {
    const timeout = this.adjustTimeout(task.type, task.risk);
    const startTime = Date.now();

    this.metrics.totalTasks++;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Task timeout after ${timeout} seconds`));
      }, timeout * 1000);

      // 실제 작업 실행 로직 (여기서는 시뮬레이션)
      this.simulateTaskExecution(task)
        .then(result => {
          clearTimeout(timer);
          const executionTime = Date.now() - startTime;
          this.updateMetrics(true, executionTime);
          resolve({ ...result, executionTime });
        })
        .catch(error => {
          clearTimeout(timer);
          this.updateMetrics(false, Date.now() - startTime);
          reject(error);
        });
    });
  }

  /**
   * 작업 실행 시뮬레이션
   */
  async simulateTaskExecution(task) {
    // 실제로는 여기서 Hermes나 다른 도구를 호출
    const delay = Math.random() * 2000 + 1000; // 1-3초
    await new Promise(resolve => setTimeout(resolve, delay));
    
    return {
      taskId: task.id,
      type: task.type,
      status: 'completed',
      result: `Task ${task.id} completed successfully`
    };
  }

  /**
   * 메트릭 업데이트
   */
  updateMetrics(success, executionTime) {
    if (success) {
      this.metrics.completedTasks++;
    } else {
      this.metrics.failedTasks++;
    }

    // 평균 시간 업데이트
    const totalCompleted = this.metrics.completedTasks;
    const currentAvg = this.metrics.averageTime;
    this.metrics.averageTime = ((currentAvg * (totalCompleted - 1)) + executionTime) / totalCompleted;
  }

  /**
   * 성능 모니터링
   */
  getPerformanceReport() {
    const successRate = this.metrics.totalTasks > 0 
      ? (this.metrics.completedTasks / this.metrics.totalTasks) * 100 
      : 0;

    return {
      ...this.metrics,
      successRate: successRate.toFixed(2) + '%',
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Hermes 설정 최적화 제안
   */
  async optimizeHermesConfig() {
    const configPath = path.join(process.env.HOME || '', '.hermes', 'config.yaml');
    
    if (!fs.existsSync(configPath)) {
      return { error: 'Hermes config not found' };
    }

    const suggestions = [
      {
        setting: 'terminal.timeout',
        current: 180,
        suggested: 300,
        reason: 'Increase timeout for complex tasks'
      },
      {
        setting: 'agent.gateway_timeout',
        current: 1800,
        suggested: 3600,
        reason: 'Allow longer gateway operations'
      },
      {
        setting: 'delegation.child_timeout_seconds',
        current: 600,
        suggested: 900,
        reason: 'Increase delegation timeout for Codex tasks'
      }
    ];

    return { suggestions, configPath };
  }

  /**
   * 시스템 리소스 모니터링
   */
  async monitorSystemResources() {
    return new Promise((resolve) => {
      const memInfo = spawn('free', ['-m']);
      let output = '';

      memInfo.stdout.on('data', (data) => {
        output += data.toString();
      });

      memInfo.on('close', () => {
        const lines = output.split('\n');
        const memLine = lines.find(line => line.startsWith('Mem:'));
        
        if (memLine) {
          const parts = memLine.split(/\s+/);
          const total = parseInt(parts[1]);
          const used = parseInt(parts[2]);
          const free = parseInt(parts[3]);
          const usagePercent = ((used / total) * 100).toFixed(2);

          resolve({
            memory: {
              total: total + 'MB',
              used: used + 'MB',
              free: free + 'MB',
              usage: usagePercent + '%'
            },
            timestamp: new Date().toISOString()
          });
        } else {
          resolve({ error: 'Could not parse memory info' });
        }
      });
    });
  }
}

// CLI 인터페이스
if (require.main === module) {
  const args = process.argv.slice(2);
  const command = args[0];
  
  const optimizer = new PerformanceOptimizer();

  switch (command) {
    case 'optimize':
      optimizer.optimizeHermesConfig()
        .then(result => {
          console.log('Optimization suggestions:', JSON.stringify(result, null, 2));
        })
        .catch(error => {
          console.error('Optimization failed:', error.message);
        });
      break;

    case 'monitor':
      optimizer.monitorSystemResources()
        .then(result => {
          console.log('System resources:', JSON.stringify(result, null, 2));
        })
        .catch(error => {
          console.error('Monitoring failed:', error.message);
        });
      break;

    case 'report':
      console.log('Performance report:', JSON.stringify(optimizer.getPerformanceReport(), null, 2));
      break;

    case 'test-parallel':
      const testTasks = [
        { id: '1', type: 'analysis', risk: 'low' },
        { id: '2', type: 'implementation', risk: 'medium' },
        { id: '3', type: 'creative', risk: 'low' },
        { id: '4', type: 'analysis', risk: 'high' },
        { id: '5', type: 'implementation', risk: 'low' }
      ];

      optimizer.executeParallel(testTasks)
        .then(results => {
          console.log('Parallel execution results:');
          results.forEach((result, index) => {
            console.log(`Task ${index + 1}:`, result.status === 'fulfilled' ? '✅' : '❌');
          });
          console.log('\nPerformance report:', JSON.stringify(optimizer.getPerformanceReport(), null, 2));
        })
        .catch(error => {
          console.error('Parallel execution failed:', error.message);
        });
      break;

    default:
      console.log(`
Connect AI Performance Optimizer

Usage:
  node performance-optimizer.js optimize    - Show optimization suggestions
  node performance-optimizer.js monitor     - Monitor system resources
  node performance-optimizer.js report      - Show performance report
  node performance-optimizer.js test-parallel - Test parallel execution

Examples:
  node performance-optimizer.js optimize
  node performance-optimizer.js monitor
  node performance-optimizer.js test-parallel
      `);
      break;
  }
}

module.exports = PerformanceOptimizer;
