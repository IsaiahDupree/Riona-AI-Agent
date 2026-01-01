/**
 * Instagram DM with Safari Browser
 * 
 * This script uses Safari/WebKit via Playwright for Instagram DM automation.
 * Safari can be useful to avoid detection as it's less commonly automated.
 * 
 * Run with: npm run test:dm:safari
 */

import { logger } from '../utils/logger';
import dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';
import {
    launchBrowser,
    getBrowserTypeFromEnv,
    loadCookiesForBrowser,
    saveCookiesFromBrowser,
    UnifiedPage,
    UnifiedBrowser,
    BrowserType
} from './BrowserAdapter';
import {
    processDMs,
    navigateToDMs,
    getConversations,
    initDMStorage,
    DMProcessResult
} from './InstagramDM';

// Load environment variables
dotenv.config();

const LOGIN_TIMEOUT_MS = parseInt(process.env.INSTAGRAM_TIMEOUT_MS || '30000', 10);

async function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export class InstagramDMSafari {
    private browser: UnifiedBrowser | null = null;
    private page: UnifiedPage | null = null;
    private cookiesPath: string;
    private browserType: BrowserType;

    constructor(browserType: BrowserType = 'safari') {
        this.browserType = browserType;
        this.cookiesPath = path.join(process.cwd(), `cookies_${browserType}.json`);
    }

    async initialize(): Promise<void> {
        logger.info(`Initializing Instagram DM with ${this.browserType} browser`);

        this.browser = await launchBrowser({
            browserType: this.browserType,
            headless: false, // Keep visible for testing
            slowMo: 50 // Slow down actions slightly for stability
        });

        this.page = await this.browser.newPage();
        this.page.setDefaultTimeout(LOGIN_TIMEOUT_MS);
        this.page.setDefaultNavigationTimeout(LOGIN_TIMEOUT_MS);

        // Try to load existing cookies
        const cookiesLoaded = await loadCookiesForBrowser(this.page, this.cookiesPath);
        
        if (cookiesLoaded) {
            // Verify cookies are still valid
            await this.page.goto('https://www.instagram.com/', { waitUntil: 'networkidle', timeout: LOGIN_TIMEOUT_MS });
            await delay(2000);
            
            const url = this.page.url();
            if (url.includes('/accounts/login')) {
                logger.info('Cookies expired, need to login');
                await this.login();
            } else {
                logger.info('Logged in with cookies');
            }
        } else {
            await this.login();
        }

        logger.info(`${this.browserType} browser initialized and logged in`);
    }

    private async login(): Promise<void> {
        if (!this.page) throw new Error('Page not initialized');

        const username = process.env.INSTAGRAM_BOT_USERNAME;
        const password = process.env.INSTAGRAM_BOT_PASSWORD;

        if (!username || !password) {
            throw new Error('Missing Instagram credentials. Set INSTAGRAM_BOT_USERNAME and INSTAGRAM_BOT_PASSWORD in .env');
        }

        logger.info('Logging in to Instagram...');
        await this.page.goto('https://www.instagram.com/accounts/login/', { 
            waitUntil: 'networkidle', 
            timeout: LOGIN_TIMEOUT_MS 
        });
        await delay(2000);

        // Handle cookie consent dialog (EU users)
        try {
            const cookieButtons = await this.page.$$('button');
            for (const btn of cookieButtons) {
                const text = await this.page.evaluate((el: any) => el.textContent || '', btn);
                if (text.toLowerCase().includes('allow') || text.toLowerCase().includes('accept')) {
                    await btn.click();
                    await delay(1000);
                    break;
                }
            }
        } catch {
            // No cookie dialog
        }

        // Wait for login form
        await this.page.waitForSelector('input[name="username"]', { timeout: LOGIN_TIMEOUT_MS });
        
        // Type credentials with delays
        await this.page.type('input[name="username"]', username, { delay: 80 });
        await delay(500);
        await this.page.type('input[name="password"]', password, { delay: 80 });
        await delay(500);

        // Click login button
        await this.page.click('button[type="submit"]');
        
        // Wait for navigation
        await delay(5000);
        await this.page.waitForNavigation({ waitUntil: 'networkidle', timeout: LOGIN_TIMEOUT_MS }).catch(() => {});

        // Check for login errors
        const currentUrl = this.page.url();
        if (currentUrl.includes('/accounts/login')) {
            // Check for error message
            const errorEl = await this.page.$('p[role="alert"], #slfErrorAlert');
            if (errorEl) {
                const errorText = await this.page.evaluate((el: any) => el.textContent, errorEl);
                throw new Error(`Login failed: ${errorText}`);
            }
        }

        // Handle "Save Login Info" dialog
        await delay(2000);
        try {
            const buttons = await this.page.$$('button');
            for (const btn of buttons) {
                const text = await this.page.evaluate((el: any) => el.textContent || '', btn);
                if (text.toLowerCase().includes('not now')) {
                    await btn.click();
                    await delay(1000);
                    break;
                }
            }
        } catch {
            // No dialog
        }

        // Handle "Turn on Notifications" dialog
        await delay(1000);
        try {
            const buttons = await this.page.$$('button');
            for (const btn of buttons) {
                const text = await this.page.evaluate((el: any) => el.textContent || '', btn);
                if (text.toLowerCase().includes('not now')) {
                    await btn.click();
                    await delay(1000);
                    break;
                }
            }
        } catch {
            // No dialog
        }

        // Save cookies for future sessions
        await saveCookiesFromBrowser(this.page, this.cookiesPath);
        logger.info('Login successful, cookies saved');
    }

    async testNavigateToDMs(): Promise<boolean> {
        if (!this.page) throw new Error('Page not initialized');

        logger.info('=== Testing DM Navigation ===');
        
        // Navigate to DMs
        await this.page.goto('https://www.instagram.com/direct/inbox/', {
            waitUntil: 'networkidle',
            timeout: LOGIN_TIMEOUT_MS
        });
        await delay(3000);

        // Check if we're on the DM page
        const url = this.page.url();
        const success = url.includes('/direct');
        
        logger.info(`Navigate to DMs: ${success ? 'SUCCESS' : 'FAILED'}`);
        return success;
    }

    async testGetConversations(): Promise<void> {
        if (!this.page) throw new Error('Page not initialized');

        logger.info('=== Testing Get Conversations ===');
        
        // Get conversation elements
        await delay(2000);
        
        // Try to find conversation items
        const selectors = [
            'div[role="listbox"] > div',
            'a[href*="/direct/t/"]',
            'div[class*="x9f619"]' // Common Instagram class pattern
        ];

        let conversations: any[] = [];
        for (const selector of selectors) {
            const elements = await this.page.$$(selector);
            if (elements.length > 0) {
                logger.info(`Found ${elements.length} elements with selector: ${selector}`);
                conversations = elements.slice(0, 10);
                break;
            }
        }

        if (conversations.length === 0) {
            logger.warn('No conversations found');
        } else {
            logger.info(`Found ${conversations.length} conversation elements`);
            
            // Try to extract usernames
            for (let i = 0; i < Math.min(5, conversations.length); i++) {
                try {
                    const text = await this.page.evaluate((el: any) => {
                        const spans = el.querySelectorAll('span');
                        for (const span of spans) {
                            const t = span.textContent?.trim();
                            if (t && t.length > 0 && t.length < 50 && !t.includes('\n')) {
                                return t;
                            }
                        }
                        return el.textContent?.substring(0, 50) || 'Unknown';
                    }, conversations[i]);
                    logger.info(`  Conversation ${i + 1}: ${text}`);
                } catch (e) {
                    logger.debug(`Could not extract text for conversation ${i + 1}`);
                }
            }
        }
    }

    async openFirstConversation(): Promise<boolean> {
        if (!this.page) throw new Error('Page not initialized');

        logger.info('=== Opening First Conversation ===');
        
        // Try multiple selectors for conversation items
        const conversationSelectors = [
            'a[href*="/direct/t/"]',
            'div[role="listbox"] > div > div',
            'div[class*="x9f619"][role="button"]',
            'div[tabindex="0"][role="button"]'
        ];

        let clicked = false;
        for (const selector of conversationSelectors) {
            const elements = await this.page.$$(selector);
            logger.info(`Trying selector "${selector}": found ${elements.length} elements`);
            
            if (elements.length > 0) {
                // Try clicking the first few elements to find a conversation
                for (let i = 0; i < Math.min(3, elements.length); i++) {
                    try {
                        await elements[i].click();
                        await delay(2000);
                        
                        // Check if we're in a conversation now
                        const url = this.page.url();
                        if (url.includes('/direct/t/')) {
                            logger.info(`Clicked element ${i} - now in conversation`);
                            clicked = true;
                            break;
                        }
                    } catch (e) {
                        logger.debug(`Click failed on element ${i}`);
                    }
                }
                if (clicked) break;
            }
        }

        if (!clicked) {
            // Try clicking on any visible conversation-like element
            logger.info('Trying to find clickable conversation elements...');
            const allDivs = await this.page.$$('div[role="button"]');
            for (let i = 0; i < Math.min(10, allDivs.length); i++) {
                try {
                    const text = await this.page.evaluate((el: any) => el.textContent?.substring(0, 50) || '', allDivs[i]);
                    if (text.length > 0 && !text.includes('New message') && !text.includes('Requests')) {
                        await allDivs[i].click();
                        await delay(2000);
                        const url = this.page.url();
                        if (url.includes('/direct/t/')) {
                            logger.info(`Clicked div with text: "${text}" - now in conversation`);
                            clicked = true;
                            break;
                        }
                    }
                } catch {
                    // Continue trying
                }
            }
        }

        await delay(2000);

        // Check if we're in a conversation
        const messageInput = await this.page.$('textarea[placeholder*="Message"], div[contenteditable="true"][role="textbox"]');
        if (messageInput) {
            logger.info('Successfully opened conversation - message input found');
            return true;
        }

        // Check URL as fallback
        const url = this.page.url();
        if (url.includes('/direct/t/')) {
            logger.info('In conversation based on URL');
            return true;
        }

        logger.warn('Could not verify conversation opened');
        return false;
    }

    async readCurrentMessages(): Promise<string[]> {
        if (!this.page) throw new Error('Page not initialized');

        logger.info('=== Reading Messages ===');
        
        const messages: string[] = [];
        
        // Try to find message elements
        const messageSelectors = [
            'div[role="row"]',
            'div[dir="auto"]',
            'span[dir="auto"]'
        ];

        for (const selector of messageSelectors) {
            const elements = await this.page.$$(selector);
            if (elements.length > 5) { // Should have multiple messages
                logger.info(`Found ${elements.length} potential message elements`);
                
                for (let i = 0; i < Math.min(10, elements.length); i++) {
                    try {
                        const text = await this.page.evaluate((el: any) => {
                            return el.textContent?.trim() || '';
                        }, elements[i]);
                        
                        if (text && text.length > 0 && text.length < 500) {
                            messages.push(text);
                        }
                    } catch {
                        // Skip errors
                    }
                }
                break;
            }
        }

        logger.info(`Read ${messages.length} messages`);
        for (const msg of messages.slice(-5)) {
            logger.info(`  > ${msg.substring(0, 80)}${msg.length > 80 ? '...' : ''}`);
        }

        return messages;
    }

    async close(): Promise<void> {
        if (this.browser) {
            await this.browser.close();
            logger.info('Browser closed');
        }
    }

    getPage(): UnifiedPage | null {
        return this.page;
    }
}

