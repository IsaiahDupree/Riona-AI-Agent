# Comment Method Tracking System - User Guide

## Overview

The Instagram comment bot now tracks which submission method succeeds for each comment, allowing you to identify the most reliable approach.

## Four Comment Submission Methods

1. **enter_key** - Presses Enter key (most human-like)
2. **submit_button** - Clicks `button[type="submit"]` element
3. **form_dispatch** - Programmatically dispatches form submit event
4. **role_button_text** - Finds button by role and visible text (multi-language)

The bot tries each method in order until one succeeds.

## How It Works

When a comment is posted, the system:
1. Tracks which method was attempted
2. Records time taken for each attempt
3. Stores successful method and all attempts in database metadata
4. Allows querying to compare performance

## Stored Data

Each interaction stores:
```json
{
  "comment_method": "enter_key",
  "comment_method_attempt_time_ms": 234,
  "comment_method_attempts": [
    {"method": "enter_key", "success": true, "time_ms": 234}
  ]
}
```

## Using the Analytics Module

### Generate Comparison Report

```bash
# Run the analyzer
npx ts-node src/analytics/commentMethodAnalysis.ts
```

### Programmatic Usage

```typescript
import { CommentMethodAnalyzer } from './src/analytics/commentMethodAnalysis';

const analyzer = new CommentMethodAnalyzer();

// Get success rates
const stats = await analyzer.getMethodSuccessRates();
console.log(stats);

// Generate full report
const report = await analyzer.generateComparisonReport();
console.log(report);

// Check performance over time
const trend = await analyzer.getMethodPerformanceOverTime('enter_key', 7);
console.log(trend);
```

## SQL Queries

### Get Overall Stats
```sql
SELECT * FROM get_comment_method_stats();
```

### Check Recent Comments
```sql
SELECT 
    created_at,
    metadata->>'comment_method' as method,
    metadata->>'comment_method_attempt_time_ms' as time_ms,
    status
FROM interactions
WHERE type = 'comment'
ORDER BY created_at DESC
LIMIT 20;
```

### Method Success Rate by Day
```sql
SELECT 
    DATE(created_at) as date,
    metadata->>'comment_method' as method,
    COUNT(*) as total,
    SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as successful,
    ROUND(100.0 * SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) / COUNT(*), 2) as success_rate
FROM interactions
WHERE type = 'comment'
    AND created_at > NOW() - INTERVAL '7 days'
GROUP BY DATE(created_at), metadata->>'comment_method'
ORDER BY date DESC, success_rate DESC;
```

## Example Output

```
# Comment Method Comparison Report

Generated: 2025-11-26T05:00:00.000Z

## Overall Statistics

| Method | Uses | Successes | Failures | Success Rate | Avg Time (ms) | Min Time | Max Time |
|--------|------|-----------|----------|--------------|---------------|----------|----------|
| enter_key | 45 | 43 | 2 | 95.56% | 245 | 180 | 420 |
| submit_button | 12 | 10 | 2 | 83.33% | 312 | 215 | 580 |
| form_dispatch | 3 | 2 | 1 | 66.67% | 398 | 290 | 510 |

## Recommendations

**Most Reliable Method**: enter_key
- Success Rate: 95.56%
- Average Time: 245ms
- Total Uses: 45

**Method Ranking** (by success rate):
1. enter_key (95.56%)
2. submit_button (83.33%)
3. form_dispatch (66.67%)
```

## Optimizing Method Order

Based on collected data, you can reorder methods in `Instagram-Core.ts`:

```typescript
// Current order (in submitMethods array):
// 1. enter_key
// 2. submit_button
// 3. form_dispatch
// 4. role_button_text

// If data shows submit_button is more reliable, swap them:
// 1. submit_button ← try first
// 2. enter_key ← fallback
// 3. form_dispatch
// 4. role_button_text
```

## Running A/B Tests

To test a specific method exclusively:

1. Comment out other methods in `Instagram-Core.ts`
2. Run bot for 10-20 comments
3. Restore other methods
4. Compare results

## Monitoring Performance

Check for degradation over time:

```typescript
const analyzer = new CommentMethodAnalyzer();
const trend = await analyzer.getMethodPerformanceOverTime('enter_key', 30);

// If success rate drops, Instagram may have changed their DOM
trend.forEach(day => {
    if (day.success_rate < 80) {
        console.warn(`Low success rate on ${day.date}: ${day.success_rate}%`);
    }
});
```

## Next Steps

1. Run bot normally - data will be collected automatically
2. After 50+ comments, run analysis
3. Identify best method
4. Optionally reorder methods for optimization
5. Monitor performance over time for DOM changes

## Files Created

- `src/analytics/commentMethodAnalysis.ts` - Analytics module
- `supabase/migrations/004_comment_method_analytics.sql` - SQL function
- `src/client/Instagram-Core.ts` - Enhanced with tracking (lines 904-1099)
