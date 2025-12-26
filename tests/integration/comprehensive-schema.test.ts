import { createClient, SupabaseClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

describe('Comprehensive Schema Tests - Real Data', () => {
    let supabase: SupabaseClient;
    const testData: any = {};

    beforeAll(async () => {
        if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
            console.warn('⚠️  Supabase credentials not configured. Skipping tests.');
            return;
        }

        supabase = createClient(
            process.env.SUPABASE_URL,
            process.env.SUPABASE_KEY
        );

        console.log('🔗 Connected to Supabase');
    });

    describe('Schema Verification', () => {
        it('should have all 16 core tables', async () => {
            if (!supabase) return;

            const expectedTables = [
                'accounts',
                'instagram_posts',
                'instagram_users',
                'campaigns',
                'interactions',
                'schedules',
                'daily_metrics',
                'engagement_tracking',
                'engagement_snapshots',
                'user_rankings',
                'ai_training_data',
                'content_performance',
                'rate_limit_tracking',
                'sessions',
                'error_logs',
                'api_usage',
                'ab_tests'
            ];

            for (const table of expectedTables) {
                const { error } = await supabase.from(table).select('*').limit(0);
                expect(error).toBeNull();
            }
        });

        it('should have materialized views', async () => {
            if (!supabase) return;

            const views = ['top_commenters', 'top_engagers', 'top_performing_comments'];

            for (const view of views) {
                const { error } = await supabase.from(view).select('*').limit(0);
                expect(error).toBeNull();
            }
        });
    });

    describe('Data Insertion', () => {
        it('should create an account', async () => {
            if (!supabase) return;

            const { data, error } = await supabase
                .from('accounts')
                .insert({
                    platform: 'instagram',
                    username: 'test_bot_comprehensive',
                    status: 'active',
                    daily_limit: 100,
                    hourly_limit: 10
                })
                .select()
                .single();

            expect(error).toBeNull();
            expect(data).toBeTruthy();
            testData.account_id = data?.id;
        });

        it('should create an Instagram user', async () => {
            if (!supabase) return;

            const { data, error } = await supabase
                .from('instagram_users')
                .insert({
                    user_id: 'test_user_123',
                    username: 'test_target_user',
                    full_name: 'Test Target User',
                    follower_count: 10000,
                    following_count: 500,
                    is_verified: false
                })
                .select()
                .single();

            expect(error).toBeNull();
            expect(data).toBeTruthy();
            testData.user_id = data?.id;
        });

        it('should create an Instagram post', async () => {
            if (!supabase) return;

            const { data, error } = await supabase
                .from('instagram_posts')
                .insert({
                    post_id: 'test_post_123',
                    url: 'https://instagram.com/p/test123',
                    author_username: 'test_target_user',
                    caption: 'This is a test post with #test #automation',
                    hashtags: ['#test', '#automation'],
                    media_type: 'photo',
                    likes_count: 150,
                    comments_count: 25,
                    posted_at: new Date().toISOString()
                })
                .select()
                .single();

            expect(error).toBeNull();
            expect(data).toBeTruthy();
            testData.post_id = data?.id;
        });

        it('should create a campaign', async () => {
            if (!supabase || !testData.account_id) return;

            const { data, error } = await supabase
                .from('campaigns')
                .insert({
                    account_id: testData.account_id,
                    name: 'Test Campaign',
                    description: 'Comprehensive schema test campaign',
                    status: 'active',
                    target_hashtags: ['#test', '#automation'],
                    daily_budget: 50
                })
                .select()
                .single();

            expect(error).toBeNull();
            expect(data).toBeTruthy();
            testData.campaign_id = data?.id;
        });

        it('should create an interaction', async () => {
            if (!supabase || !testData.account_id || !testData.post_id) return;

            const { data, error } = await supabase
                .from('interactions')
                .insert({
                    account_id: testData.account_id,
                    post_id: testData.post_id,
                    campaign_id: testData.campaign_id,
                    type: 'comment',
                    status: 'success',
                    comment_text: 'Great content! 🔥',
                    ai_model_used: 'gpt-4',
                    confidence_score: 0.95,
                    processing_time_ms: 1250,
                    metadata: JSON.stringify({
                        hashtags: ['#test'],
                        sentiment: 'positive'
                    })
                })
                .select()
                .single();

            expect(error).toBeNull();
            expect(data).toBeTruthy();
            expect(data?.type).toBe('comment');
            testData.interaction_id = data?.id;
        });

        it('should create engagement snapshot', async () => {
            if (!supabase || !testData.interaction_id || !testData.post_id) return;

            const { data, error } = await supabase
                .from('engagement_snapshots')
                .insert({
                    interaction_id: testData.interaction_id,
                    post_id: testData.post_id,
                    check_period: '1_hour',
                    post_likes_count: 152,
                    post_comments_count: 26,
                    our_comment_likes: 5,
                    our_comment_replies: 2,
                    author_replied: true,
                    likes_delta: 2,
                    comments_delta: 1,
                    impact_score: 30.2
                })
                .select()
                .single();

            expect(error).toBeNull();
            expect(data).toBeTruthy();
            expect(data?.check_period).toBe('1_hour');
        });

        it('should create engagement tracking', async () => {
            if (!supabase || !testData.interaction_id) return;

            const { data, error } = await supabase
                .from('engagement_tracking')
                .insert({
                    interaction_id: testData.interaction_id,
                    likes_on_comment: 5,
                    replies_to_comment: 2,
                    post_author_engaged: true,
                    engagement_score: 15.5
                })
                .select()
                .single();

            expect(error).toBeNull();
            expect(data).toBeTruthy();
        });
    });

    describe('Data Retrieval - Rankings', () => {
        it('should query comments with engagement', async () => {
            if (!supabase) return;

            const { data, error } = await supabase
                .from('comments_with_engagement')
                .select('*')
                .limit(10);

            expect(error).toBeNull();
            expect(Array.isArray(data)).toBe(true);
        });

        it('should query top performers', async () => {
            if (!supabase) return;

            // Refresh views first
            const { error: refreshError } = await supabase.rpc('refresh_all_rankings');

            const { data, error } = await supabase
                .from('top_performing_comments')
                .select('*')
                .limit(5);

            expect(error).toBeNull();
            expect(Array.isArray(data)).toBe(true);
        });

        it('should get engagement snapshots for an interaction', async () => {
            if (!supabase || !testData.interaction_id) return;

            const { data, error } = await supabase
                .from('engagement_snapshots')
                .select('*')
                .eq('interaction_id', testData.interaction_id)
                .order('checked_at', { ascending: false });

            expect(error).toBeNull();
            expect(Array.isArray(data)).toBe(true);
            if (data && data.length > 0) {
                expect(data[0].check_period).toBe('1_hour');
                expect(data[0].our_comment_likes).toBeGreaterThanOrEqual(0);
            }
        });
    });

    describe('Complex Queries', () => {
        it('should find posts with high engagement', async () => {
            if (!supabase) return;

            const { data, error } = await supabase
                .from('instagram_posts')
                .select('*')
                .gte('likes_count', 100)
                .order('likes_count', { ascending: false })
                .limit(10);

            expect(error).toBeNull();
            expect(Array.isArray(data)).toBe(true);
        });

        it('should get account daily metrics', async () => {
            if (!supabase || !testData.account_id) return;

            const { data, error } = await supabase
                .from('daily_metrics')
                .select('*')
                .eq('account_id', testData.account_id)
                .order('date', { ascending: false });

            expect(error).toBeNull();
            expect(Array.isArray(data)).toBe(true);
        });

        it('should filter interactions by campaign', async () => {
            if (!supabase || !testData.campaign_id) return;

            const { data, error } = await supabase
                .from('interactions')
                .select('*')
                .eq('campaign_id', testData.campaign_id)
                .eq('status', 'success');

            expect(error).toBeNull();
            expect(Array.isArray(data)).toBe(true);
            if (data && data.length > 0) {
                expect(data[0].type).toBeTruthy();
            }
        });
    });

    describe('JSONB Queries', () => {
        it('should query hashtags from posts', async () => {
            if (!supabase) return;

            const { data, error } = await supabase
                .from('instagram_posts')
                .select('*')
                .contains('hashtags', ['#test']);

            expect(error).toBeNull();
            expect(Array.isArray(data)).toBe(true);
        });

        it('should query metadata from interactions', async () => {
            if (!supabase) return;

            const { data, error } = await supabase
                .from('interactions')
                .select('metadata')
                .eq('type', 'comment')
                .limit(5);

            expect(error).toBeNull();
            expect(Array.isArray(data)).toBe(true);
        });
    });

    afterAll(async () => {
        // Cleanup test data
        if (!supabase) return;

        console.log('\n🧹 Cleaning up test data...');

        if (testData.account_id) {
            await supabase.from('accounts').delete().eq('id', testData.account_id);
        }
        if (testData.post_id) {
            await supabase.from('instagram_posts').delete().eq('id', testData.post_id);
        }
        if (testData.user_id) {
            await supabase.from('instagram_users').delete().eq('id', testData.user_id);
        }

        console.log('✅ Cleanup complete');
    });
});