export async function runSafariDMTest(): Promise<void> {
    // Get browser type from env or default to safari
    const browserType = (process.env.BROWSER_TYPE as BrowserType) || 'safari';
    const test = new InstagramDMSafari(browserType);

    try {
        console.log(`\n🌐 Starting Instagram DM Test with ${browserType.toUpperCase()} browser\n`);
        
        await test.initialize();
        console.log('✅ Browser initialized and logged in\n');

        // Test navigation to DMs
        const navSuccess = await test.testNavigateToDMs();
        if (!navSuccess) {
            console.log('❌ Navigation to DMs failed');
            return;
        }
        console.log('✅ Navigated to DMs\n');

        await delay(2000);

        // Test getting conversations
        await test.testGetConversations();
        console.log('');

        await delay(2000);

        // Open first conversation
        const opened = await test.openFirstConversation();
        if (opened) {
            console.log('✅ Opened first conversation\n');
            
            await delay(2000);
            
            // Read messages
            const messages = await test.readCurrentMessages();
            console.log(`\n📨 Found ${messages.length} messages\n`);
        }

        console.log('\n=== Test Complete ===\n');

    } catch (error) {
        console.error('❌ Error:', error);
        logger.error('Safari DM Test Error:', error);
    } finally {
        const keepOpen = process.env.DM_TEST_KEEP_OPEN === 'true';
        if (!keepOpen) {
            await test.close();
        } else {
            console.log('🔓 Browser kept open for inspection. Close manually when done.');
        }
    }
}

// Run if executed directly
if (require.main === module) {
    runSafariDMTest().catch(console.error);
}
