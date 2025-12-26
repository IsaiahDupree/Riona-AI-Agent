import { runInstagram } from './client/Instagram-AI';
import logger from './config/logger';

async function main() {
    logger.info('Starting Instagram bot test...');
    
    try {
        await runInstagram();
        logger.info('Instagram bot test completed successfully');
    } catch (error) {
        logger.error('Instagram bot test failed:', error);
        console.error('Error running Instagram bot:', error);
        process.exit(1);
    }
}

main().catch(error => {
    logger.error('Test failed with error:', error);
    process.exit(1);
});
