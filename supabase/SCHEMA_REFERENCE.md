# Comprehensive Database Schema - Quick Reference

## Entity Relationship Overview

```
accounts (1) -----< (M) interactions
accounts (1) -----< (M) campaigns  
accounts (1) -----< (M) sessions
accounts (1) -----< (M) daily_metrics
accounts (1) -----< (M) rate_limit_tracking

campaigns (1) -----< (M) interactions
campaigns (1) -----< (M) schedules

instagram_posts (1) -----< (M) interactions
instagram_posts (1) -----< (M) content_performance

interactions (1) ----- (1) engagement_tracking
interactions (1) ----- (1) ai_training_data

instagram_users (1) -----< (M) instagram_posts (as author)
```

## Key Features

### 🔐 Security
- Row Level Security (RLS) enabled
- Password hashing support
- Proxy configuration storage

### 📊 Analytics
- Daily aggregated metrics
- Engagement tracking
- Content performance analysis
- A/B testing framework

### 🤖 AI & ML
- Training data collection
- Model versioning
- Confidence scoring
- Feature extraction

### 🛡️ Safety
- Rate limit monitoring
- Error logging and tracking
- Session management
- API usage tracking

### 📈 Performance
- 20+ optimized indexes
- GIN indexes for arrays/JSON
- Automatic timestamp management
- Efficient foreign key constraints

## Common Queries

### Get account performance
```sql
SELECT * FROM daily_metrics 
WHERE account_id = '[uuid]' 
ORDER BY date DESC 
LIMIT 30;
```

### Find best performing content
```sql
SELECT p.*, cp.engagement_score
FROM instagram_posts p
JOIN content_performance cp ON p.id = cp.post_id
ORDER BY cp.engagement_score DESC
LIMIT 10;
```

### Check rate limits
```sql
SELECT * FROM rate_limit_tracking
WHERE account_id = '[uuid]' 
  AND is_throttled = true
ORDER BY created_at DESC;
```

### Training data for AI
```sql
SELECT * FROM ai_training_data
WHERE was_successful = true
  AND engagement_score > 0.7
ORDER BY created_at DESC;
```

## Migration Path

1. **Backup existing data**
2. **Apply migration 002**
3. **Migrate data from old schema**
4. **Update application code**
5. **Test thoroughly**
6. **Deploy**
