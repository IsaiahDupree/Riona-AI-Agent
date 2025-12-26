import { SupabaseStorage } from './supabase';
import { logger } from '../utils/logger';
import dotenv from 'dotenv';

dotenv.config();

async function testSupabase() {
    logger.info('Testing Supabase connection...');
    const storage = new SupabaseStorage();

    try {
        await storage.connect();
        logger.info('Connection successful!');

        const testInteraction = {
            type: 'test',
            timestamp: new Date(),
            success: true,
            actor: 'test_user',
            metadata: {
                type: 'test',
                timestamp: new Date(),
                success: true,
                info: 'This is a test interaction'
            }
        };

        logger.info('Saving test interaction...');
        await storage.saveInteraction(testInteraction as any);
        logger.info('Interaction saved!');

        logger.info('Fetching interactions...');
        const interactions = await storage.getInteractions({ type: 'test' });
        logger.info(`Found ${interactions.length} test interactions`);

        if (interactions.length > 0) {
            logger.info('First interaction:', interactions[0]);
        }

    } catch (error) {
        logger.error('Supabase test failed:', error);
        process.exit(1);
    }
}

testSupabase();
