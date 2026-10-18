-- Threads posts table for market research
-- Stores every post the bot encounters on threads.net

CREATE TABLE IF NOT EXISTS threads_posts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    post_url TEXT UNIQUE NOT NULL,
    author_username TEXT NOT NULL,
    post_text TEXT,
    hashtags TEXT[] DEFAULT ARRAY[]::TEXT[],
    likes_count INT,
    replies_count INT,
    reposts_count INT,
    -- Our interaction
    our_comment TEXT,
    comment_verified BOOLEAN DEFAULT false,
    liked BOOLEAN DEFAULT false,
    skipped BOOLEAN DEFAULT false,
    skip_reason TEXT,
    -- Metadata
    session_id TEXT,
    discovered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_threads_posts_author ON threads_posts(author_username);
CREATE INDEX IF NOT EXISTS idx_threads_posts_discovered ON threads_posts(discovered_at DESC);
CREATE INDEX IF NOT EXISTS idx_threads_posts_session ON threads_posts(session_id);
CREATE INDEX IF NOT EXISTS idx_threads_posts_hashtags ON threads_posts USING GIN(hashtags);
CREATE INDEX IF NOT EXISTS idx_threads_posts_text ON threads_posts USING GIN(post_text gin_trgm_ops);

-- Enable RLS
ALTER TABLE threads_posts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all access to threads_posts" ON threads_posts FOR ALL USING (true) WITH CHECK (true);
