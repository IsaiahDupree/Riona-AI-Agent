import { config } from 'dotenv';
import { runInstagram } from './client/Instagram';
import logger from './config/logger';
import path from 'path';

async function main() {
    try {
        // Initialize environment variables
        const envPath = path.resolve(process.cwd(), '.env');
        config({ path: envPath });
        logger.info('Environment variables loaded');

        // Run Instagram bot
        await runInstagram();
    } catch (error) {
        logger.error('Error:', error);
        process.exit(1);
    }
}

main().catch(error => {
    logger.error('Unhandled error:', error);
    process.exit(1);
});
