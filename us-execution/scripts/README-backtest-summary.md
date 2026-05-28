# Backtest Summary Script

This script analyzes backtest results and generates comprehensive performance summaries for the Connect AI US Execution Strategy investment committee approval process.

## Purpose

The backtest summary script provides Codex persona with the ability to:
- Analyze backtest performance metrics
- Extract key performance indicators for investment committee review
- Generate risk assessments and recommendations
- Provide structured JSON reports for decision-making

## Usage

### Basic Usage
```bash
# Run the backtest summary analysis
npm run test:backtest-summary

# Or run directly
node us-execution/scripts/backtest-summary.js
```

### Testing
```bash
# Run comprehensive tests
node us-execution/scripts/backtest-summary.test.js
```

## Input Files

The script reads from the following files in `us-execution/backtest_results/`:

1. **performance_metrics.json** - Required
   - Backtest summary statistics
   - Monthly returns data
   - Sector performance metrics
   - Risk metrics (VaR, beta, correlation)
   - Trade statistics

2. **strategy_review_report.json** - Optional
   - Strategy consistency analysis
   - Configuration issues
   - Risk assessment warnings

## Output Files

The script generates:

1. **backtest_summary_report.json** - Complete analysis report
   - Executive summary
   - Detailed performance metrics
   - Risk analysis
   - Sector and trading analysis
   - Investment committee recommendations

2. **Console output** - Formatted summary display
   - Key metrics overview
   - Risk assessment
   - Priority recommendations

## Key Metrics Analyzed

### Performance Indicators
- Total return and annualized return
- Sharpe ratio and Sortino ratio
- Maximum drawdown
- Win rate and profit factor
- Monthly volatility and best/worst months

### Risk Metrics
- Value at Risk (VaR 95%)
- Conditional VaR (CVaR 95%)
- Beta and market correlation
- Tracking error and information ratio

### Trading Analysis
- Total trades and win/loss ratio
- Average trade duration
- Trade frequency analysis
- Win/loss distribution

### Sector Analysis
- Sector performance breakdown
- Concentration risk assessment
- Top and worst performing sectors

## Investment Committee Features

The script provides investment committee-specific outputs:

- **Risk Level Classification**: LOW/MEDIUM/HIGH based on multiple factors
- **Recommendation**: APPROVED/REQUIRES REVIEW based on risk assessment
- **Priority Recommendations**: Categorized by HIGH/MEDIUM priority
- **Executive Summary**: Quick overview for committee review
- **Next Steps**: Action items for ongoing monitoring

## Integration with Connect AI

The script is designed to integrate with the Connect AI ecosystem:

- Uses existing backtest result files
- Outputs structured JSON for agent consumption
- Provides clear recommendation signals
- Supports automated decision workflows

## Error Handling

The script includes comprehensive error handling:
- Validates input file existence
- Handles malformed JSON gracefully
- Provides clear error messages
- Exits with appropriate codes (0 for success, 1 for errors/high risk)

## Security Considerations

- Read-only access to backtest results
- No external API calls
- No sensitive data exposure
- Local file processing only

## Dependencies

- Node.js (built-in modules only)
- No external npm packages required
- Pure JavaScript implementation

## Verification

The script includes automated tests that verify:
- Data loading and parsing
- Metric calculations
- Risk assessment logic
- JSON output structure
- File generation capabilities

Run tests with: `node us-execution/scripts/backtest-summary.test.js`