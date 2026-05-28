#!/usr/bin/env node

/**
 * Backtest Summary Script for Connect AI US Execution Strategy
 * 
 * This script analyzes backtest results and generates a comprehensive performance summary
 * for the investment committee. It extracts key performance indicators, risk metrics,
 * and provides recommendations based on the results.
 * 
 * Usage: node scripts/backtest-summary.js
 */

const fs = require('fs');
const path = require('path');

class BacktestSummary {
  constructor() {
    this.baseDir = path.dirname(__dirname);
    this.resultsDir = path.join(this.baseDir, 'backtest_results');
    this.performanceMetricsFile = path.join(this.resultsDir, 'performance_metrics.json');
    this.strategyReviewFile = path.join(this.resultsDir, 'strategy_review_report.json');
  }

  /**
   * Load performance metrics from JSON file
   */
  loadPerformanceMetrics() {
    try {
      if (!fs.existsSync(this.performanceMetricsFile)) {
        throw new Error(`Performance metrics file not found: ${this.performanceMetricsFile}`);
      }
      
      const data = fs.readFileSync(this.performanceMetricsFile, 'utf8');
      return JSON.parse(data);
    } catch (error) {
      console.error('Error loading performance metrics:', error.message);
      process.exit(1);
    }
  }

  /**
   * Load strategy review report from JSON file
   */
  loadStrategyReview() {
    try {
      if (!fs.existsSync(this.strategyReviewFile)) {
        console.warn('Strategy review file not found, skipping strategy analysis');
        return null;
      }
      
      const data = fs.readFileSync(this.strategyReviewFile, 'utf8');
      return JSON.parse(data);
    } catch (error) {
      console.error('Error loading strategy review:', error.message);
      return null;
    }
  }

  /**
   * Calculate additional performance metrics
   */
  calculateAdditionalMetrics(performanceData) {
    const monthlyReturns = performanceData.monthly_returns;
    const returns = Object.values(monthlyReturns);
    
    // Calculate volatility (standard deviation of monthly returns)
    const meanReturn = returns.reduce((sum, r) => sum + r, 0) / returns.length;
    const variance = returns.reduce((sum, r) => sum + Math.pow(r - meanReturn, 2), 0) / returns.length;
    const volatility = Math.sqrt(variance);
    
    // Calculate annualized volatility
    const annualizedVolatility = volatility * Math.sqrt(12);
    
    // Calculate best and worst months
    const bestMonth = Math.max(...returns);
    const worstMonth = Math.min(...returns);
    
    // Calculate positive and negative months
    const positiveMonths = returns.filter(r => r > 0).length;
    const negativeMonths = returns.filter(r => r < 0).length;
    
    // Calculate rolling 12-month returns (simplified)
    const rollingReturns = [];
    for (let i = 11; i < returns.length; i++) {
      const rollingSum = returns.slice(i - 11, i + 1).reduce((sum, r) => sum + r, 0);
      rollingReturns.push(rollingSum);
    }
    
    return {
      volatility: volatility.toFixed(2),
      annualizedVolatility: annualizedVolatility.toFixed(2),
      bestMonth: bestMonth.toFixed(2),
      worstMonth: worstMonth.toFixed(2),
      positiveMonths,
      negativeMonths,
      positiveMonthRatio: (positiveMonths / returns.length).toFixed(3),
      averageRolling12Month: rollingReturns.length > 0 ? 
        (rollingReturns.reduce((sum, r) => sum + r, 0) / rollingReturns.length).toFixed(2) : null
    };
  }

