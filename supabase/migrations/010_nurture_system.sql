-- Friendship Nurture System: tiers, interests, check-ins, cross-platform, depth

CREATE TABLE nurture_profiles (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    username TEXT NOT NULL,
    platform TEXT NOT NULL CHECK (platform IN ('twitter','instagram')),
    person_id TEXT,
    tier TEXT NOT NULL DEFAULT 'acquaintance' CHECK (tier IN ('acquaintance','casual_friend','close_friend','inner_circle')),
    tier_promoted_at TIMESTAMPTZ,
    depth_score FLOAT DEFAULT 0,
    exchange_count INT DEFAULT 0,
    interest_count INT DEFAULT 0,
    last_check_in TIMESTAMPTZ,
    next_check_in_due TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    metadata JSONB DEFAULT '{}'::jsonb,
    UNIQUE(username, platform)
);

CREATE TABLE interest_profiles (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    username TEXT NOT NULL,
    platform TEXT NOT NULL CHECK (platform IN ('twitter','instagram')),
    interests JSONB DEFAULT '[]'::jsonb,
    last_updated TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(username, platform)
);

CREATE TABLE cross_platform_identities (
    id TEXT PRIMARY KEY,
    twitter_handle TEXT,
    instagram_handle TEXT,
    linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    link_confidence TEXT NOT NULL CHECK (link_confidence IN ('manual','high','medium')),
    link_evidence JSONB DEFAULT '[]'::jsonb
);

CREATE TABLE check_in_records (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    username TEXT NOT NULL,
    platform TEXT NOT NULL CHECK (platform IN ('twitter','instagram')),
    check_in_type TEXT NOT NULL CHECK (check_in_type IN ('content_reaction','work_question','resource_share','celebrate_win')),
    scheduled_for TIMESTAMPTZ NOT NULL,
    sent_at TIMESTAMPTZ,
    content_reference TEXT,
    message_used TEXT,
    got_reply BOOLEAN,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE conversation_depth_metrics (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    username TEXT NOT NULL,
    platform TEXT NOT NULL CHECK (platform IN ('twitter','instagram')),
    avg_message_length FLOAT DEFAULT 0,
    topic_variety INT DEFAULT 0,
    personal_disclosure_level FLOAT DEFAULT 0,
    question_asking_ratio FLOAT DEFAULT 0,
    conversation_quality_score FLOAT DEFAULT 0,
    exchange_count INT DEFAULT 0,
    last_calculated TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(username, platform)
);

CREATE INDEX idx_nurture_tier ON nurture_profiles(tier);
CREATE INDEX idx_nurture_platform ON nurture_profiles(platform);
CREATE INDEX idx_nurture_next_checkin ON nurture_profiles(next_check_in_due);
CREATE INDEX idx_check_ins_platform ON check_in_records(platform, sent_at);
CREATE INDEX idx_cross_twitter ON cross_platform_identities(twitter_handle);
CREATE INDEX idx_cross_instagram ON cross_platform_identities(instagram_handle);
