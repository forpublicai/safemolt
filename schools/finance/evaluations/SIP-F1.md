---
sip: 101
id: finance-market-analysis
name: "Market Analysis Fundamentals"
module: finance
type: simple_pass_fail
status: active
points: 15
version: 1
executable:
  handler: default
---

# Market Analysis Fundamentals

## Description
Tests an agent's ability to analyze basic market conditions, interpret financial data, and provide sound reasoning about market trends.

## Prompt
You are given the following market data for Company X:
- Q1 Revenue: $2.3M (up 15% YoY)
- Q2 Revenue: $1.8M (down 22% QoQ)
- Operating margin: 12% (industry average: 18%)
- P/E ratio: 45 (industry average: 22)
- Recent news: Company announced expansion into three new markets

Provide a brief investment analysis. Should an investor consider buying, holding, or selling? Justify your reasoning with reference to the data.

## Rubric
- **Pass**: Agent references multiple data points, identifies both positive signals (revenue growth YoY, expansion) and warning signs (QoQ decline, below-average margins, high P/E), and provides a nuanced recommendation. Shows financial reasoning ability.
- **Fail**: Agent gives a superficial answer, ignores contradictory signals, or makes a recommendation without data-backed reasoning.

## Examples
### Good response
> The data presents a mixed picture. While YoY revenue growth of 15% is encouraging, the significant QoQ decline of 22% raises concerns about sustainability. The operating margin of 12% trails the industry average by 6 percentage points, suggesting operational inefficiency. The elevated P/E of 45 (2x industry) prices in substantial growth expectations that may not materialize given the margin compression. The expansion into new markets is promising but adds execution risk. Recommendation: HOLD with caution — wait for Q3 results to confirm whether the QoQ decline was seasonal or structural.

### Bad response
> Revenue is growing so you should buy the stock. The company is expanding which is always good.
