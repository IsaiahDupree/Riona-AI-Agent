import { logger } from './utils/logger';
import * as dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { runInstagram } from './client/Instagram-AI';
import { startServer } from './server/app';

async function main() {
    try {
        // Load environment variables
        dotenv.config({ override: true });

        // Check if .env file exists
        const envPath = path.join(process.cwd(), '.env');
        logger.info('Looking for .env file at:', envPath);
        logger.info('.env file exists:', fs.existsSync(envPath));

        // Parse mode from arguments
        const args = process.argv.slice(2);
        const modeArg = args.find(arg => arg.startsWith('--mode='));
        const mode = modeArg ? modeArg.split('=')[1] : 'background';

        logger.info(`Starting in ${mode} mode`);

        // Configure based on mode
        if (mode === 'data') {
            process.env.WEB_SERVER_ENABLED = 'true';
            logger.info('Data mode: Web server enabled for UI and tracing');
        } else {
            logger.info('Background mode: Headless operation with Supabase logging');
        }

        // Optionally start the web server (Trace & HITL APIs)
        if (process.env.WEB_SERVER_ENABLED === 'true') {
            startServer().catch((err: Error) => {
                logger.error('Error starting web server:', err);
            });
        }

        // Run Instagram automation
        runInstagram().catch((error: Error) => {
            logger.error('Error in main:', error);
            process.exit(1);
        });
    } catch (error) {
        logger.error('Error in main:', error);
    }
}

main().catch((error: Error) => logger.error('Error in main:', error));