  /**
   * Generate risk assessment
   */
  generateRiskAssessment(performanceData, additionalMetrics) {
    const riskMetrics = performanceData.risk_metrics;
    const backtestSummary = performanceData.backtest_summary;
    
    let riskLevel = 'MEDIUM';
    const riskFactors = [];
    const recommendations = [];

    // Assess maximum drawdown
    if (backtestSummary.max_drawdown > 20) {
      riskLevel = 'HIGH';
      riskFactors.push(`High maximum drawdown: ${backtestSummary.max_drawdown}%`);
      recommendations.push('Consider implementing tighter stop-loss mechanisms');
    } else if (backtestSummary.max_drawdown < 10) {
      riskFactors.push('Low maximum drawdown indicates good risk control');
    }

    // Assess Sharpe ratio
    if (backtestSummary.sharpe_ratio < 1.0) {
      riskFactors.push(`Low risk-adjusted returns (Sharpe: ${backtestSummary.sharpe_ratio})`);
      recommendations.push('Improve risk-adjusted returns through better position sizing');
    } else if (backtestSummary.sharpe_ratio > 1.5) {
      riskFactors.push(`Excellent risk-adjusted returns (Sharpe: ${backtestSummary.sharpe_ratio})`);
    }

    // Assess volatility
    if (parseFloat(additionalMetrics.annualizedVolatility) > 15) {
      riskFactors.push(`High annualized volatility: ${additionalMetrics.annualizedVolatility}%`);
      recommendations.push('Consider reducing position sizes to lower volatility');
    }

    // Assess VaR
    if (riskMetrics.var_95 > 0.10) {
      riskFactors.push(`High 95% VaR: ${(riskMetrics.var_95 * 100).toFixed(1)}%`);
      recommendations.push('Implement additional downside protection measures');
    }

    // Assess win rate
    if (backtestSummary.win_rate < 0.5) {
      riskFactors.push(`Low win rate: ${(backtestSummary.win_rate * 100).toFixed(1)}%`);
      recommendations.push('Review entry/exit criteria to improve win rate');
    }

    return {
      riskLevel,
      riskFactors,
      recommendations
    };
  }

  /**
   * Generate sector analysis
   */
  generateSectorAnalysis(sectorPerformance) {
    const sectors = Object.entries(sectorPerformance);
    
    // Sort by return
    const sortedByReturn = sectors.sort(([,a], [,b]) => b.return - a.return);
    
    // Calculate concentration risk
    const top3Weight = sortedByReturn.slice(0, 3).reduce((sum, [,data]) => sum + data.weight, 0);
    const concentrationRisk = top3Weight > 0.6 ? 'HIGH' : top3Weight > 0.4 ? 'MEDIUM' : 'LOW';
    
    return {
      topPerformingSector: sortedByReturn[0][0],
      worstPerformingSector: sortedByReturn[sortedByReturn.length - 1][0],
      concentrationRisk,
      sectorBreakdown: sectors.map(([name, data]) => ({
        sector: name,
        return: data.return.toFixed(2),
        sharpe: data.sharpe.toFixed(2),
        maxDrawdown: data.max_drawdown.toFixed(2),
        weight: (data.weight * 100).toFixed(1)
      }))
    };
  }

  /**
   * Generate trading analysis
   */
  generateTradingAnalysis(tradeStats) {
    const avgTradeDuration = tradeStats.avg_trade_duration;
    const totalTrades = tradeStats.total_trades;
    
    // Calculate trade frequency
    const tradeFrequency = totalTrades / 12; // Assuming 1 year backtest
    
    // Assess trade quality
    let tradeQuality = 'GOOD';
    const tradeInsights = [];
    
    if (tradeStats.avg_win < Math.abs(tradeStats.avg_loss) * 1.5) {
      tradeQuality = 'FAIR';
      tradeInsights.push('Win/Loss ratio could be improved');
    }
    
    if (avgTradeDuration < 10) {
      tradeInsights.push('Very short holding periods may indicate overtrading');
    } else if (avgTradeDuration > 30) {
      tradeInsights.push('Long holding periods may suggest missed opportunities');
    }
    
    if (tradeFrequency > 50) {
      tradeInsights.push('High trading frequency may increase transaction costs');
    }

    return {
      tradeQuality,
      tradeFrequency: tradeFrequency.toFixed(1),
      avgWinLossRatio: (tradeStats.avg_win / Math.abs(tradeStats.avg_loss)).toFixed(2),
      tradeInsights
    };
  }

  /**
   * Generate overall recommendations
   */
  generateRecommendations(performanceData, riskAssessment, sectorAnalysis, tradingAnalysis) {
    const recommendations = [];
    
    // Performance-based recommendations
    if (performanceData.backtest_summary.annualized_return < 15) {
      recommendations.push({
        priority: 'HIGH',
        category: 'PERFORMANCE',
        action: 'Improve annualized returns',
        detail: `Current annualized return of ${performanceData.backtest_summary.annualized_return}% is below target of 15%`
      });
    }

    // Risk-based recommendations
    if (riskAssessment.riskLevel === 'HIGH') {
      recommendations.push({
        priority: 'HIGH',
        category: 'RISK',
        action: 'Implement enhanced risk controls',
        detail: 'High risk level detected due to drawdown and volatility metrics'
      });
    }

    // Sector-based recommendations
    if (sectorAnalysis.concentrationRisk === 'HIGH') {
      recommendations.push({
        priority: 'MEDIUM',
        category: 'DIVERSIFICATION',
        action: 'Reduce sector concentration',
        detail: 'Consider diversifying across more sectors to reduce concentration risk'
      });
    }

    // Trading-based recommendations
    if (tradingAnalysis.tradeQuality === 'FAIR') {
      recommendations.push({
        priority: 'MEDIUM',
        category: 'TRADING',
        action: 'Optimize trade parameters',
        detail: 'Improve win/loss ratio and trade timing for better risk-adjusted returns'
      });
    }

    // Add risk assessment recommendations
    riskAssessment.recommendations.forEach(rec => {
      recommendations.push({
        priority: 'MEDIUM',
        category: 'RISK',
        action: rec,
        detail: 'Based on risk metrics analysis'
      });
    });

    return recommendations;
  }

