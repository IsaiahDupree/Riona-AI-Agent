import { SupabaseStorage } from '../../src/db/supabase';
import { generateComment } from '../../src/client/Instagram-Core';
import dotenv from 'dotenv';

dotenv.config();

describe('Integration Tests', () => {
    describe('SupabaseStorage', () => {
        let storage: SupabaseStorage;

        beforeAll(async () => {
            storage = new SupabaseStorage();
            // Only run if credentials are configured
            if (process.env.SUPABASE_URL && process.env.SUPABASE_KEY) {
                try {
                    await storage.connect();
                } catch (error) {
                    console.warn('Supabase connection failed, skipping tests');
                }
            }
        });

        it('should connect to Supabase if configured', async () => {
            if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
                console.log('Skipping: Supabase credentials not configured');
                return;
            }

            await expect(storage.connect()).resolves.not.toThrow();
        });

        it('should save interaction to Supabase if configured', async () => {
            if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
                console.log('Skipping: Supabase credentials not configured');
                return;
            }

            const interaction = {
                type: 'test',
                timestamp: new Date(),
                success: true,
                actor: 'test_user',
                metadata: {
                    type: 'test',
                    timestamp: new Date(),
                    success: true
                }
            };

            await expect(storage.saveInteraction(interaction as any)).resolves.not.toThrow();
        });
    });

    describe('OpenAI Integration', () => {
        it('should generate a comment using OpenAI if configured', async () => {
            if (!process.env.OPENAI_API_KEY) {
                console.log('Skipping: OpenAI API key not configured');
                return;
            }

            const comment = await generateComment('This is a beautiful sunset photo');
            expect(comment).toBeTruthy();
            expect(comment).not.toBeNull();
            if (comment) {
                expect(typeof comment).toBe('string');
                expect(comment.length).toBeGreaterThan(0);
            }

        }, 30000); // Increase timeout for API call
    });
});
