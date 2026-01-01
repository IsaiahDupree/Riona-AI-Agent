/**
 * Instagram DM Test Script
 * 
 * This script tests the DM functionality independently.
 * Run with: npm run test:dm
 */

import { Page } from 'puppeteer';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { logger } from '../utils/logger';
import dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';
import {
    processDMs,
    navigateToDMs,
    getConversations,
    initDMStorage
} from './InstagramDM';

// Load environment variables
dotenv.config();

// Setup stealth
puppeteer.use(StealthPlugin());

const LOGIN_TIMEOUT_MS = parseInt(process.env.INSTAGRAM_TIMEOUT_MS || '30000', 10);

async function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export class InstagramDMTest {
    private browser: any = null;
    private page: Page | null = null;
    private cookiesPath: string;

    constructor() {
        this.cookiesPath = path.join(process.cwd(), 'cookies.json');
    }

    async initialize(): Promise<void> {
        logger.info('Initializing Instagram DM Test');

        this.browser = await puppeteer.launch({
            headless: false,
            defaultViewport: null,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-infobars',
                '--window-position=0,0',
                '--ignore-certifcate-errors',
                '--ignore-certifcate-errors-spki-list',
                '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                '--start-maximized'
            ]
        });

        this.page = await this.browser.newPage();
        if (this.page) {
            this.page.setDefaultNavigationTimeout(LOGIN_TIMEOUT_MS);
            this.page.setDefaultTimeout(LOGIN_TIMEOUT_MS);
        }

        await this.loadCookies();
        logger.info('Browser initialized');
    }

    private async loadCookies(): Promise<void> {
        if (!this.page) return;

        try {
            if (fs.existsSync(this.cookiesPath)) {
                const cookiesString = fs.readFileSync(this.cookiesPath, 'utf8');
                const cookies = JSON.parse(cookiesString);
                await this.page.setCookie(...cookies);
                logger.info('Cookies loaded');

                await this.page.goto('https://www.instagram.com/', { waitUntil: 'networkidle0', timeout: LOGIN_TIMEOUT_MS });
                const loginButton = await this.page.$('button[type="submit"]');
                if (loginButton) {
                    logger.info('Cookies expired, need to login again');
                    await this.login();
                } else {
                    logger.info('Cookies valid, logged in');
                }
            } else {
                logger.info('No cookies found, logging in');
                await this.login();
            }
        } catch (error) {
            logger.error('Error loading cookies:', error);
            await this.login();
        }
    }

    private async login(): Promise<void> {
        if (!this.page) throw new Error('Page not initialized');

        const username = process.env.INSTAGRAM_BOT_USERNAME;
        const password = process.env.INSTAGRAM_BOT_PASSWORD;

        if (!username || !password) {
            throw new Error('Missing Instagram credentials in environment');
        }

        logger.info('Logging in to Instagram...');
        await this.page.goto('https://www.instagram.com/accounts/login/', { waitUntil: 'networkidle0', timeout: LOGIN_TIMEOUT_MS });

        // Handle cookie consent if present
        try {
            const cookieButton = await this.page.$('button[type="button"]');
            if (cookieButton) {
                await cookieButton.click();
                await delay(1000);
            }
        } catch {
            // No cookie dialog
        }

        await this.page.waitForSelector('input[name="username"]', { timeout: LOGIN_TIMEOUT_MS });
        await this.page.type('input[name="username"]', username, { delay: 50 });
        await this.page.type('input[name="password"]', password, { delay: 50 });

        await this.page.waitForSelector('button[type="submit"]', { timeout: LOGIN_TIMEOUT_MS });
        await this.page.click('button[type="submit"]');

        await this.page.waitForNavigation({ waitUntil: 'networkidle0', timeout: LOGIN_TIMEOUT_MS });

        const loginError = await this.page.$('p[role="alert"]');
        if (loginError) {
            const errorText = await this.page.evaluate(el => el.textContent, loginError);
            throw new Error(`Login failed: ${errorText}`);
        }

        const cookies = await this.page.cookies();
        fs.writeFileSync(this.cookiesPath, JSON.stringify(cookies));
        logger.info('Login successful, cookies saved');

        // Handle dialogs
        await delay(2000);
        try {
            const notNowButton = await this.page.$('button:has-text("Not Now")');
            if (notNowButton) {
                await notNowButton.click();
                await delay(1000);
            }
        } catch {
            // No dialog
        }
    }

    async testNavigateToDMs(): Promise<boolean> {
        if (!this.page) {
            throw new Error('Page not initialized');
        }

        logger.info('=== Testing DM Navigation ===');
        const success = await navigateToDMs(this.page);
        logger.info(`Navigate to DMs: ${success ? 'SUCCESS' : 'FAILED'}`);
        return success;
    }

    async testGetConversations(): Promise<void> {
        if (!this.page) {
            throw new Error('Page not initialized');
        }

        logger.info('=== Testing Get Conversations ===');
        const conversations = await getConversations(this.page, 10);
        
        logger.info(`Found ${conversations.length} conversations:`);
        for (const conv of conversations) {
            logger.info(`  - ${conv.username} (unread: ${conv.isUnread}): ${conv.lastMessage?.substring(0, 50)}...`);
        }
    }

    async testFullDMProcess(autoRespond: boolean = false): Promise<void> {
        if (!this.page) {
            throw new Error('Page not initialized');
        }

        logger.info('=== Testing Full DM Process ===');
        logger.info(`Auto-respond: ${autoRespond}`);

        await initDMStorage();

        const result = await processDMs(this.page, {
            maxConversations: 3,
            autoRespond,
            onlyUnread: true
        });

        logger.info('DM Processing Result:');
        logger.info(`  Success: ${result.success}`);
        logger.info(`  Conversations Processed: ${result.conversationsProcessed}`);
        logger.info(`  Messages Read: ${result.messagesRead}`);
        logger.info(`  Messages Sent: ${result.messagesSent}`);
        if (result.errors.length > 0) {
            logger.info(`  Errors: ${result.errors.join(', ')}`);
        }
    }

    async close(): Promise<void> {
        if (this.browser) {
            await this.browser.close();
            logger.info('Browser closed');
        }
    }

    getPage(): Page | null {
        return this.page;
    }
}

export async function runDMTest(): Promise<void> {
    const test = new InstagramDMTest();

    try {
        await test.initialize();

        // Test navigation
        const navSuccess = await test.testNavigateToDMs();
        if (!navSuccess) {
            logger.error('Navigation to DMs failed, aborting tests');
            return;
        }

        // Wait a bit between tests
        await delay(2000);

        // Test getting conversations
        await test.testGetConversations();

        await delay(2000);

        // Test full process (without auto-respond for safety)
        const autoRespond = process.env.DM_TEST_AUTO_RESPOND === 'true';
        await test.testFullDMProcess(autoRespond);

        logger.info('=== All DM Tests Completed ===');

    } catch (error) {
        logger.error('DM Test Error:', error);
    } finally {
        // Keep browser open for manual inspection if needed
        const keepOpen = process.env.DM_TEST_KEEP_OPEN === 'true';
        if (!keepOpen) {
            await test.close();
        } else {
            logger.info('Browser kept open for inspection. Close manually when done.');
        }
    }
}

// Run if executed directly
if (require.main === module) {
    runDMTest().catch(console.error);
}
