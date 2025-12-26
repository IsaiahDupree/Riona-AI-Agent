-- Comprehensive Database Schema Migration v2.0
-- Enterprise-grade Instagram automation platform
-- This migration creates all tables, relationships, and indexes

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm"; -- For fuzzy text search

-- ============================================================================
-- CORE TABLES
-- ============================================================================

-- Enhanced accounts table with rate limiting and status tracking
CREATE TABLE IF NOT EXISTS accounts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    platform TEXT NOT NULL CHECK (platform IN ('instagram', 'twitter', 'facebook', 'tiktok')),
    username TEXT NOT NULL,
    email TEXT,
    password_hash TEXT,
    proxy_config JSONB DEFAULT '{}'::jsonb,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'rate_limited', 'banned', 'inactive')),
    preferences JSONB DEFAULT '{}'::jsonb,
    hitl_level TEXT CHECK (hitl_level IN ('off', 'soft', 'strict')),
    daily_limit INT DEFAULT 100,
    hourly_limit INT DEFAULT 10,
    working_hours JSONB DEFAULT '{"start": "09:00", "end": "17:00"}'::jsonb,
    last_activity_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(platform, username)
);

-- Instagram posts (discovered and targeted)
CREATE TABLE IF NOT EXISTS instagram_posts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    post_id TEXT UNIQUE NOT NULL,
    url TEXT UNIQUE NOT NULL,
    author_username TEXT NOT NULL,
    author_user_id TEXT,
    caption TEXT,
    hashtags TEXT[] DEFAULT ARRAY[]::TEXT[],
    media_type TEXT CHECK (media_type IN ('photo', 'video', 'carousel', 'reel')),
    likes_count INT DEFAULT 0,
    comments_count INT DEFAULT 0,
    posted_at TIMESTAMPTZ,
    discovered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Instagram users (targets and authors)
CREATE TABLE IF NOT EXISTS instagram_users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id TEXT UNIQUE NOT NULL,
    username TEXT UNIQUE NOT NULL,
    full_name TEXT,
    bio TEXT,
    follower_count INT DEFAULT 0,
    following_count INT DEFAULT 0,
    post_count INT DEFAULT 0,
    is_verified BOOLEAN DEFAULT false,
    is_private BOOLEAN DEFAULT false,
    profile_pic_url TEXT,
    last_scraped_at TIMESTAMPTZ,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Campaigns for organizing interactions
CREATE TABLE IF NOT EXISTS campaigns (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    strategy JSONB DEFAULT '{}'::jsonb,
    target_hashtags TEXT[] DEFAULT ARRAY[]::TEXT[],
    target_users UUID[] DEFAULT ARRAY[]::UUID[],
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'paused', 'completed', 'archived')),
    start_date TIMESTAMPTZ,
    end_date TIMESTAMPTZ,
    daily_budget INT DEFAULT 50,
    goals JSONB DEFAULT '{}'::jsonb,
    performance JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Enhanced interactions with full context
CREATE TABLE IF NOT EXISTS interactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    post_id UUID REFERENCES instagram_posts(id) ON DELETE SET NULL,
    campaign_id UUID REFERENCES campaigns(id) ON DELETE SET NULL,
    type TEXT NOT NULL CHECK (type IN ('comment', 'like', 'follow', 'unfollow', 'dm', 'view', 'share')),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'success', 'failed', 'moderated', 'rejected')),
    comment_text TEXT,
    ai_model_used TEXT,
    confidence_score FLOAT CHECK (confidence_score >= 0 AND confidence_score <= 1),
    processing_time_ms INT,
    error_code TEXT,
    error_message TEXT,
    retry_count INT DEFAULT 0,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);

-- ============================================================================
-- SCHEDULING & AUTOMATION
-- ============================================================================

CREATE TABLE IF NOT EXISTS schedules (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    campaign_id UUID REFERENCES campaigns(id) ON DELETE SET NULL,
    action_type TEXT NOT NULL,
    scheduled_for TIMESTAMPTZ NOT NULL,
    executed_at TIMESTAMPTZ,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'executing', 'completed', 'failed', 'cancelled')),
    parameters JSONB DEFAULT '{}'::jsonb,
    result JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================================
-- ANALYTICS & METRICS
-- ============================================================================

