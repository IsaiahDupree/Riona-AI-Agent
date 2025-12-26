# Apply Supabase Migrations

This script guides you through applying the comprehensive schema migrations.

## Prerequisites

1. **Running Supabase Instance**
   - Local: `http://localhost:54321`
   - Or cloud instance

2. **Credentials in `.env`**
   ```env
   SUPABASE_URL=http://localhost:54321
   SUPABASE_KEY=your_anon_key
   ```

## Apply Migrations

### Option 1: Using Supabase CLI (Recommended)

```bash
# Install Supabase CLI (if not installed)
npm install -g supabase

# Navigate to project
cd c:/Users/Isaia/Documents/Coding/Riona_v3

# Link to your Supabase project
supabase link --project-ref your-project-ref

# Push all migrations
supabase db push
```

### Option 2: Manual via Dashboard

1. Open Supabase Dashboard → SQL Editor
2. Run migrations in order:
   
   **Migration 1:** Basic Schema (if not already applied)
   ```bash
   # Copy: supabase/migrations/001_initial_schema.sql
   ```
   
   **Migration 2:** Comprehensive Schema
   ```bash
   # Copy: supabase/migrations/002_comprehensive_schema.sql
   ```
   
   **Migration 3:** Rankings & Impact Tracking
   ```bash
   # Copy: supabase/migrations/003_rankings_and_impact.sql
   ```

### Option 3: Node.js Script

```bash
npm run migrate:supabase
```

## Verify Migrations

After applying, verify tables exist:

```sql
SELECT table_name 
FROM information_schema.tables 
WHERE table_schema = 'public' 
ORDER BY table_name;
```

Expected tables (16 total):
- accounts
- instagram_posts
- instagram_users
- campaigns
- interactions
- schedules
- daily_metrics
- engagement_tracking
- engagement_snapshots
- user_rankings
- ai_training_data
- content_performance
- rate_limit_tracking
- sessions
- error_logs
- api_usage
- ab_tests

## Test Connection

```bash
npm run test:supabase
```
