/**
 * Threads Agent
 * 
 * This module provides automation functionalities tailored for threads.net.
 * It mirrors the features provided for Instagram automation, such as login, posting updates,
 * liking posts, and commenting, adapted for the Threads platform.
 * 
 * This is a work in progress. You may need to integrate this module with the rest of the system
 * and update the methods to interface with Threads appropriately.
 */

import puppeteer from 'puppeteer-extra';
import { Browser, Page } from 'puppeteer';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import AdblockerPlugin from 'puppeteer-extra-plugin-adblocker';
import { Server } from 'proxy-chain';
import { loadCookies, saveCookies } from './utils';
import logger from './config/logger';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

// Load environment variables
dotenv.config({ override: true });

// Add stealth plugin to puppeteer
puppeteer.use(StealthPlugin());
puppeteer.use(AdblockerPlugin({
    interceptResolutionPriority: 1
}));

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

interface ThreadsAgentOptions {
    headless?: boolean;
    proxyPort?: string;
    proxyUsername?: string;
    proxyPassword?: string;
}

class ThreadsAgent {
    private options: ThreadsAgentOptions;
    private browser: Browser | null;
    private page: Page | null;
    private proxyServer: Server | null;
    private username: string;
    private password: string;

    constructor(options: ThreadsAgentOptions = {}) {
        this.options = options;
        this.browser = null;
        this.page = null;
        this.proxyServer = null;
        
        // Validate required environment variables
        const requiredEnvVars = ['THREADS_USERNAME_1', 'THREADS_PASSWORD_1'];
        const missingEnvVars = requiredEnvVars.filter(varName => !process.env[varName]);
        
        if (missingEnvVars.length > 0) {
            throw new Error(`Missing required environment variables: ${missingEnvVars.join(', ')}`);
        }

        // Store credentials
        this.username = process.env.THREADS_USERNAME_1 || '';
        this.password = process.env.THREADS_PASSWORD_1 || '';
    }

    async initialize(): Promise<void> {
        try {
            logger.info('Initializing Threads agent...');

            // Start proxy server if port is provided
            if (this.options.proxyPort) {
                logger.info(`Starting proxy server on port ${this.options.proxyPort}...`);
                this.proxyServer = new Server({ 
                    port: parseInt(this.options.proxyPort)
                });
                await this.proxyServer.listen();
                logger.info('Proxy server started successfully');
            }

            // Launch browser
            const launchOptions: any = {
                headless: this.options.headless ?? false,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--window-size=1920,1080'
                ]
            };

            if (this.proxyServer) {
                const proxyUrl = `http://localhost:${this.options.proxyPort}`;
                launchOptions.args.push(`--proxy-server=${proxyUrl}`);
            }

            logger.info('Launching browser...');
            this.browser = await puppeteer.launch(launchOptions);
            
            // Create new page
            this.page = await this.browser.newPage();
            await this.page.setViewport({ width: 1920, height: 1080 });
            
            logger.info('Browser initialized successfully');
        } catch (error: any) {
            logger.error('Error initializing Threads agent:', error.message);
            if (error.stack) {
                logger.error('Stack trace:', error.stack);
            }
            await this.cleanup();
            throw error;
        }
    }

    async login(): Promise<void> {
        if (!this.page) {
            throw new Error('Browser page not initialized');
        }

        try {
            logger.info('Attempting to log in to Threads...');

            // Navigate to Threads login page
            await this.page.goto('https://www.threads.net/login', { waitUntil: 'networkidle0' });

            // Check for existing cookies
            const cookiesPath = path.join(process.cwd(), 'cookies', `threads_${this.username}_cookies.json`);
            
            if (fs.existsSync(cookiesPath)) {
                logger.info('Found existing cookies, attempting to use them...');
                const cookies = await loadCookies(cookiesPath);
                await this.page.setCookie(...cookies);
                
                // Verify if cookies are valid
                await this.page.goto('https://www.threads.net/', { waitUntil: 'networkidle0' });
                const loginButton = await this.page.$('button[type="submit"]');
                
                if (!loginButton) {
                    logger.info('Successfully logged in with cookies');
                    return;
                }
                
                logger.warn('Cookie login failed, proceeding with credentials');
            }

            // Perform login with credentials
            logger.info('Logging in with credentials...');
            await this.page.type('input[name="username"]', this.username);
            await this.page.type('input[name="password"]', this.password);
            await Promise.all([
                this.page.click('button[type="submit"]'),
                this.page.waitForNavigation({ waitUntil: 'networkidle0' })
            ]);

            // Check for login errors
            const errorMessage = await this.page.$('p[data-testid="login-error-message"]');
            if (errorMessage) {
                const error = await this.page.evaluate((el: Element) => el.textContent, errorMessage);
                throw new Error(`Login failed: ${error}`);
            }

            // Save cookies
            logger.info('Saving cookies...');
            const cookies = await this.page.cookies();
            await saveCookies(cookiesPath, cookies);
            
            logger.info('Successfully logged in to Threads');
        } catch (error: any) {
            logger.error('Error logging in to Threads:', error.message);
            if (error.stack) {
                logger.error('Stack trace:', error.stack);
            }
            throw error;
        }
    }

    async cleanup(): Promise<void> {
        try {
            if (this.browser) {
                logger.info('Closing browser...');
                await this.browser.close();
                this.browser = null;
            }
            
            if (this.proxyServer) {
                logger.info('Stopping proxy server...');
                await this.proxyServer.close(true);
                this.proxyServer = null;
            }
            
            logger.info('Cleanup completed successfully');
        } catch (error: any) {
            logger.error('Error during cleanup:', error.message);
            if (error.stack) {
                logger.error('Stack trace:', error.stack);
            }
        }
    }
}

export default ThreadsAgent;
