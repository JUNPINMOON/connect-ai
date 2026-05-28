#!/usr/bin/env node

/**
 * Strategy Review Script for US Execution Project
 * 
 * This script analyzes investment strategy assumptions and validates
 * consistency across configuration files, market assumptions, and backtest results.
 * 
 * Usage: node scripts/strategy-review.js
 */

const fs = require('fs');
const path = require('path');

// Configuration paths
const CONFIG_DIR = path.join(__dirname, '..', 'config');
const DATA_DIR = path.join(__dirname, '..', 'data');
const BACKTEST_DIR = path.join(__dirname, '..', 'backtest_results');

// File paths
const STRATEGY_CONFIG_PATH = path.join(CONFIG_DIR, 'strategy_config.json');
const INVESTMENT_RULES_PATH = path.join(CONFIG_DIR, 'investment_rules.yaml');
const MARKET_ASSUMPTIONS_PATH = path.join(DATA_DIR, 'market_assumptions.csv');
const RISK_PARAMETERS_PATH = path.join(DATA_DIR, 'risk_parameters.json');
const PERFORMANCE_METRICS_PATH = path.join(BACKTEST_DIR, 'performance_metrics.json');

class StrategyReviewer {
  constructor() {
    this.issues = [];
    this.warnings = [];
    this.summary = {
      strategy_name: '',
      total_checks: 0,
      passed_checks: 0,
      failed_checks: 0,
      consistency_score: 0,
      risk_assessment: 'UNKNOWN'
    };
  }

  async runReview() {
    console.log('🔍 Starting Strategy Review...\n');

    try {
      // Load all configuration files
      const strategyConfig = this.loadJsonFile(STRATEGY_CONFIG_PATH);
      const investmentRules = this.loadYamlFile(INVESTMENT_RULES_PATH);
      const marketAssumptions = this.loadCsvFile(MARKET_ASSUMPTIONS_PATH);
      const riskParameters = this.loadJsonFile(RISK_PARAMETERS_PATH);
      const performanceMetrics = this.loadJsonFile(PERFORMANCE_METRICS_PATH);

      // Set strategy name
      this.summary.strategy_name = strategyConfig.strategy.name;

      // Perform consistency checks
      this.checkStrategyConsistency(strategyConfig, investmentRules);
      this.checkRiskParameters(strategyConfig, riskParameters);
      this.checkMarketAssumptions(strategyConfig, marketAssumptions);
      this.checkPerformanceValidation(strategyConfig, performanceMetrics);
      this.checkEntryExitLogic(strategyConfig, investmentRules);
      this.checkPositionSizing(strategyConfig, investmentRules, riskParameters);

      // Calculate scores
      this.calculateScores();

      // Generate report
      const report = this.generateReport();
      
      // Save report
      this.saveReport(report);

      console.log('✅ Strategy Review Complete');
      console.log(`📊 Consistency Score: ${this.summary.consistency_score.toFixed(1)}%`);
      console.log(`⚠️  Issues Found: ${this.issues.length}`);
      console.log(`🔔 Warnings: ${this.warnings.length}`);

      return report;

    } catch (error) {
      console.error('❌ Error during strategy review:', error.message);
      process.exit(1);
    }
  }

