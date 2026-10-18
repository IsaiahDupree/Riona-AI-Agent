import { config } from 'dotenv';
import { runInstagram } from './client/Instagram-AI';
import logger from './config/logger';

async function main() {
    try {
        // Initialize environment variables
        config();
        logger.info('Environment variables loaded');

        // Run the Instagram automation
        runInstagram().catch(error => {
            console.error('Error running Instagram automation:', error);
        });
        
    } catch (error) {
        logger.error('Error in main:', error);
        process.exit(1);
    }
}

main().catch(console.error);
