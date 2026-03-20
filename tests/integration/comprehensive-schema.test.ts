import { createClient, SupabaseClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

describe('Comprehensive Schema Tests - Real Data', () => {
    let supabase: SupabaseClient;
    const testData: any = {};

    beforeAll(async () => {
        if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
            console.warn('Supabase credentials not configured. Skipping tests.');
            return;
        }

        supabase = createClient(
            process.env.SUPABASE_URL,
            process.env.SUPABASE_KEY
        );

        console.log('Connected to Supabase');
    });

    describe('Schema Verification', () => {
        it('should have core tables', async () => {
            if (!supabase) return;

            const expectedTables = [
                'actp_accounts',
                'mv_media_posts',
                'uba_users',
                'comment_performance',
            ];

            for (const table of expectedTables) {
                const { error } = await supabase.from(table).select('*').limit(0);
                expect(error).toBeNull();
            }
        });

        it('should reject non-existent tables', async () => {
            if (!supabase) return;

            const { error } = await supabase.from('nonexistent_table_xyz').select('*').limit(0);
            expect(error).toBeTruthy();
        });
    });

    describe('Data Insertion', () => {
        it('should create an account', async () => {
            if (!supabase) return;

            const { data, error } = await supabase
                .from('actp_accounts')
                .insert({
                    platform: 'instagram',
                    username: 'test_bot_comprehensive',
                    is_active: true,
                })
                .select()
                .single();

            expect(error).toBeNull();
            expect(data).toBeTruthy();
            expect(data?.platform).toBe('instagram');
            expect(data?.username).toBe('test_bot_comprehensive');
            testData.account_id = data?.id;
        });

        it('should create a user', async () => {
            if (!supabase) return;

            const { data, error } = await supabase
                .from('uba_users')
                .insert({
                    email: 'test_comprehensive@example.com',
                    password_hash: 'test_hash_placeholder',
                    password_salt: 'test_salt_placeholder',
                    subscription_tier: 'free',
                })
                .select()
                .single();

            expect(error).toBeNull();
            expect(data).toBeTruthy();
            expect(data?.email).toBe('test_comprehensive@example.com');
            testData.user_id = data?.id;
        });

        it('should create a media post', async () => {
            if (!supabase) return;

            const { data, error } = await supabase
                .from('mv_media_posts')
                .insert({
                    platform: 'instagram',
                    post_id: 'test_post_comprehensive_123',
                    url: 'https://instagram.com/p/test123',
                    caption_used: 'This is a test post with #test #automation',
                    posted_at: new Date().toISOString(),
                    likes: 150,
                    comments: 25,
                })
                .select()
                .single();

            expect(error).toBeNull();
            expect(data).toBeTruthy();
            expect(data?.platform).toBe('instagram');
            expect(data?.post_id).toBe('test_post_comprehensive_123');
            testData.post_id = data?.id;
        });
    });

    describe('Data Retrieval', () => {
        it('should query comment_performance', async () => {
            if (!supabase) return;

            const { data, error } = await supabase
                .from('comment_performance')
                .select('*')
                .limit(10);

            expect(error).toBeNull();
            expect(Array.isArray(data)).toBe(true);
        });

        it('should query accounts by platform', async () => {
            if (!supabase) return;

            const { data, error } = await supabase
                .from('actp_accounts')
                .select('*')
                .eq('platform', 'instagram')
                .limit(10);

            expect(error).toBeNull();
            expect(Array.isArray(data)).toBe(true);
        });

        it('should query media posts ordered by likes', async () => {
            if (!supabase) return;

            const { data, error } = await supabase
                .from('mv_media_posts')
                .select('*')
                .order('likes', { ascending: false })
                .limit(10);

            expect(error).toBeNull();
            expect(Array.isArray(data)).toBe(true);
        });

        it('should query posts with high engagement', async () => {
            if (!supabase) return;

            const { data, error } = await supabase
                .from('mv_media_posts')
                .select('*')
                .gte('likes', 100)
                .order('likes', { ascending: false })
                .limit(10);

            expect(error).toBeNull();
            expect(Array.isArray(data)).toBe(true);
        });
    });

    describe('Data Updates', () => {
        it('should update account display_name', async () => {
            if (!supabase || !testData.account_id) return;

            const { data, error } = await supabase
                .from('actp_accounts')
                .update({ display_name: 'Updated Test Bot' })
                .eq('id', testData.account_id)
                .select()
                .single();

            expect(error).toBeNull();
            expect(data?.display_name).toBe('Updated Test Bot');
        });

        it('should update post stats', async () => {
            if (!supabase || !testData.post_id) return;

            const { data, error } = await supabase
                .from('mv_media_posts')
                .update({
                    likes: 200,
                    comments: 30,
                    stats_updated_at: new Date().toISOString(),
                })
                .eq('id', testData.post_id)
                .select()
                .single();

            expect(error).toBeNull();
            expect(data?.likes).toBe(200);
            expect(data?.comments).toBe(30);
        });
    });

    describe('Filter Queries', () => {
        it('should filter accounts by is_active', async () => {
            if (!supabase) return;

            const { data, error } = await supabase
                .from('actp_accounts')
                .select('id, username, platform, is_active')
                .eq('is_active', true)
                .limit(5);

            expect(error).toBeNull();
            expect(Array.isArray(data)).toBe(true);
        });

        it('should filter posts by platform', async () => {
            if (!supabase) return;

            const { data, error } = await supabase
                .from('mv_media_posts')
                .select('id, platform, post_id, likes')
                .eq('platform', 'instagram')
                .limit(5);

            expect(error).toBeNull();
            expect(Array.isArray(data)).toBe(true);
        });
    });

    afterAll(async () => {
        if (!supabase) return;

        console.log('\nCleaning up test data...');

        if (testData.account_id) {
            await supabase.from('actp_accounts').delete().eq('id', testData.account_id);
        }
        if (testData.post_id) {
            await supabase.from('mv_media_posts').delete().eq('id', testData.post_id);
        }
        if (testData.user_id) {
            await supabase.from('uba_users').delete().eq('id', testData.user_id);
        }

        console.log('Cleanup complete');
    });
});
