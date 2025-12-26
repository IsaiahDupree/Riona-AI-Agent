import cron from 'node-cron';
import { runInstagram } from './client/Instagram';
import logger from './config/logger';
import dotenv from 'dotenv';
import { connectDB } from './config/db';
import { exec } from 'child_process';
import util from 'util';

const execAsync = util.promisify(exec);

// Initialize environment variables
dotenv.config();

// Connect to the database
connectDB();

const RETRY_DELAY = 5 * 60 * 1000; // 5 minutes in milliseconds
const PROXY_PORT = process.env.INSTAGRAM_PROXY_PORT || '9000';

async function killProcessOnPort(port: number) {
    try {
        // Find process using the port
        const { stdout } = await execAsync(`netstat -ano | findstr :${port}`);
        if (!stdout.trim()) {
            logger.info(`No process found using port ${port}`);
            return;
        }

        const lines = stdout.split('\n');
        for (const line of lines) {
            const parts = line.trim().split(/\s+/);
            if (parts.length > 4 && parts[1].includes(`${port}`)) {
                const pid = parts[parts.length - 1];
                if (pid && pid !== '0') {
                    await execAsync(`taskkill /F /PID ${pid}`);
                    logger.info(`Killed process ${pid} using port ${port}`);
                }
            }
        }
    } catch (error) {
        // Ignore error if no process found
        if (error instanceof Error && error.message.includes('no tasks')) {
            logger.info(`No process found using port ${port}`);
            return;
        }
        logger.warn(`Error checking/killing process on port ${port}:`, error);
    }
}

async function runWithRetry() {
    try {
        // Log environment variables (excluding sensitive data)
        logger.info('Starting Instagram agent with configuration:', {
            proxyPort: PROXY_PORT,
            username: process.env.IG_USERNAME,
            hasPassword: !!process.env.IG_PASSWORD,
        });

        // Kill any process using our proxy port before starting
        await killProcessOnPort(Number(PROXY_PORT));
        
        logger.info('Starting Instagram agent scheduled run...');
        await runInstagram();
        logger.info('Instagram agent run completed successfully.');
    } catch (error) {
        logger.error('Error in Instagram agent run:', error);
        logger.info(`Will retry in ${RETRY_DELAY / 1000 / 60} minutes...`);
        setTimeout(runWithRetry, RETRY_DELAY);
    }
}

// Schedule the agent to run every 45 minutes
const schedule = '*/45 * * * *';  // Runs every 45 minutes

logger.info(`Setting up Instagram agent scheduler with schedule: ${schedule}`);

// Initial run
runWithRetry();

// Schedule subsequent runs
cron.schedule(schedule, () => {
    logger.info('Running scheduled Instagram agent task...');
    runWithRetry();
});

// Keep the process alive
process.on('uncaughtException', (error) => {
    logger.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
});
