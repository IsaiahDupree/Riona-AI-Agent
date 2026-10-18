-- 011_sync_tables.sql
-- New tables for consolidated sync: daily snapshots, weekly trends, comments, pending sends

-- ── Daily Snapshots ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS daily_snapshots (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    date DATE NOT NULL UNIQUE,
    ig_comments INTEGER DEFAULT 0,
    ig_verified INTEGER DEFAULT 0,
    ig_likes INTEGER DEFAULT 0,
    ig_sessions INTEGER DEFAULT 0,
    ig_unique_users INTEGER DEFAULT 0,
    ig_dms_sent INTEGER DEFAULT 0,
    ig_dms_received INTEGER DEFAULT 0,
    tw_replies INTEGER DEFAULT 0,
    tw_verified INTEGER DEFAULT 0,
    tw_likes INTEGER DEFAULT 0,
    tw_sessions INTEGER DEFAULT 0,
    tw_unique_users INTEGER DEFAULT 0,
    tw_dms_sent INTEGER DEFAULT 0,
    tw_dms_received INTEGER DEFAULT 0,
    tw_tweets_posted INTEGER DEFAULT 0,
    synced_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_daily_snapshots_date ON daily_snapshots(date DESC);

-- ── Weekly Trends ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS weekly_trends (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    week_start DATE NOT NULL UNIQUE,
    week_end DATE NOT NULL,
    ig_total_comments INTEGER DEFAULT 0,
    ig_total_dms INTEGER DEFAULT 0,
    ig_avg_comments_per_day INTEGER DEFAULT 0,
    ig_avg_dms_per_day INTEGER DEFAULT 0,
    ig_active_days INTEGER DEFAULT 0,
    tw_total_replies INTEGER DEFAULT 0,
    tw_total_dms INTEGER DEFAULT 0,
    tw_total_tweets INTEGER DEFAULT 0,
    tw_avg_replies_per_day INTEGER DEFAULT 0,
    tw_avg_dms_per_day INTEGER DEFAULT 0,
    tw_active_days INTEGER DEFAULT 0,
    synced_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_weekly_trends_start ON weekly_trends(week_start DESC);

-- ── Tracked Comments ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tracked_comments (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    platform VARCHAR(20) NOT NULL,
    post_url TEXT NOT NULL,
    post_username VARCHAR(100),
    comment_text TEXT NOT NULL,
    posted_at TIMESTAMPTZ NOT NULL,
    verified BOOLEAN DEFAULT FALSE,
    session_id VARCHAR(100),
    caption_snippet TEXT,
    liked BOOLEAN DEFAULT FALSE,
    synced_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(platform, post_url, posted_at)
);

CREATE INDEX IF NOT EXISTS idx_tracked_comments_platform ON tracked_comments(platform, posted_at DESC);
CREATE INDEX IF NOT EXISTS idx_tracked_comments_username ON tracked_comments(post_username);

-- ── Pending Sends ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pending_sends (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    send_id VARCHAR(100) NOT NULL UNIQUE,
    platform VARCHAR(20) NOT NULL,
    recipient_username VARCHAR(100) NOT NULL,
    message_preview TEXT,
    objective TEXT,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL,
    reviewed_at TIMESTAMPTZ,
    sent_at TIMESTAMPTZ,
    error TEXT,
    synced_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pending_sends_platform ON pending_sends(platform, status);
CREATE INDEX IF NOT EXISTS idx_pending_sends_created ON pending_sends(created_at DESC);

-- ── Add unique constraint for platform_dms upsert dedup ─────────────
-- Prevents duplicate DM records when bulk sync re-processes the same messages
CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_dms_dedup
    ON platform_dms(platform, username, platform_timestamp);
