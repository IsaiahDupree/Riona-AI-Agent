-- Twitter Content System: track our posted tweets and engagement snapshots

-- Our posted tweets/threads
CREATE TABLE twitter_posts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tweet_url TEXT UNIQUE,
    tweet_text TEXT NOT NULL,
    content_type TEXT NOT NULL CHECK (content_type IN ('value','engagement','promotional')),
    style TEXT,
    topic TEXT,
    niche TEXT,
    is_thread BOOLEAN DEFAULT false,
    thread_count INT DEFAULT 1,
    offer_id TEXT,
    posted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    latest_likes INT DEFAULT 0,
    latest_retweets INT DEFAULT 0,
    latest_replies INT DEFAULT 0,
    latest_views INT DEFAULT 0,
    engagement_score FLOAT DEFAULT 0,
    metadata JSONB DEFAULT '{}'::jsonb
);

-- Engagement snapshots at check-back periods
CREATE TABLE twitter_post_snapshots (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tweet_id UUID NOT NULL REFERENCES twitter_posts(id) ON DELETE CASCADE,
    check_period TEXT NOT NULL CHECK (check_period IN ('1_hour','6_hours','24_hours')),
    likes INT DEFAULT 0,
    retweets INT DEFAULT 0,
    replies INT DEFAULT 0,
    views INT DEFAULT 0,
    bookmarks INT DEFAULT 0,
    engagement_rate FLOAT DEFAULT 0,
    checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(tweet_id, check_period)
);

CREATE INDEX idx_twitter_posts_type ON twitter_posts(content_type);
CREATE INDEX idx_twitter_posts_posted ON twitter_posts(posted_at DESC);
CREATE INDEX idx_twitter_post_snapshots_tweet ON twitter_post_snapshots(tweet_id);
