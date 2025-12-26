-- Enhancement Migration: Top Rankings & Engagement Impact Tracking
-- Adds views, tables, and functions for tracking top performers and engagement impact

-- ============================================================================
-- ENGAGEMENT IMPACT TRACKING (Multi-period check-backs)
-- ============================================================================

CREATE TABLE IF NOT EXISTS engagement_snapshots (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    interaction_id UUID NOT NULL REFERENCES interactions(id) ON DELETE CASCADE,
    post_id UUID NOT NULL REFERENCES instagram_posts(id) ON DELETE CASCADE,
    check_period TEXT NOT NULL CHECK (check_period IN ('1_hour', '6_hours', '24_hours', '7_days', '30_days')),
    
    -- Post metrics at check time
    post_likes_count INT DEFAULT 0,
    post_comments_count INT DEFAULT 0,
    
    -- Our comment metrics
    our_comment_likes INT DEFAULT 0,
    our_comment_replies INT DEFAULT 0,
    author_replied BOOLEAN DEFAULT false,
    author_liked BOOLEAN DEFAULT false,
    
    -- Engagement deltas (change since last check)
    likes_delta INT DEFAULT 0,
    comments_delta INT DEFAULT 0,
    
    -- Impact score (calculated)
    impact_score FLOAT DEFAULT 0,
    
    checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    UNIQUE(interaction_id, check_period)
);

-- Index for fast lookups
CREATE INDEX idx_snapshots_interaction ON engagement_snapshots(interaction_id, check_period);
CREATE INDEX idx_snapshots_checked ON engagement_snapshots(checked_at DESC);
CREATE INDEX idx_snapshots_impact ON engagement_snapshots(impact_score DESC);

-- ============================================================================
-- TOP PERFORMERS TRACKING
-- ============================================================================

CREATE TABLE IF NOT EXISTS user_rankings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES instagram_users(id) ON DELETE CASCADE,
    period TEXT NOT NULL CHECK (period IN ('daily', 'weekly', 'monthly', 'all_time')),
    period_start DATE NOT NULL,
    
    -- Engagement metrics
    posts_count INT DEFAULT 0,
    total_likes INT DEFAULT 0,
    total_comments INT DEFAULT 0,
    avg_engagement_rate FLOAT DEFAULT 0,
    
    -- Our interaction metrics
    times_we_commented INT DEFAULT 0,
    times_we_liked INT DEFAULT 0,
    engagement_from_us FLOAT DEFAULT 0,
    
    -- Ranking
    rank INT,
    score FLOAT DEFAULT 0,
    
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, period, period_start)
);

CREATE INDEX idx_rankings_period ON user_rankings(period, period_start);
CREATE INDEX idx_rankings_score ON user_rankings(score DESC);
CREATE INDEX idx_rankings_rank ON user_rankings(rank);

-- ============================================================================
-- MATERIALIZED VIEWS FOR TOP QUERIES
-- ============================================================================

-- Top commenters (users who comment most on Instagram)
CREATE MATERIALIZED VIEW IF NOT EXISTS top_commenters AS
SELECT 
    u.id,
    u.username,
    u.full_name,
    COUNT(DISTINCT p.id) as posts_with_comments,
    AVG(p.comments_count) as avg_comments_per_post,
    SUM(p.comments_count) as total_comments_seen,
    COUNT(i.id) as times_we_engaged,
    MAX(i.created_at) as last_interaction
FROM instagram_users u
JOIN instagram_posts p ON p.author_username = u.username
LEFT JOIN interactions i ON i.post_id = p.id
GROUP BY u.id, u.username, u.full_name
ORDER BY avg_comments_per_post DESC;

CREATE UNIQUE INDEX idx_top_commenters_id ON top_commenters(id);

-- Top engagers (posts with most engagement)
CREATE MATERIALIZED VIEW IF NOT EXISTS top_engagers AS
SELECT 
    p.id,
    p.url,
    p.author_username,
    p.caption,
    p.likes_count,
    p.comments_count,
    (p.likes_count + p.comments_count * 5) as engagement_score,
    COUNT(i.id) as our_interactions,
    AVG(es.impact_score) as avg_impact_from_us,
    MAX(i.created_at) as last_interaction
FROM instagram_posts p
LEFT JOIN interactions i ON i.post_id = p.id
LEFT JOIN engagement_snapshots es ON es.post_id = p.id
GROUP BY p.id, p.url, p.author_username, p.caption, p.likes_count, p.comments_count
ORDER BY engagement_score DESC;

CREATE UNIQUE INDEX idx_top_engagers_id ON top_engagers(id);

