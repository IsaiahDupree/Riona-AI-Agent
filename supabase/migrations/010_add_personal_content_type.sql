-- Add 'personal' content type for personal stories, insights, and behind-the-scenes tweets
ALTER TABLE twitter_posts DROP CONSTRAINT IF EXISTS twitter_posts_content_type_check;
ALTER TABLE twitter_posts ADD CONSTRAINT twitter_posts_content_type_check
    CHECK (content_type IN ('value','engagement','promotional','personal'));
