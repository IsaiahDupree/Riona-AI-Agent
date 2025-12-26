import express from 'express';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';
import helmet from 'helmet'; // For securing HTTP headers
import logger, { setupErrorHandlers } from './config/logger';
import { setup_HandleError } from './utils';
import { connectDB } from './config/db';
import ThreadsAgent from './threadsAgent';
import { runInstagram } from './client/Instagram';

const app = express();

try {
    // Initialize environment variables first
    logger.info('Loading environment variables...');
    dotenv.config();
    logger.info('Environment variables loaded successfully');

    // Set up process-level error handlers
    logger.info('Setting up error handlers...');
    setupErrorHandlers();
    logger.info('Error handlers configured');

    // Connect to the database
    logger.info('Connecting to database...');
    connectDB();
    logger.info('Database connection established');

    // Middleware setup
    logger.info('Configuring middleware...');
    app.use(helmet({ xssFilter: true, noSniff: true })); // Security headers
    app.use(express.json()); // JSON body parsing
    app.use(express.urlencoded({ extended: true, limit: '1kb' })); // URL-encoded data
    app.use(cookieParser()); // Cookie parsing
    logger.info('Middleware configured successfully');

    // Set up graceful shutdown
    let isShuttingDown = false;
    async function gracefulShutdown(signal: string) {
        if (isShuttingDown) return;
        isShuttingDown = true;

        logger.info(`Received ${signal} signal.`);
        logger.info('Shutting down gracefully...');

        try {
            // Close database connection
            await new Promise<void>((resolve) => {
                const { connection } = require('mongoose');
                connection.close(() => {
                    logger.info('Closed all connections gracefully.');
                    resolve();
                });
            });

            // Exit process
            process.exit(0);
        } catch (error) {
            logger.error('Error during shutdown:', error);
            process.exit(1);
        }
    }

    // Listen for shutdown signals
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));

    const runAgents = async () => {
        let threadsAgent: ThreadsAgent | null = null;
        
        try {
            // Start Threads agent
            logger.info("Starting Threads agent...");
            threadsAgent = new ThreadsAgent({
                headless: false,
                proxyPort: process.env.PROXY_PORT_2
            });
            
            logger.info("Initializing Threads agent...");
            await threadsAgent.initialize();
            logger.info("Threads agent initialized");
            
            logger.info("Logging into Threads...");
            await threadsAgent.login();
            logger.info("Threads agent logged in successfully");
            
            // Start Instagram agent
            logger.info("Starting Instagram agent...");
            await runInstagram();
            logger.info("Instagram agent finished.");
        } catch (error: any) {
            logger.error("Error running agents:", error.message);
            if (error.stack) {
                logger.error("Stack trace:", error.stack);
            }
            throw error;
        } finally {
            if (threadsAgent) {
                try {
                    logger.info("Cleaning up Threads agent...");
                    await threadsAgent.cleanup();
                    logger.info("Threads agent cleanup completed");
                } catch (cleanupError: any) {
                    logger.error("Error during cleanup:", cleanupError.message);
                    if (cleanupError.stack) {
                        logger.error("Cleanup stack trace:", cleanupError.stack);
                    }
                }
            }
        }
    };

    // Start the agents
    logger.info('Starting social media agents...');
    runAgents().catch(error => {
        setup_HandleError(error, "Error running agents:");
    });

    // Start the server if enabled
    if (process.env.WEB_SERVER_ENABLED === 'true') {
        const PORT = process.env.PORT || 3000;
        app.listen(PORT, () => {
            logger.info(`Server is running on port ${PORT}`);
        });
    } else {
        logger.info('Web server is disabled');
    }

} catch (error: any) {
    logger.error('Critical error during application startup:', error.message);
    if (error.stack) {
        logger.error('Startup error stack trace:', error.stack);
    }
    process.exit(1);
}

export default app;
