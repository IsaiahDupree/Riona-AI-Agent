-- Nurture engagement tracking: VR-scheduled comments and notification-based reply detection

-- Our strategic comments on contacts' posts
CREATE TABLE nurture_comments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    username TEXT NOT NULL,
    platform TEXT NOT NULL DEFAULT 'twitter',
    tweet_url TEXT NOT NULL,
    tweet_text TEXT,
    comment_text TEXT NOT NULL,
    comment_style TEXT NOT NULL,
    vr_threshold INT,
    vr_mean_n FLOAT,
    health_at_time FLOAT,
    got_reply BOOLEAN DEFAULT false,
    got_like BOOLEAN DEFAULT false,
    reply_text TEXT,
    posted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    checked_at TIMESTAMPTZ,
    metadata JSONB DEFAULT '{}'::jsonb
);

-- Notification-detected replies to our content
CREATE TABLE notification_replies (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    notification_type TEXT NOT NULL CHECK (notification_type IN ('reply', 'mention', 'like', 'retweet', 'quote')),
    from_username TEXT NOT NULL,
    our_tweet_url TEXT,
    their_tweet_url TEXT,
    their_text TEXT,
    our_original_text TEXT,
    detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    actioned BOOLEAN DEFAULT false,
    actioned_at TIMESTAMPTZ,
    action_type TEXT, -- 'replied', 'liked', 'ignored'
    action_text TEXT,
    metadata JSONB DEFAULT '{}'::jsonb
);

-- VR state snapshots (periodic sync for analytics)
CREATE TABLE nurture_vr_snapshots (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    username TEXT NOT NULL,
    platform TEXT NOT NULL DEFAULT 'twitter',
    health FLOAT NOT NULL,
    mean_n FLOAT NOT NULL,
    total_comments INT DEFAULT 0,
    total_replies_received INT DEFAULT 0,
    thinning_stage INT DEFAULT 0,
    consecutive_ignored INT DEFAULT 0,
    best_comment_style TEXT,
    snapshot_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_nurture_comments_user ON nurture_comments(username, platform);
CREATE INDEX idx_nurture_comments_posted ON nurture_comments(posted_at DESC);
CREATE INDEX idx_notification_replies_from ON notification_replies(from_username);
CREATE INDEX idx_notification_replies_actioned ON notification_replies(actioned) WHERE NOT actioned;
CREATE INDEX idx_nurture_vr_snapshots_user ON nurture_vr_snapshots(username, platform);