CREATE TABLE IF NOT EXISTS daily_metrics (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    date DATE NOT NULL,
    interactions_count INT DEFAULT 0,
    comments_count INT DEFAULT 0,
    likes_count INT DEFAULT 0,
    follows_count INT DEFAULT 0,
    success_rate FLOAT DEFAULT 0,
    avg_processing_time_ms INT DEFAULT 0,
    errors_count INT DEFAULT 0,
    follower_growth INT DEFAULT 0,
    engagement_rate FLOAT DEFAULT 0,
    top_hashtags JSONB DEFAULT '[]'::jsonb,
    top_performing_content JSONB DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(account_id, date)
);

CREATE TABLE IF NOT EXISTS engagement_tracking (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    interaction_id UUID NOT NULL REFERENCES interactions(id) ON DELETE CASCADE,
    likes_on_comment INT DEFAULT 0,
    replies_to_comment INT DEFAULT 0,
    post_author_engaged BOOLEAN DEFAULT false,
    engagement_score FLOAT DEFAULT 0,
    tracked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(interaction_id)
);

-- ============================================================================
-- AI & TRAINING
-- ============================================================================

CREATE TABLE IF NOT EXISTS ai_training_data (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    interaction_id UUID NOT NULL REFERENCES interactions(id) ON DELETE CASCADE,
    post_caption TEXT,
    post_hashtags TEXT[],
    generated_comment TEXT NOT NULL,
    engagement_score FLOAT DEFAULT 0,
    was_successful BOOLEAN NOT NULL,
    user_feedback TEXT CHECK (user_feedback IN ('positive', 'negative', 'neutral')),
    model_version TEXT,
    training_features JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS content_performance (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    post_id UUID NOT NULL REFERENCES instagram_posts(id) ON DELETE CASCADE,
    interaction_id UUID REFERENCES interactions(id) ON DELETE SET NULL,
    engagement_score FLOAT DEFAULT 0,
    time_to_engagement INTERVAL,
    content_features JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================================
-- MONITORING & SAFETY
-- ============================================================================

CREATE TABLE IF NOT EXISTS rate_limit_tracking (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    action_type TEXT NOT NULL,
    window_start TIMESTAMPTZ NOT NULL,
    window_duration INTERVAL NOT NULL DEFAULT '1 hour',
    action_count INT DEFAULT 1,
    limit_threshold INT NOT NULL,
    is_throttled BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ended_at TIMESTAMPTZ,
    interactions_count INT DEFAULT 0,
    success_rate FLOAT DEFAULT 0,
    errors JSONB[] DEFAULT ARRAY[]::JSONB[],
    browser_version TEXT,
    user_agent TEXT,
    ip_address INET,
    metadata JSONB DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS error_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    account_id UUID REFERENCES accounts(id) ON DELETE SET NULL,
    interaction_id UUID REFERENCES interactions(id) ON DELETE SET NULL,
    session_id UUID REFERENCES sessions(id) ON DELETE SET NULL,
    error_type TEXT NOT NULL,
    error_code TEXT,
    message TEXT NOT NULL,
    stack_trace TEXT,
    context JSONB DEFAULT '{}'::jsonb,
    resolved BOOLEAN DEFAULT false,
    resolved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS api_usage (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    account_id UUID REFERENCES accounts(id) ON DELETE SET NULL,
    service TEXT NOT NULL,
    endpoint TEXT,
    request_tokens INT,
    response_tokens INT,
    cost DECIMAL(10, 6),
    latency_ms INT,
    status_code INT,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================================
-- EXPERIMENTATION
-- ============================================================================

CREATE TABLE IF NOT EXISTS ab_tests (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    variant_a JSONB NOT NULL,
    variant_b JSONB NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'running', 'completed', 'archived')),
    results JSONB DEFAULT '{}'::jsonb,
    winner TEXT CHECK (winner IN ('a', 'b', 'inconclusive')),
    confidence_level FLOAT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    ended_at TIMESTAMPTZ
);

-- ============================================================================
-- INDEXES FOR PERFORMANCE
-- ============================================================================

-- Accounts
CREATE INDEX idx_accounts_platform_username ON accounts(platform, username);
CREATE INDEX idx_accounts_status ON accounts(status);
CREATE INDEX idx_accounts_last_activity ON accounts(last_activity_at DESC);

-- Posts
CREATE INDEX idx_posts_author ON instagram_posts(author_username);
CREATE INDEX idx_posts_hashtags ON instagram_posts USING GIN(hashtags);
CREATE INDEX idx_posts_discovered ON instagram_posts(discovered_at DESC);
CREATE INDEX idx_posts_media_type ON instagram_posts(media_type);

-- Users
CREATE INDEX idx_users_username ON instagram_users(username);
CREATE INDEX idx_users_user_id ON instagram_users(user_id);
CREATE INDEX idx_users_verified ON instagram_users(is_verified);

-- Campaigns
CREATE INDEX idx_campaigns_account ON campaigns(account_id);
CREATE INDEX idx_campaigns_status ON campaigns(status);
CREATE INDEX idx_campaigns_dates ON campaigns(start_date, end_date);

-- Interactions (most critical)
CREATE INDEX idx_interactions_account_created ON interactions(account_id, created_at DESC);
CREATE INDEX idx_interactions_post ON interactions(post_id);
CREATE INDEX idx_interactions_campaign ON interactions(campaign_id);
CREATE INDEX idx_interactions_status ON interactions(status);
CREATE INDEX idx_interactions_type ON interactions(type);
CREATE INDEX idx_interactions_completed ON interactions(completed_at DESC) WHERE completed_at IS NOT NULL;

-- Analytics
CREATE INDEX idx_daily_metrics_account_date ON daily_metrics(account_id, date DESC);
CREATE INDEX idx_engagement_interaction ON engagement_tracking(interaction_id);

-- Monitoring
CREATE INDEX idx_rate_limit_account_window ON rate_limit_tracking(account_id, window_start DESC);
CREATE INDEX idx_sessions_account ON sessions(account_id, started_at DESC);
CREATE INDEX idx_error_logs_created ON error_logs(created_at DESC);
CREATE INDEX idx_error_logs_resolved ON error_logs(resolved) WHERE NOT resolved;

-- API Usage
CREATE INDEX idx_api_usage_service_created ON api_usage(service, created_at DESC);

-- ============================================================================
-- TRIGGERS
-- ============================================================================

-- Auto-update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_accounts_updated_at BEFORE UPDATE ON accounts
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_campaigns_updated_at BEFORE UPDATE ON campaigns
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Auto-update last_activity_at on new interaction
CREATE OR REPLACE FUNCTION update_account_last_activity()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE accounts 
    SET last_activity_at = NEW.created_at 
    WHERE id = NEW.account_id;
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_last_activity_on_interaction 
    AFTER INSERT ON interactions
    FOR EACH ROW EXECUTE FUNCTION update_account_last_activity();

-- ============================================================================
-- ROW LEVEL SECURITY (RLS)
-- ============================================================================

ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE interactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_metrics ENABLE ROW LEVEL SECURITY;

-- Allow authenticated users to read all data
CREATE POLICY "Allow read access" ON accounts FOR SELECT USING (true);
CREATE POLICY "Allow read access" ON interactions FOR SELECT USING (true);
CREATE POLICY "Allow read access" ON campaigns FOR SELECT USING (true);
CREATE POLICY "Allow read access" ON daily_metrics FOR SELECT USING (true);

-- Allow authenticated users to insert
CREATE POLICY "Allow insert access" ON accounts FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow insert access" ON interactions FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow insert access" ON campaigns FOR INSERT WITH CHECK (true);

-- ============================================================================
-- COMMENTS
-- ============================================================================

COMMENT ON TABLE accounts IS 'Bot accounts with configuration and status tracking';
COMMENT ON TABLE instagram_posts IS 'Instagram posts discovered or targeted by the bot';
COMMENT ON TABLE instagram_users IS 'Instagram users (authors, targets, followers)';
COMMENT ON TABLE campaigns IS 'Organized campaigns for tracking and managing interactions';
COMMENT ON TABLE interactions IS 'All bot interactions (comments, likes, follows) with full context';
COMMENT ON TABLE daily_metrics IS 'Aggregated daily performance metrics per account';
COMMENT ON TABLE ai_training_data IS 'Training data for improving AI comment generation';
COMMENT ON TABLE rate_limit_tracking IS 'Real-time rate limit monitoring to prevent bans';
COMMENT ON TABLE sessions IS 'Browser session tracking for debugging';
COMMENT ON TABLE ab_tests IS 'A/B testing different engagement strategies';
