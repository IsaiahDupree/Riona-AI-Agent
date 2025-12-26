# Top Rankings & Engagement Impact - Quick Reference

## New Tables

### `engagement_snapshots`
Track engagement at multiple check-back periods (1h, 6h, 24h, 7d, 30d).

**Key fields:**
- `our_comment_likes`, `our_comment_replies` - Engagement on our comment
- `post_likes_count`, `post_comments_count` - Post metrics at check time
- `likes_delta`, `comments_delta` - Change since last check
- `impact_score` - Calculated impact (likes×2 + replies×5 + author_engaged×20)

### `user_rankings`
Periodic rankings of top users.

**Tracks:**
- Posts count, engagement rates
- How many times we engaged with them
- Ranking score and position

## Materialized Views (Fast Queries)

### `top_commenters`
Users who get the most comments on their posts.
```sql
SELECT * FROM top_commenters LIMIT 10;
```

### `top_engagers`
Posts with highest engagement.
```sql
SELECT * FROM top_engagers 
WHERE our_interactions > 0 
LIMIT 20;
```

### `top_performing_comments`
Our comments that got best engagement.
```sql
SELECT * FROM top_performing_comments 
WHERE max_impact > 10 
ORDER BY max_impact DESC;
```

## Useful Queries

### See all our comments with engagement
```sql
SELECT * FROM comments_with_engagement 
ORDER BY latest_impact DESC NULLS LAST;
```

### Track engagement over time for a comment
```sql
SELECT 
    check_period,
    our_comment_likes,
    our_comment_replies,
    impact_score,
    checked_at
FROM engagement_snapshots
WHERE interaction_id = '[uuid]'
ORDER BY checked_at;
```

### Top 10 users we should engage with
```sql
SELECT 
    username,
    full_name,
    avg_comments_per_post,
    times_we_engaged,
    follower_count
FROM top_commenters tc
JOIN instagram_users u ON u.id = tc.id
WHERE times_we_engaged < 5  -- Haven't engaged much yet
ORDER BY avg_comments_per_post DESC
LIMIT 10;
```

### Comments that need check-back
```sql
SELECT 
    i.id,
    i.comment_text,
    p.url,
    i.created_at,
    NOW() - i.created_at as age
FROM interactions i
JOIN instagram_posts p ON p.id = i.post_id
WHERE i.type = 'comment' 
  AND i.status = 'success'
  AND NOT EXISTS (
      SELECT 1 FROM engagement_snapshots 
      WHERE interaction_id = i.id 
      AND check_period = '24_hours'
  )
  AND i.created_at > NOW() - INTERVAL '25 hours'
ORDER BY i.created_at DESC;
```

## Refresh Rankings

```sql
-- Refresh all materialized views
SELECT refresh_all_rankings();

-- Or individually
REFRESH MATERIALIZED VIEW CONCURRENTLY top_commenters;
```

## Check-back Workflow

1. **After 1 hour**: Check immediate engagement
2. **After 6 hours**: Check short-term impact
3. **After 24 hours**: Check daily impact
4. **After 7 days**: Check weekly impact  
5. **After 30 days**: Check long-term impact

Each check creates a snapshot in `engagement_snapshots` with calculated `impact_score`.
