-- DM System Schema
-- Conversations, messages, relationships, and approval flow

-- ============================================================================
-- DM CONVERSATIONS
-- ============================================================================

CREATE TABLE dm_conversations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    account_id UUID REFERENCES accounts(id),
    recipient_username TEXT NOT NULL,
    recipient_full_name TEXT,
    relationship_category TEXT CHECK (relationship_category IN (
        'business_networking', 'personal', 'potential_client', 'collaborator', 'fan', 'unknown'
    )) DEFAULT 'unknown',
    warmth_score INT DEFAULT 0 CHECK (warmth_score >= 0 AND warmth_score <= 100),
    stage TEXT DEFAULT 'cold_outreach' CHECK (stage IN (
        'cold_outreach', 'initial_contact', 'building', 'warm', 'active'
    )),
    last_message_at TIMESTAMPTZ,
    last_message_direction TEXT CHECK (last_message_direction IN ('inbound', 'outbound')),
    total_messages_sent INT DEFAULT 0,
    total_messages_received INT DEFAULT 0,
    tags TEXT[] DEFAULT ARRAY[]::TEXT[],
    notes TEXT,
    profile_data JSONB DEFAULT '{}'::jsonb,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(account_id, recipient_username)
);

-- ============================================================================
-- DM MESSAGES
-- ============================================================================

CREATE TABLE dm_messages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    conversation_id UUID REFERENCES dm_conversations(id) ON DELETE CASCADE,
    direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
    message_text TEXT,
    media_type TEXT DEFAULT 'text' CHECK (media_type IN ('text', 'image', 'video', 'voice', 'link', 'story_reply')),
    sent_at TIMESTAMPTZ NOT NULL,
    verified BOOLEAN DEFAULT false,
    approval_status TEXT DEFAULT 'auto' CHECK (approval_status IN (
        'auto', 'pending', 'approved', 'rejected'
    )),
    ai_model_used TEXT,
    ai_prompt_context JSONB,
    session_id TEXT,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================================
-- DM APPROVALS (pending outbound messages awaiting human review)
-- ============================================================================

CREATE TABLE dm_approvals (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    conversation_id UUID REFERENCES dm_conversations(id) ON DELETE CASCADE,
    recipient_username TEXT NOT NULL,
    proposed_message TEXT NOT NULL,
    context JSONB DEFAULT '{}'::jsonb,
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
    reviewed_at TIMESTAMPTZ,
    reviewer_note TEXT,
    expires_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '24 hours'),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================================
-- DM TEMPLATES (reusable message templates by category)
-- ============================================================================

CREATE TABLE dm_templates (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name TEXT NOT NULL,
    category TEXT NOT NULL, -- e.g. 'cold_outreach', 'follow_up', 'offer'
    template_text TEXT NOT NULL,
    variables TEXT[] DEFAULT ARRAY[]::TEXT[], -- e.g. ['name', 'niche', 'offer']
    success_rate FLOAT DEFAULT 0,
    times_used INT DEFAULT 0,
    times_replied INT DEFAULT 0,
    active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================================
-- FEEDBACK LOOP (tracks message effectiveness)
-- ============================================================================

CREATE TABLE dm_feedback (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    message_id UUID REFERENCES dm_messages(id) ON DELETE CASCADE,
    conversation_id UUID REFERENCES dm_conversations(id) ON DELETE CASCADE,
    got_reply BOOLEAN DEFAULT false,
    reply_sentiment TEXT CHECK (reply_sentiment IN ('positive', 'neutral', 'negative', 'unknown')),
    reply_within_hours FLOAT,
    led_to_conversion BOOLEAN DEFAULT false,
    conversion_type TEXT, -- e.g. 'sale', 'meeting', 'follow', 'collaboration'
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================================
-- INDEXES
-- ============================================================================

CREATE INDEX idx_dm_messages_conversation ON dm_messages(conversation_id);
CREATE INDEX idx_dm_messages_sent_at ON dm_messages(sent_at);
CREATE INDEX idx_dm_messages_direction ON dm_messages(direction);
CREATE INDEX idx_dm_conversations_recipient ON dm_conversations(recipient_username);
CREATE INDEX idx_dm_conversations_stage ON dm_conversations(stage);
CREATE INDEX idx_dm_conversations_category ON dm_conversations(relationship_category);
CREATE INDEX idx_dm_approvals_status ON dm_approvals(status);
CREATE INDEX idx_dm_feedback_message ON dm_feedback(message_id);
CREATE INDEX idx_dm_feedback_conversation ON dm_feedback(conversation_id);

-- ============================================================================
-- UPDATED_AT TRIGGERS
-- ============================================================================

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_dm_conversations_updated_at
    BEFORE UPDATE ON dm_conversations
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_dm_templates_updated_at
    BEFORE UPDATE ON dm_templates
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
