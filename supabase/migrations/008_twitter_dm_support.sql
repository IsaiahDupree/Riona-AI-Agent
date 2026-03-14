-- Twitter DM Support
-- Adds twitter_handle to crm_contacts and platform to dm_conversations

-- Add twitter_handle column to crm_contacts if it doesn't exist
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'crm_contacts' AND column_name = 'twitter_handle'
    ) THEN
        ALTER TABLE crm_contacts ADD COLUMN twitter_handle TEXT;
        CREATE INDEX idx_crm_contacts_twitter_handle ON crm_contacts(twitter_handle);
    END IF;
END $$;

-- Add platform column to dm_conversations for multi-platform support
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'dm_conversations' AND column_name = 'platform'
    ) THEN
        ALTER TABLE dm_conversations ADD COLUMN platform TEXT DEFAULT 'instagram';
        CREATE INDEX idx_dm_conversations_platform ON dm_conversations(platform);
        -- Update unique constraint to include platform
        ALTER TABLE dm_conversations DROP CONSTRAINT IF EXISTS dm_conversations_account_id_recipient_username_key;
        ALTER TABLE dm_conversations ADD CONSTRAINT dm_conversations_account_platform_recipient_key
            UNIQUE(account_id, platform, recipient_username);
    END IF;
END $$;

-- Add platform column to dm_messages for filtering
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'dm_messages' AND column_name = 'platform'
    ) THEN
        ALTER TABLE dm_messages ADD COLUMN platform TEXT DEFAULT 'instagram';
        CREATE INDEX idx_dm_messages_platform ON dm_messages(platform);
    END IF;
END $$;

-- Add platform column to dm_feedback for filtering
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'dm_feedback' AND column_name = 'platform'
    ) THEN
        ALTER TABLE dm_feedback ADD COLUMN platform TEXT DEFAULT 'instagram';
        CREATE INDEX idx_dm_feedback_platform ON dm_feedback(platform);
    END IF;
END $$;
