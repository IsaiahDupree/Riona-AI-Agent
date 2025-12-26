-- Supabase Schema Migration for Riona AI Bot
-- This creates the necessary tables for storing bot interactions and account data

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Create interactions table
CREATE TABLE IF NOT EXISTS interactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    type TEXT NOT NULL CHECK (type IN ('comment', 'like', 'test')),
    timestamp TIMESTAMPTZ NOT NULL,
    success BOOLEAN NOT NULL DEFAULT false,
    actor TEXT NOT NULL,
    target_user TEXT,
    target_post_url TEXT,
    error TEXT,
    details TEXT,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Create accounts table
CREATE TABLE IF NOT EXISTS accounts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    platform TEXT NOT NULL CHECK (platform IN ('instagram', 'twitter', 'facebook')),
    username TEXT NOT NULL,
    preferences JSONB DEFAULT '{}'::jsonb,
    hitl_level TEXT CHECK (hitl_level IN ('off', 'soft', 'strict')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(platform, username)
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_interactions_actor ON interactions(actor);
CREATE INDEX IF NOT EXISTS idx_interactions_timestamp ON interactions(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_interactions_type ON interactions(type);
CREATE INDEX IF NOT EXISTS idx_interactions_success ON interactions(success);
CREATE INDEX IF NOT EXISTS idx_accounts_username ON accounts(username);
CREATE INDEX IF NOT EXISTS idx_accounts_platform ON accounts(platform);

-- Create function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Create trigger for accounts table
CREATE TRIGGER update_accounts_updated_at 
    BEFORE UPDATE ON accounts 
    FOR EACH ROW 
    EXECUTE FUNCTION update_updated_at_column();

-- Add RLS (Row Level Security) policies (optional, adjust as needed)
ALTER TABLE interactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;

-- Create a SELECT policy for authenticated users
CREATE POLICY "Allow authenticated read access" ON interactions
    FOR SELECT
    USING (true);

CREATE POLICY "Allow authenticated insert access" ON interactions
    FOR INSERT
    WITH CHECK (true);

CREATE POLICY "Allow authenticated read access" ON accounts
    FOR SELECT
    USING (true);

COMMENT ON TABLE interactions IS 'Stores all bot interactions (comments, likes) with Instagram posts';
COMMENT ON TABLE accounts IS 'Stores account configurations and preferences for bot operations';
COMMENT ON COLUMN interactions.metadata IS 'Flexible JSONB field for storing additional interaction data';
COMMENT ON COLUMN accounts.preferences IS 'JSONB field for account-specific settings like daily limits, working hours, etc.';