  loadJsonFile(filePath) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`Required file not found: ${filePath}`);
    }
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  }

  loadYamlFile(filePath) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`Required file not found: ${filePath}`);
    }
    // Simple YAML parser for basic structure
    const content = fs.readFileSync(filePath, 'utf8');
    return this.parseSimpleYaml(content);
  }

  loadCsvFile(filePath) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`Required file not found: ${filePath}`);
    }
    const content = fs.readFileSync(filePath, 'utf8');
    return this.parseCsv(content);
  }

  parseSimpleYaml(yamlContent) {
    const result = {};
    const lines = yamlContent.split('\n');
    let currentSection = null;
    let currentArray = null;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      if (trimmed.endsWith(':') && !trimmed.includes('-')) {
        currentSection = trimmed.slice(0, -1);
        result[currentSection] = {};
        currentArray = null;
      } else if (trimmed.includes(':') && !trimmed.startsWith('-')) {
        const [key, value] = trimmed.split(':').map(s => s.trim());
        if (currentSection) {
          result[currentSection][key] = this.parseValue(value);
        }
      } else if (trimmed.startsWith('-')) {
        const item = trimmed.slice(1).trim();
        if (item.includes(':')) {
          const [key, value] = item.split(':').map(s => s.trim());
          if (currentArray === null) {
            currentArray = [];
            if (currentSection) {
              result[currentSection] = currentArray;
            }
          }
          currentArray.push({
            [key]: this.parseValue(value)
          });
        }
      }
    }

    return result;
  }

  parseValue(value) {
    if (value === 'true') return true;
    if (value === 'false') return false;
    if (!isNaN(value) && value !== '') return parseFloat(value);
    if (value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1);
    return value;
  }

  parseCsv(content) {
    const lines = content.trim().split('\n');
    const headers = lines[0].split(',').map(h => h.trim());
    const data = [];

    for (let i = 1; i < lines.length; i++) {
      const values = lines[i].split(',').map(v => v.trim());
      const row = {};
      for (let j = 0; j < headers.length; j++) {
        row[headers[j]] = isNaN(values[j]) ? values[j] : parseFloat(values[j]);
      }
      data.push(row);
    }

    return data;
  }

  checkStrategyConsistency(strategyConfig, investmentRules) {
    this.summary.total_checks++;

    // Check strategy name consistency
    const strategyName = strategyConfig.strategy.name;
    const rulesName = investmentRules.strategy?.name;

    if (strategyName !== rulesName) {
      this.issues.push({
        type: 'INCONSISTENCY',
        severity: 'HIGH',
        description: `Strategy name mismatch: config='${strategyName}' vs rules='${rulesName}'`,
        recommendation: 'Align strategy names across configuration files'
      });
    } else {
      this.summary.passed_checks++;
    }

    // Check timeframe consistency
    this.summary.total_checks++;
    const configTimeframe = strategyConfig.strategy.timeframe;
    const rulesTimeframe = investmentRules.strategy?.version; // Using version as proxy

    if (!configTimeframe) {
      this.warnings.push({
        type: 'MISSING_CONFIG',
        description: 'Timeframe not specified in strategy config',
        recommendation: 'Add timeframe to strategy configuration'
      });
    } else {
      this.summary.passed_checks++;
    }
  }

  checkRiskParameters(strategyConfig, riskParameters) {
    this.summary.total_checks++;

    // Check risk limits consistency
    const configMaxDrawdown = strategyConfig.risk_management.portfolio_level.max_drawdown;
    const riskMaxDrawdown = riskParameters.risk_parameters.drawdown_risk.max_portfolio_drawdown;

    if (Math.abs(configMaxDrawdown - riskMaxDrawdown) > 0.05) {
      this.issues.push({
        type: 'RISK_MISMATCH',
        severity: 'MEDIUM',
        description: `Max drawdown mismatch: config=${configMaxDrawdown} vs risk=${riskMaxDrawdown}`,
        recommendation: 'Align maximum drawdown limits across files'
      });
    } else {
      this.summary.passed_checks++;
    }

    // Check position size limits
    this.summary.total_checks++;
    const configPositionSize = strategyConfig.trading_parameters.position_size_percent / 100;
    const riskPositionSize = riskParameters.risk_parameters.market_risk.max_position_size;

    if (Math.abs(configPositionSize - riskPositionSize) > 0.02) {
      this.warnings.push({
        type: 'RISK_WARNING',
        description: `Position size limits differ: config=${configPositionSize} vs risk=${riskPositionSize}`,
        recommendation: 'Review and align position sizing limits'
      });
    } else {
      this.summary.passed_checks++;
    }
  }

  checkMarketAssumptions(strategyConfig, marketAssumptions) {
    this.summary.total_checks++;

    // Check if market assumptions cover strategy sectors
    const configSectors = strategyConfig.universe.included_sectors;
    const assumptionSectors = [...new Set(marketAssumptions.map(row => row.sector))];

    const missingSectors = configSectors.filter(sector => !assumptionSectors.includes(sector));
    
    if (missingSectors.length > 0) {
      this.issues.push({
        type: 'DATA_GAP',
        severity: 'MEDIUM',
        description: `Missing market assumptions for sectors: ${missingSectors.join(', ')}`,
        recommendation: 'Add market assumptions data for all strategy sectors'
      });
    } else {
      this.summary.passed_checks++;
    }

    // Check data recency
    this.summary.total_checks++;
    const latestDate = new Date(Math.max(...marketAssumptions.map(row => new Date(row.date))));
    const daysOld = (Date.now() - latestDate) / (1000 * 60 * 60 * 24);

    if (daysOld > 90) {
      this.warnings.push({
        type: 'DATA_STALE',
        description: `Market assumptions data is ${Math.floor(daysOld)} days old`,
        recommendation: 'Update market assumptions with recent data'
      });
    } else {
      this.summary.passed_checks++;
    }
  }

  checkPerformanceValidation(strategyConfig, performanceMetrics) {
    this.summary.total_checks++;

    // Check if performance meets targets
    const targetReturn = 0.12; // 12% annual target
    const actualReturn = performanceMetrics.backtest_summary.annualized_return / 100;

    if (actualReturn < targetReturn) {
      this.warnings.push({
        type: 'PERFORMANCE_WARNING',
        description: `Annual return (${(actualReturn * 100).toFixed(1)}%) below target (${(targetReturn * 100)}%)`,
        recommendation: 'Review strategy parameters or adjust return expectations'
      });
    } else {
      this.summary.passed_checks++;
    }

    // Check Sharpe ratio
    this.summary.total_checks++;
    const targetSharpe = 1.0;
    const actualSharpe = performanceMetrics.backtest_summary.sharpe_ratio;

    if (actualSharpe < targetSharpe) {
      this.warnings.push({
        type: 'RISK_ADJUSTED_RETURN',
        description: `Sharpe ratio (${actualSharpe.toFixed(2)}) below target (${targetSharpe})`,
        recommendation: 'Improve risk-adjusted returns or adjust expectations'
      });
    } else {
      this.summary.passed_checks++;
    }

    // Check drawdown against limits
    this.summary.total_checks++;
    const maxDrawdown = performanceMetrics.backtest_summary.max_drawdown / 100;
    const drawdownLimit = strategyConfig.risk_management.portfolio_level.max_drawdown;

    if (maxDrawdown > drawdownLimit) {
      this.issues.push({
        type: 'RISK_BREACH',
        severity: 'HIGH',
        description: `Max drawdown (${(maxDrawdown * 100).toFixed(1)}%) exceeds limit (${(drawdownLimit * 100).toFixed(1)}%)`,
        recommendation: 'Review risk management parameters or strategy logic'
      });
    } else {
      this.summary.passed_checks++;
    }
  }

  checkEntryExitLogic(strategyConfig, investmentRules) {
    this.summary.total_checks++;

    // Check entry condition consistency
    const configEntry = strategyConfig.entry_conditions.momentum_signal;
    const rulesEntry = investmentRules.entry?.technical;

    if (!configEntry || !rulesEntry) {
      this.issues.push({
        type: 'MISSING_LOGIC',
        severity: 'HIGH',
        description: 'Entry conditions not properly defined',
        recommendation: 'Define clear entry conditions in both config files'
      });
    } else {
      this.summary.passed_checks++;
    }

    // Check exit condition consistency
    this.summary.total_checks++;
    const configExit = strategyConfig.exit_conditions;
    const rulesExit = investmentRules.exit;

    if (!configExit || !rulesExit) {
      this.issues.push({
        type: 'MISSING_LOGIC',
        severity: 'HIGH',
        description: 'Exit conditions not properly defined',
        recommendation: 'Define clear exit conditions in both config files'
      });
    } else {
      this.summary.passed_checks++;
    }
  }

  checkPositionSizing(strategyConfig, investmentRules, riskParameters) {
    this.summary.total_checks++;

    // Check position sizing consistency
    const configMaxPositions = strategyConfig.trading_parameters.max_positions;
    const rulesMaxPositions = investmentRules.position_management?.max_positions;

    if (configMaxPositions !== rulesMaxPositions) {
      this.issues.push({
        type: 'POSITION_MISMATCH',
        severity: 'MEDIUM',
        description: `Max positions mismatch: config=${configMaxPositions} vs rules=${rulesMaxPositions}`,
        recommendation: 'Align maximum position limits'
      });
    } else {
      this.summary.passed_checks++;
    }

    // Check sector exposure limits
    this.summary.total_checks++;
    const configSectorLimit = strategyConfig.entry_conditions.risk_filters.sector_exposure_limit;
    const rulesSectorLimit = investmentRules.position_management?.max_sector_exposure;

    if (Math.abs(configSectorLimit - rulesSectorLimit) > 5) {
      this.warnings.push({
        type: 'SECTOR_EXPOSURE',
        description: `Sector exposure limits differ: config=${configSectorLimit}% vs rules=${rulesSectorLimit}%`,
        recommendation: 'Align sector exposure limits'
      });
    } else {
      this.summary.passed_checks++;
    }
  }

  calculateScores() {
    this.summary.failed_checks = this.summary.total_checks - this.summary.passed_checks;
    this.summary.consistency_score = (this.summary.passed_checks / this.summary.total_checks) * 100;

    // Determine risk assessment
    const criticalIssues = this.issues.filter(issue => issue.severity === 'HIGH').length;
    if (criticalIssues > 0) {
      this.summary.risk_assessment = 'HIGH_RISK';
    } else if (this.issues.length > 2) {
      this.summary.risk_assessment = 'MEDIUM_RISK';
    } else {
      this.summary.risk_assessment = 'LOW_RISK';
    }
  }

  generateReport() {
    const report = {
      timestamp: new Date().toISOString(),
      summary: this.summary,
      issues: this.issues,
      warnings: this.warnings,
      recommendations: this.generateRecommendations()
    };

    return report;
  }

  generateRecommendations() {
    const recommendations = [];

    // High priority recommendations
    const highPriorityIssues = this.issues.filter(issue => issue.severity === 'HIGH');
    if (highPriorityIssues.length > 0) {
      recommendations.push({
        priority: 'HIGH',
        action: 'Address critical configuration inconsistencies',
        details: highPriorityIssues.map(issue => issue.description).join('; ')
      });
    }

    // Performance recommendations
    const performanceWarnings = this.warnings.filter(warning => 
      warning.type === 'PERFORMANCE_WARNING' || warning.type === 'RISK_ADJUSTED_RETURN'
    );
    if (performanceWarnings.length > 0) {
      recommendations.push({
        priority: 'MEDIUM',
        action: 'Review strategy performance parameters',
        details: 'Consider optimizing entry/exit conditions or risk management'
      });
    }

    // Data quality recommendations
    const dataWarnings = this.warnings.filter(warning => 
      warning.type === 'DATA_STALE' || warning.type === 'DATA_GAP'
    );
    if (dataWarnings.length > 0) {
      recommendations.push({
        priority: 'MEDIUM',
        action: 'Update market data and assumptions',
        details: 'Ensure market assumptions are current and complete'
      });
    }

    // Risk management recommendations
    if (this.summary.risk_assessment !== 'LOW_RISK') {
      recommendations.push({
        priority: 'HIGH',
        action: 'Strengthen risk management framework',
        details: 'Review and enhance risk controls and monitoring'
      });
    }

    return recommendations;
  }

  saveReport(report) {
    const reportPath = path.join(__dirname, '..', 'backtest_results', 'strategy_review_report.json');
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`\n📄 Report saved to: ${reportPath}`);
  }

  printSummary() {
    console.log('\n' + '='.repeat(60));
    console.log('STRATEGY REVIEW SUMMARY');
    console.log('='.repeat(60));
    console.log(`Strategy: ${this.summary.strategy_name}`);
    console.log(`Consistency Score: ${this.summary.consistency_score.toFixed(1)}%`);
    console.log(`Risk Assessment: ${this.summary.risk_assessment}`);
    console.log(`Checks Passed: ${this.summary.passed_checks}/${this.summary.total_checks}`);
    
    if (this.issues.length > 0) {
      console.log('\n🚨 ISSUES:');
      this.issues.forEach((issue, index) => {
        console.log(`${index + 1}. [${issue.severity}] ${issue.description}`);
      });
    }

    if (this.warnings.length > 0) {
      console.log('\n⚠️  WARNINGS:');
      this.warnings.forEach((warning, index) => {
        console.log(`${index + 1}. ${warning.description}`);
      });
    }

    console.log('\n' + '='.repeat(60));
  }
}

// Main execution
async function main() {
  const reviewer = new StrategyReviewer();
  const report = await reviewer.runReview();
  reviewer.printSummary();
  return report;
}

// Run if called directly
if (require.main === module) {
  main().catch(error => {
    console.error('Strategy review failed:', error);
    process.exit(1);
  });
}

module.exports = { StrategyReviewer };