  /**
   * Generate comprehensive summary report
   */
  generateSummary() {
    console.log('🔍 Loading backtest data...');
    
    const performanceData = this.loadPerformanceMetrics();
    const strategyReview = this.loadStrategyReview();
    
    console.log('📊 Analyzing performance metrics...');
    const additionalMetrics = this.calculateAdditionalMetrics(performanceData);
    
    console.log('⚠️  Assessing risk factors...');
    const riskAssessment = this.generateRiskAssessment(performanceData, additionalMetrics);
    
    console.log('🏢 Analyzing sector performance...');
    const sectorAnalysis = this.generateSectorAnalysis(performanceData.sector_performance);
    
    console.log('💼 Analyzing trading patterns...');
    const tradingAnalysis = this.generateTradingAnalysis(performanceData.trade_statistics);
    
    console.log('💡 Generating recommendations...');
    const recommendations = this.generateRecommendations(
      performanceData, 
      riskAssessment, 
      sectorAnalysis, 
      tradingAnalysis
    );

    const summary = {
      metadata: {
        generatedAt: new Date().toISOString(),
        strategy: performanceData.backtest_summary ? 'US Execution Strategy' : 'Unknown',
        period: performanceData.backtest_summary?.period || 'Unknown',
        version: '1.0.0'
      },
      
      executiveSummary: {
        totalReturn: `${performanceData.backtest_summary.total_return.toFixed(2)}%`,
        annualizedReturn: `${performanceData.backtest_summary.annualized_return.toFixed(2)}%`,
        sharpeRatio: performanceData.backtest_summary.sharpe_ratio.toFixed(2),
        maxDrawdown: `${performanceData.backtest_summary.max_drawdown.toFixed(2)}%`,
        winRate: `${(performanceData.backtest_summary.win_rate * 100).toFixed(1)}%`,
        riskLevel: riskAssessment.riskLevel,
        recommendation: riskAssessment.riskLevel === 'HIGH' ? 'REQUIRES REVIEW' : 'APPROVED'
      },
      
      performanceMetrics: {
        ...performanceData.backtest_summary,
        ...additionalMetrics,
        riskMetrics: performanceData.risk_metrics
      },
      
      riskAnalysis: riskAssessment,
      sectorAnalysis,
      tradingAnalysis,
      
      strategyReview: strategyReview ? {
        consistencyScore: strategyReview.summary.consistency_score,
        totalChecks: strategyReview.summary.total_checks,
        passedChecks: strategyReview.summary.passed_checks,
        failedChecks: strategyReview.summary.failed_checks,
        criticalIssues: strategyReview.issues.filter(issue => issue.severity === 'HIGH').length
      } : null,
      
      recommendations,
      
      investmentCommitteeNotes: {
        strengths: [
          `Strong total return of ${performanceData.backtest_summary.total_return.toFixed(2)}%`,
          `Solid risk-adjusted returns with Sharpe ratio of ${performanceData.backtest_summary.sharpe_ratio.toFixed(2)}`,
          `Good win rate of ${(performanceData.backtest_summary.win_rate * 100).toFixed(1)}%`,
          `Reasonable maximum drawdown of ${performanceData.backtest_summary.max_drawdown.toFixed(2)}%`
        ],
        concerns: riskAssessment.riskFactors,
        nextSteps: [
          'Review and address high-priority recommendations',
          'Monitor risk metrics on an ongoing basis',
          'Consider stress testing under different market conditions',
          'Evaluate sector allocation and diversification strategy'
        ]
      }
    };

    return summary;
  }

  /**
   * Save summary to file
   */
  saveSummary(summary, filename = 'backtest_summary_report.json') {
    const outputPath = path.join(this.resultsDir, filename);
    
    try {
      fs.writeFileSync(outputPath, JSON.stringify(summary, null, 2));
      console.log(`✅ Summary report saved to: ${outputPath}`);
      return outputPath;
    } catch (error) {
      console.error('Error saving summary:', error.message);
      process.exit(1);
    }
  }

