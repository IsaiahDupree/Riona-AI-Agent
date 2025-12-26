-- Add Graph API authentication fields to accounts table

ALTER TABLE accounts 
ADD COLUMN IF NOT EXISTS instagram_business_id TEXT,
ADD COLUMN IF NOT EXISTS facebook_page_id TEXT,
ADD COLUMN IF NOT EXISTS access_token TEXT, -- Long-lived user access token
ADD COLUMN IF NOT EXISTS token_expires_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS graph_api_enabled BOOLEAN DEFAULT FALSE;

-- Add index for faster lookups by business ID
CREATE INDEX IF NOT EXISTS idx_accounts_instagram_business_id ON accounts(instagram_business_id);

-- Comment on columns
COMMENT ON COLUMN accounts.instagram_business_id IS 'The Instagram Business Account ID from Graph API';
COMMENT ON COLUMN accounts.facebook_page_id IS 'The linked Facebook Page ID required for Graph API calls';
COMMENT ON COLUMN accounts.access_token IS 'Long-lived Graph API access token (valid for 60 days)';
COMMENT ON COLUMN accounts.token_expires_at IS 'Expiration timestamp for the access token';
COMMENT ON COLUMN accounts.graph_api_enabled IS 'Flag to prefer Graph API over Puppeteer for this account';
