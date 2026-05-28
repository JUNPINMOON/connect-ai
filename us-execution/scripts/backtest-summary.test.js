#!/usr/bin/env node

/**
 * Test script for backtest-summary.js
 * Validates the functionality and error handling of the backtest summary script
 */

const fs = require('fs');
const path = require('path');
const BacktestSummary = require('./backtest-summary');

function runTests() {
  console.log('🧪 Running Backtest Summary Tests...\n');
  
  let testsPassed = 0;
  let testsTotal = 0;
  
  // Test 1: Check if script can load existing data
  console.log('Test 1: Loading performance metrics...');
  testsTotal++;
  try {
    const analyzer = new BacktestSummary();
    const metrics = analyzer.loadPerformanceMetrics();
    
    if (metrics && metrics.backtest_summary && metrics.risk_metrics) {
      console.log('✅ Performance metrics loaded successfully');
      testsPassed++;
    } else {
      console.log('❌ Performance metrics structure invalid');
    }
  } catch (error) {
    console.log(`❌ Failed to load performance metrics: ${error.message}`);
  }
  
  // Test 2: Check if additional metrics calculation works
  console.log('\nTest 2: Calculating additional metrics...');
  testsTotal++;
  try {
    const analyzer = new BacktestSummary();
    const metrics = analyzer.loadPerformanceMetrics();
    const additionalMetrics = analyzer.calculateAdditionalMetrics(metrics);
    
    if (additionalMetrics && additionalMetrics.volatility && additionalMetrics.annualizedVolatility) {
      console.log('✅ Additional metrics calculated successfully');
      testsPassed++;
    } else {
      console.log('❌ Additional metrics calculation failed');
    }
  } catch (error) {
    console.log(`❌ Failed to calculate additional metrics: ${error.message}`);
  }
  
  // Test 3: Check risk assessment
  console.log('\nTest 3: Risk assessment...');
  testsTotal++;
  try {
    const analyzer = new BacktestSummary();
    const metrics = analyzer.loadPerformanceMetrics();
    const additionalMetrics = analyzer.calculateAdditionalMetrics(metrics);
    const riskAssessment = analyzer.generateRiskAssessment(metrics, additionalMetrics);
    
    if (riskAssessment && riskAssessment.riskLevel && Array.isArray(riskAssessment.riskFactors)) {
      console.log('✅ Risk assessment completed successfully');
      testsPassed++;
    } else {
      console.log('❌ Risk assessment failed');
    }
  } catch (error) {
    console.log(`❌ Failed risk assessment: ${error.message}`);
  }
  
  // Test 4: Check sector analysis
  console.log('\nTest 4: Sector analysis...');
  testsTotal++;
  try {
    const analyzer = new BacktestSummary();
    const metrics = analyzer.loadPerformanceMetrics();
    const sectorAnalysis = analyzer.generateSectorAnalysis(metrics.sector_performance);
    
    if (sectorAnalysis && sectorAnalysis.topPerformingSector && sectorAnalysis.concentrationRisk) {
      console.log('✅ Sector analysis completed successfully');
      testsPassed++;
    } else {
      console.log('❌ Sector analysis failed');
    }
  } catch (error) {
    console.log(`❌ Failed sector analysis: ${error.message}`);
  }
  
  // Test 5: Check trading analysis
  console.log('\nTest 5: Trading analysis...');
  testsTotal++;
  try {
    const analyzer = new BacktestSummary();
    const metrics = analyzer.loadPerformanceMetrics();
    const tradingAnalysis = analyzer.generateTradingAnalysis(metrics.trade_statistics);
    
    if (tradingAnalysis && tradingAnalysis.tradeQuality && tradingAnalysis.tradeFrequency) {
      console.log('✅ Trading analysis completed successfully');
      testsPassed++;
    } else {
      console.log('❌ Trading analysis failed');
    }
  } catch (error) {
    console.log(`❌ Failed trading analysis: ${error.message}`);
  }
  
  // Test 6: Check full summary generation
  console.log('\nTest 6: Full summary generation...');
  testsTotal++;
  try {
    const analyzer = new BacktestSummary();
    const summary = analyzer.generateSummary();
    
    if (summary && summary.executiveSummary && summary.performanceMetrics && summary.recommendations) {
      console.log('✅ Full summary generated successfully');
      testsPassed++;
    } else {
      console.log('❌ Full summary generation failed');
    }
  } catch (error) {
    console.log(`❌ Failed full summary generation: ${error.message}`);
  }
  
  // Test 7: Check JSON output structure
  console.log('\nTest 7: JSON output validation...');
  testsTotal++;
  try {
    const analyzer = new BacktestSummary();
    const summary = analyzer.generateSummary();
    
    // Try to stringify and parse to ensure valid JSON
    const jsonString = JSON.stringify(summary, null, 2);
    const parsedSummary = JSON.parse(jsonString);
    
    if (parsedSummary.metadata && parsedSummary.executiveSummary && parsedSummary.performanceMetrics) {
      console.log('✅ JSON output structure valid');
      testsPassed++;
    } else {
      console.log('❌ JSON output structure invalid');
    }
  } catch (error) {
    console.log(`❌ JSON validation failed: ${error.message}`);
  }
  
  // Test 8: Check file output
  console.log('\nTest 8: File output...');
  testsTotal++;
  try {
    const analyzer = new BacktestSummary();
    const summary = analyzer.generateSummary();
    const testOutputPath = path.join(analyzer.resultsDir, 'test_backtest_summary.json');
    
    analyzer.saveSummary(summary, 'test_backtest_summary.json');
    
    if (fs.existsSync(testOutputPath)) {
      console.log('✅ File output successful');
      testsPassed++;
      
      // Clean up test file
      fs.unlinkSync(testOutputPath);
    } else {
      console.log('❌ File output failed');
    }
  } catch (error) {
    console.log(`❌ File output failed: ${error.message}`);
  }
  
  // Summary
  console.log(`\n📊 Test Results: ${testsPassed}/${testsTotal} tests passed`);
  
  if (testsPassed === testsTotal) {
    console.log('🎉 All tests passed! The backtest summary script is working correctly.');
    process.exit(0);
  } else {
    console.log('⚠️  Some tests failed. Please review the issues above.');
    process.exit(1);
  }
}

// Run tests if called directly
if (require.main === module) {
  runTests();
}

module.exports = { runTests };