-- Top performing content (our comments that got best engagement)
CREATE MATERIALIZED VIEW IF NOT EXISTS top_performing_comments AS
SELECT 
    i.id as interaction_id,
    i.comment_text,
    i.created_at,
    p.url as post_url,
    p.author_username,
    MAX(es.our_comment_likes) as max_likes,
    MAX(es.our_comment_replies) as max_replies,
    MAX(es.impact_score) as max_impact,
    COUNT(DISTINCT es.check_period) as check_periods_tracked
FROM interactions i
JOIN instagram_posts p ON p.id = i.post_id
LEFT JOIN engagement_snapshots es ON es.interaction_id = i.id
WHERE i.type = 'comment' AND i.status = 'success'
GROUP BY i.id, i.comment_text, i.created_at, p.url, p.author_username
ORDER BY max_impact DESC;

CREATE UNIQUE INDEX idx_top_comments_id ON top_performing_comments(interaction_id);

-- ============================================================================
-- FUNCTIONS FOR CALCULATING ENGAGEMENT IMPACT
-- ============================================================================

CREATE OR REPLACE FUNCTION calculate_engagement_impact(
    p_interaction_id UUID,
    p_check_period TEXT
) RETURNS FLOAT AS $$
DECLARE
    v_impact FLOAT;
    v_comment_likes INT;
    v_comment_replies INT;
    v_author_engaged BOOLEAN;
    v_likes_delta INT;
BEGIN
    -- Get snapshot data
    SELECT 
        our_comment_likes,
        our_comment_replies,
        (author_replied OR author_liked),
        likes_delta
    INTO v_comment_likes, v_comment_replies, v_author_engaged, v_likes_delta
    FROM engagement_snapshots
    WHERE interaction_id = p_interaction_id 
      AND check_period = p_check_period;
    
    -- Calculate impact score
    -- Formula: (comment_likes * 2) + (replies * 5) + (author_engaged * 20) + (likes_delta * 0.1)
    v_impact := COALESCE(v_comment_likes * 2, 0) 
              + COALESCE(v_comment_replies * 5, 0)
              + (CASE WHEN v_author_engaged THEN 20 ELSE 0 END)
              + COALESCE(v_likes_delta * 0.1, 0);
    
    -- Update the impact score
    UPDATE engagement_snapshots
    SET impact_score = v_impact
    WHERE interaction_id = p_interaction_id 
      AND check_period = p_check_period;
    
    RETURN v_impact;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- HELPER VIEWS
-- ============================================================================

-- Summary of all our comments with URLs and engagement
CREATE OR REPLACE VIEW comments_with_engagement AS
SELECT 
    i.id,
    i.comment_text,
    i.created_at,
    p.url,
    p.author_username,
    p.caption,
    a.username as our_account,
    
    -- Engagement metrics (from latest snapshot)
    (SELECT our_comment_likes FROM engagement_snapshots 
     WHERE interaction_id = i.id ORDER BY checked_at DESC LIMIT 1) as latest_likes,
    (SELECT our_comment_replies FROM engagement_snapshots 
     WHERE interaction_id = i.id ORDER BY checked_at DESC LIMIT 1) as latest_replies,
    (SELECT impact_score FROM engagement_snapshots 
     WHERE interaction_id = i.id ORDER BY checked_at DESC LIMIT 1) as latest_impact,
    
    -- Check status
    (SELECT COUNT(*) FROM engagement_snapshots WHERE interaction_id = i.id) as check_count,
    (SELECT MAX(checked_at) FROM engagement_snapshots WHERE interaction_id = i.id) as last_checked
    
FROM interactions i
JOIN accounts a ON a.id = i.account_id
JOIN instagram_posts p ON p.id = i.post_id
WHERE i.type = 'comment' AND i.status = 'success';

-- ============================================================================
-- REFRESH FUNCTIONS FOR MATERIALIZED VIEWS
-- ============================================================================

CREATE OR REPLACE FUNCTION refresh_all_rankings() RETURNS void AS $$
BEGIN
    REFRESH MATERIALIZED VIEW CONCURRENTLY top_commenters;
    REFRESH MATERIALIZED VIEW CONCURRENTLY top_engagers;
    REFRESH MATERIALIZED VIEW CONCURRENTLY top_performing_comments;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- COMMENTS
-- ============================================================================

COMMENT ON TABLE engagement_snapshots IS 'Track engagement over time with multiple check-back periods';
COMMENT ON TABLE user_rankings IS 'Track and rank top performers by various metrics';
COMMENT ON VIEW comments_with_engagement IS 'All our comments with URLs and current engagement metrics';
