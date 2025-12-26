# Supabase Schema Migrations

## Migration History

### 001_initial_schema.sql (Basic)
- `interactions` table
- `accounts` table  
- Basic indexes

### 002_comprehensive_schema.sql (Enterprise)
**13 Tables** with full relationships and analytics:

#### Core Tables (5)
- `accounts` - Enhanced account management
- `instagram_posts` - Post tracking
- `instagram_users` - User profiles
- `campaigns` - Campaign organization
- `interactions` - Full interaction context

#### Scheduling (1)
- `schedules` - Action scheduling

#### Analytics (3)
- `daily_metrics` - Daily KPIs
- `engagement_tracking` - Engagement monitoring
- `content_performance` - Content analysis

#### AI & Training (2)
- `ai_training_data` - Model improvement
- `ab_tests` - Strategy experiments

#### Monitoring (3)
- `rate_limit_tracking` - Ban prevention
- `sessions` - Session debugging
- `error_logs` - Error tracking
- `api_usage` - Cost management

## Applying Migrations

### Using Supabase CLI
```bash
# Apply all migrations
supabase db push

# Or apply specific migration
supabase db execute --file supabase/migrations/002_comprehensive_schema.sql
```

### Manual Application
1. Open Supabase Dashboard
2. Go to SQL Editor
3. Paste migration content
4. Run

## Schema Features

✅ **Foreign Keys** - Proper table relationships  
✅ **Indexes** - 20+ indexes for performance  
✅ **Triggers** - Auto-updating timestamps  
✅ **Constraints** - Data validation  
✅ **RLS Policies** - Row-level security  
✅ **JSON Fields** - Flexible metadata  
✅ **GIN Indexes** - Fast array/JSON queries  

## Performance Notes

- Use `EXPLAIN ANALYZE` for query optimization
- Monitor index usage with `pg_stat_user_indexes`
- Consider partitioning for `interactions` table if >10M rows
- Use materialized views for complex analytics queries

## Backup Before Migration

```bash
# Export current data
supabase db dump > backup_$(date +%Y%m%d).sql
```
