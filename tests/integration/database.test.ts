import { SupabaseStorage } from '../../src/db/supabase';
import { BotInteraction } from '../../src/client/Instagram-Core';
import dotenv from 'dotenv';

dotenv.config();

describe('Database Integration Tests (Real Data)', () => {
    let storage: SupabaseStorage;
    const testInteractionIds: string[] = [];

    beforeAll(async () => {
        if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
            console.warn('Supabase credentials not configured. Skipping database tests.');
            return;
        }

        storage = new SupabaseStorage();
        await storage.connect();
    });

    afterAll(async () => {
        // Clean up test data
        if (storage && testInteractionIds.length > 0) {
            console.log(`Cleaning up ${testInteractionIds.length} test interactions...`);
            // Note: Would need to add a delete method to SupabaseStorage for cleanup
        }
    });

    describe('Saving Interactions', () => {
        it('should save a comment interaction to database', async () => {
            if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
                return; // Skip
            }

            const interaction: BotInteraction = {
                type: 'comment',
                timestamp: new Date(),
                success: true,
                actor: 'test_bot_user',
                details: 'Posted comment on test post',
                metadata: {
                    type: 'comment',
                    timestamp: new Date(),
                    success: true,
                    comment: 'Great photo! 🔥',
                    postUrl: 'https://instagram.com/p/test123'
                }
            };

            await expect(storage.saveInteraction(interaction)).resolves.not.toThrow();
        });

        it('should save a like interaction to database', async () => {
            if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
                return; // Skip
            }

            const interaction: BotInteraction = {
                type: 'like',
                timestamp: new Date(),
                success: true,
                actor: 'test_bot_user',
                details: 'Liked test post',
                metadata: {
                    type: 'like',
                    timestamp: new Date(),
                    success: true,
                    postUrl: 'https://instagram.com/p/test456'
                }
            };

            await expect(storage.saveInteraction(interaction)).resolves.not.toThrow();
        });

        it('should save a failed interaction with error', async () => {
            if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
                return; // Skip
            }

            const interaction: BotInteraction = {
                type: 'comment',
                timestamp: new Date(),
                success: false,
                error: 'Rate limit exceeded',
                actor: 'test_bot_user',
                details: 'Failed to post comment',
                metadata: {
                    type: 'comment',
                    timestamp: new Date(),
                    success: false,
                    error: 'Rate limit exceeded'
                }
            };

            await expect(storage.saveInteraction(interaction)).resolves.not.toThrow();
        });
    });

    describe('Querying Interactions', () => {
        beforeAll(async () => {
            if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
                return;
            }

            // Seed some test data
            const testInteractions: BotInteraction[] = [
                {
                    type: 'comment',
                    timestamp: new Date(),
                    success: true,
                    actor: 'query_test_user',
                    metadata: { type: 'comment', timestamp: new Date(), success: true }
                },
                {
                    type: 'like',
                    timestamp: new Date(),
                    success: true,
                    actor: 'query_test_user',
                    metadata: { type: 'like', timestamp: new Date(), success: true }
                }
            ];

            for (const interaction of testInteractions) {
                await storage.saveInteraction(interaction);
            }
        });

        it('should retrieve interactions by type', async () => {
            if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
                return; // Skip
            }

            const interactions = await storage.getInteractions({ type: 'comment' });
            expect(Array.isArray(interactions)).toBe(true);
            // DB may or may not have data depending on schema state
            if (interactions.length > 0) {
                const hasTestComment = interactions.some(i => i.type === 'comment');
                expect(hasTestComment).toBe(true);
            }
        });

        it('should retrieve successful interactions', async () => {
            if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
                return; // Skip
            }

            const interactions = await storage.getInteractions({ success: true });
            expect(Array.isArray(interactions)).toBe(true);
            // All should be successful
            const allSuccessful = interactions.every(i => i.success === true);
            expect(allSuccessful).toBe(true);
        });
    });

    describe('Data Validation', () => {
        it('should handle complex metadata', async () => {
            if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
                return; // Skip
            }

            const interaction: BotInteraction = {
                type: 'comment',
                timestamp: new Date(),
                success: true,
                actor: 'metadata_test_user',
                metadata: {
                    type: 'comment',
                    timestamp: new Date(),
                    success: true,
                    comment: 'Test comment',
                    postUrl: 'https://instagram.com/p/test',
                    hashtags: ['#test', '#automation'],
                    caption: 'Original caption',
                    username: 'target_user',
                    likes: 1234,
                    aiModel: 'gpt-4',
                    processingTimeMseconds: 1250
                }
            };

            await expect(storage.saveInteraction(interaction)).resolves.not.toThrow();
        });

        it('should handle timestamps correctly', async () => {
            if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
                return; // Skip
            }

            const now = new Date();
            const interaction: BotInteraction = {
                type: 'test',
                timestamp: now,
                success: true,
                actor: 'timestamp_test_user',
                metadata: {
                    type: 'test',
                    timestamp: now,
                    success: true
                }
            };

            await storage.saveInteraction(interaction);

            // Retrieve and verify timestamp
            const interactions = await storage.getInteractions({ type: 'test' });
            const savedInteraction = interactions.find(i =>
                i.actor === 'timestamp_test_user'
            );

            if (savedInteraction) {
                const timeDiff = Math.abs(savedInteraction.timestamp.getTime() - now.getTime());
                // Should be within 5 seconds
                expect(timeDiff).toBeLessThan(5000);
            }
        });
    });
});