  /**
   * Print summary to console
   */
  printSummary(summary) {
    console.log('\n' + '='.repeat(80));
    console.log('📈 BACKTEST SUMMARY REPORT - INVESTMENT COMMITTEE');
    console.log('='.repeat(80));
    
    console.log('\n🎯 EXECUTIVE SUMMARY:');
    console.log(`   Total Return: ${summary.executiveSummary.totalReturn}`);
    console.log(`   Annualized Return: ${summary.executiveSummary.annualizedReturn}`);
    console.log(`   Sharpe Ratio: ${summary.executiveSummary.sharpeRatio}`);
    console.log(`   Max Drawdown: ${summary.executiveSummary.maxDrawdown}`);
    console.log(`   Win Rate: ${summary.executiveSummary.winRate}`);
    console.log(`   Risk Level: ${summary.executiveSummary.riskLevel}`);
    console.log(`   Recommendation: ${summary.executiveSummary.recommendation}`);
    
    console.log('\n⚠️  RISK ANALYSIS:');
    summary.riskAnalysis.riskFactors.forEach(factor => {
      console.log(`   • ${factor}`);
    });
    
    console.log('\n🏢 SECTOR PERFORMANCE:');
    console.log(`   Top Sector: ${summary.sectorAnalysis.topPerformingSector}`);
    console.log(`   Worst Sector: ${summary.sectorAnalysis.worstPerformingSector}`);
    console.log(`   Concentration Risk: ${summary.sectorAnalysis.concentrationRisk}`);
    
    console.log('\n💼 TRADING ANALYSIS:');
    console.log(`   Trade Quality: ${summary.tradingAnalysis.tradeQuality}`);
    console.log(`   Trade Frequency: ${summary.tradingAnalysis.tradeFrequency} trades/month`);
    console.log(`   Avg Win/Loss Ratio: ${summary.tradingAnalysis.avgWinLossRatio}`);
    
    if (summary.tradingAnalysis.tradeInsights.length > 0) {
      console.log('   Insights:');
      summary.tradingAnalysis.tradeInsights.forEach(insight => {
        console.log(`     - ${insight}`);
      });
    }
    
    console.log('\n💡 KEY RECOMMENDATIONS:');
    const highPriorityRecs = summary.recommendations.filter(r => r.priority === 'HIGH');
    const mediumPriorityRecs = summary.recommendations.filter(r => r.priority === 'MEDIUM');
    
    if (highPriorityRecs.length > 0) {
      console.log('   HIGH PRIORITY:');
      highPriorityRecs.forEach(rec => {
        console.log(`     • ${rec.action}: ${rec.detail}`);
      });
    }
    
    if (mediumPriorityRecs.length > 0) {
      console.log('   MEDIUM PRIORITY:');
      mediumPriorityRecs.forEach(rec => {
        console.log(`     • ${rec.action}: ${rec.detail}`);
      });
    }
    
    console.log('\n📋 INVESTMENT COMMITTEE NOTES:');
    console.log('   Strengths:');
    summary.investmentCommitteeNotes.strengths.forEach(strength => {
      console.log(`     ✓ ${strength}`);
    });
    
    if (summary.investmentCommitteeNotes.concerns.length > 0) {
      console.log('   Concerns:');
      summary.investmentCommitteeNotes.concerns.forEach(concern => {
        console.log(`     ⚠ ${concern}`);
      });
    }
    
    console.log('\n   Next Steps:');
    summary.investmentCommitteeNotes.nextSteps.forEach(step => {
      console.log(`     → ${step}`);
    });
    
    console.log('\n' + '='.repeat(80));
    console.log(`📄 Full report saved to: backtest_summary_report.json`);
    console.log('='.repeat(80));
  }

  /**
   * Run the complete analysis
   */
  run() {
    try {
      const summary = this.generateSummary();
      this.saveSummary(summary);
      this.printSummary(summary);
      
      // Exit with appropriate code based on risk level
      const exitCode = summary.executiveSummary.riskLevel === 'HIGH' ? 1 : 0;
      process.exit(exitCode);
      
    } catch (error) {
      console.error('❌ Error generating backtest summary:', error.message);
      process.exit(1);
    }
  }
}

// Run the script if called directly
if (require.main === module) {
  const analyzer = new BacktestSummary();
  analyzer.run();
}

module.exports = BacktestSummary;