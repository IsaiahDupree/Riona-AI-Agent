import { Page, ElementHandle } from 'puppeteer';
import { logger } from '../utils/logger';
import { formatError } from '../utils/errors';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
// AdblockerPlugin removed — imported but never used (commented out at line 48)
import puppeteer from 'puppeteer-extra';
import dotenv from 'dotenv';
// OpenAI removed — AI generation handled by Instagram-Core via shared Anthropic wrapper
import * as path from 'path';
import * as fs from 'fs';
import { delay } from '../utils/delay';
import { startRun, pushStep, finishRun } from '../trace/runtime';
import { AccountModel } from '../hitl/models';
// InteractionHistory removed — imported but never used
import { saveTrace } from '../trace/store';
import { sendTraceEvent } from '../trace/webhook';

// Import core functionality
import {
    PostMetadata,
    InteractionResult,
    CommentMetadata,
    LikeMetadata,
    ErrorMetadata,
    generateComment,
    validateComment,
    postComment,
    likePost,
    processPostWithRetry,
    BotInteraction,
    MetadataType,
    initStorage,
    saveInteractionToDb,
    extractPostMetadata,
    hasAlreadyLiked,
    hasAlreadyCommented,
    getRandomDelay,
    ProcessPostResult,
    processPosts
} from './Instagram-Core';
import { createSession, saveSession, updateDailyStats, SessionLog, hasCommentedOnPost, trackComment, TrackedComment } from '../tracking/commentTracker';

// Import DM functionality
import {
    processDMs,
    initDMStorage,
    DMProcessResult
} from './InstagramDM';

// Load environment variables
dotenv.config({ override: true });

// Set up plugins
puppeteer.use(StealthPlugin());
// Disable or configure adblocker to work offline to prevent timeout errors
// puppeteer.use(AdblockerPlugin({ blockTrackers: true }));

// Configurable timeouts (default to 30s if not provided)
const LOGIN_TIMEOUT_MS: number = parseInt(process.env.INSTAGRAM_TIMEOUT_MS || '30000', 10);



// Create a default metadata object for error cases
const createDefaultMetadata = (error: string): PostMetadata => ({
    type: 'post',
    username: 'unknown',
    caption: '',
    isVideo: false,
    hashtags: [],
    timestamp: new Date(),
    likes: 0,
    success: false,
    error
});

async function handlePostProcessingResult(result: ProcessPostResult) {
    if (!result.success) {
        const errorMessage = result.error || 'Unknown error';
        logger.error('Post processing failed', {
            error: errorMessage,
            component: 'Instagram-AI',
            event: 'post_processing_failed'
        });

        // Save failed interaction
        await saveInteractionToDb({
            type: 'comment', // Use comment type for errors
            timestamp: new Date(),
            success: false,
            error: errorMessage,
            details: 'Post processing failed',
            metadata: result.metadata || createDefaultMetadata(errorMessage)
        });
    } else if (result.skipped) {
        logger.info('Post processing skipped', {
            component: 'Instagram-AI',
            event: 'post_skipped',
            metadata: result.metadata
        });
    } else if (result.metadata) {
        logger.info('Post processing successful', {
            component: 'Instagram-AI',
            event: 'post_processed',
            metadata: result.metadata
        });

        await saveInteractionToDb({
            type: result.metadata.type as 'comment' | 'like',
            timestamp: new Date(),
            success: true,
            details: 'Post processed successfully',
            metadata: result.metadata
        });
    }
}

async function processPost(post: ElementHandle<Element>, page: Page): Promise<ProcessPostResult> {
    try {
        logger.info('Processing post');

        const result = await processPostWithRetry(post, page);
        await handlePostProcessingResult(result);
        return result;
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error('Error in processPost:', {
            error: errorMessage,
            component: 'Instagram-AI',
            event: 'post_processing_error'
        });

        return {
            success: false,
            error: errorMessage,
            metadata: createDefaultMetadata(errorMessage),
            skipped: false
        };
    }
}

async function saveError(error: Error): Promise<void> {
    const interaction: BotInteraction = {
        timestamp: new Date(),
        type: 'comment', // Use comment type for errors
        success: false,
        error: error.message,
        details: error.stack,
        metadata: {
            type: 'comment',
            timestamp: new Date(),
            success: false,
            error: error.message
        }
    };

    await saveInteractionToDb(interaction);
}

async function handleError(error: Error): Promise<void> {
    logger.error('Instagram AI Error:', {
        error: error.message,
        stack: error.stack,
        timestamp: new Date().toISOString()
    });

    await saveError(error);
}

export class InstagramAI {
    private browser: any | null = null;
    private page: Page | null = null;
    private isLoggedIn: boolean = false;
    private lastBatchTime: Date | null = null;
    private readonly cookiesPath: string;
    private readonly chromeProfilePath: string;

    constructor(options?: { chromeProfile?: string }) {
        this.setupLogging();
        this.cookiesPath = path.join(process.cwd(), 'cookies.json');
        this.chromeProfilePath = options?.chromeProfile || process.env.INSTAGRAM_CHROME_PROFILE || './chrome-profile';
    }

    private setupLogging() {
        logger.info('Initializing InstagramAI', {
            component: 'Instagram-AI',
            event: 'init'
        });
    }

    protected async delay(ms: number): Promise<void> {
        await new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Dismiss Instagram dialogs like "Turn on Notifications", "Save Login Info", etc.
     * Finds buttons containing "Not Now" text within a dialog that contains the given heading text.
     */
    private async dismissDialog(headingText?: string): Promise<boolean> {
        if (!this.page) return false;
        try {
            // Strategy 1: Find "Not Now" button by evaluating text content
            const dismissed = await this.page.evaluate((heading: string | undefined) => {
                // If heading specified, check if dialog with that text exists
                if (heading) {
                    const hasDialog = document.body.innerText.includes(heading);
                    if (!hasDialog) return false;
                }

                // Find all buttons and look for "Not Now"
                const buttons = document.querySelectorAll('button');
                for (const btn of buttons) {
                    const text = btn.textContent?.trim();
                    if (text === 'Not Now' || text === 'Not now') {
                        btn.click();
                        return true;
                    }
                }

                // Also check div[role="button"] elements
                const roleBtns = document.querySelectorAll('div[role="button"]');
                for (const btn of roleBtns) {
                    const text = btn.textContent?.trim();
                    if (text === 'Not Now' || text === 'Not now') {
                        (btn as HTMLElement).click();
                        return true;
                    }
                }
                return false;
            }, headingText);

            if (dismissed) {
                logger.info(`Dismissed dialog: "${headingText || 'unknown'}"`, {
                    component: 'Instagram-AI',
                    event: 'dialog_dismissed'
                });
                await this.delay(1500);
                return true;
            }

            // Strategy 2: Try aria-label based selectors
            const notNowSelectors = [
                'button[aria-label="Not Now"]',
                'button[aria-label="Not now"]',
                '[role="button"][aria-label="Not Now"]'
            ];
            for (const sel of notNowSelectors) {
                const btn = await this.page.$(sel);
                if (btn) {
                    await btn.click();
                    logger.info(`Dismissed dialog via ${sel}`, { component: 'Instagram-AI', event: 'dialog_dismissed' });
                    await this.delay(1500);
                    return true;
                }
            }

            // Strategy 3: Instagram dialog button class selectors (notifications/login popups)
            const classBasedDismissed = await this.page.evaluate(() => {
                // Target the specific Instagram dialog button classes
                const dialogSelectors = [
                    'div._a9-z button._a9--._ap36._asz1',
                    'div[role="dialog"] button._a9--._ap36',
                    'div[role="dialog"] button:first-child'
                ];
                for (const sel of dialogSelectors) {
                    const btn = document.querySelector(sel) as HTMLElement;
                    if (btn) {
                        const text = btn.textContent?.trim()?.toLowerCase() || '';
                        // Only click if it looks like a dismiss button (Not Now, Cancel, etc.)
                        if (text === 'not now' || text === 'not now' || text === 'cancel' || text === 'close' || text.length < 20) {
                            btn.click();
                            return text || 'dialog-button';
                        }
                    }
                }
                return null;
            });

            if (classBasedDismissed) {
                logger.info(`Dismissed dialog via class selector: "${classBasedDismissed}"`, {
                    component: 'Instagram-AI',
                    event: 'dialog_dismissed_class'
                });
                await this.delay(1500);
                return true;
            }

            return false;
        } catch (error) {
            logger.debug(`No dialog to dismiss: ${headingText || 'unknown'}`);
            return false;
        }
    }

    async initialize(): Promise<void> {
        try {
            // Initialize browser with stealth mode and persistent profile
            this.browser = await puppeteer.launch({
                headless: false,  // Keep browser visible
                defaultViewport: null,  // Use default viewport
                executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
                userDataDir: this.chromeProfilePath,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-infobars',
                    '--disable-dev-shm-usage',
                    '--disable-gpu',
                    '--disable-notifications',
                    '--window-position=0,0',
                    '--ignore-certificate-errors',
                    '--ignore-certificate-errors-spki-list',
                    '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
                    '--start-maximized'  // Start with maximized window
                ]
            });

            // Use the default page from the profile (avoids blank tab)
            const pages = await this.browser.pages();
            this.page = pages[0] || await this.browser.newPage();
            // Apply default timeouts for this page/session
            const page = this.page;
            if (page) {
                page.setDefaultNavigationTimeout(LOGIN_TIMEOUT_MS);
                page.setDefaultTimeout(LOGIN_TIMEOUT_MS);
            }

            // Load cookies if they exist
            await this.loadCookies();

            logger.info('Browser initialized successfully');
        } catch (error) {
            logger.error('Error initializing browser:', error);
            throw error;
        }
    }

    private async loadCookies(): Promise<void> {
        if (!this.page) return;

        try {
            // With userDataDir, the browser may already have a valid session.
            // Navigate to Instagram and check if we're logged in.
            await this.page.goto('https://www.instagram.com/', { waitUntil: 'networkidle0', timeout: LOGIN_TIMEOUT_MS });
            await this.delay(2000);

            const loginButton = await this.page.$('button[type="submit"]') ||
                                await this.page.$('input[type="submit"]') ||
                                await this.page.$('input[name="email"]') ||
                                await this.page.$('input[name="username"]');

            if (loginButton) {
                logger.info('No active session in profile, logging in...');
                await this.login();
            } else {
                logger.info('Profile session is valid — already logged in');
                this.isLoggedIn = true;
                await this.dismissDialog('Turn on Notifications');
                await this.dismissDialog('Save Your Login Info');
            }
        } catch (error) {
            logger.error('Error checking session:', error);
            await this.login();
        }
    }

    private async login(): Promise<void> {
        if (!this.page) throw new Error('Page not initialized');

        try {
            const username = process.env.INSTAGRAM_BOT_USERNAME;
            const password = process.env.INSTAGRAM_BOT_PASSWORD;

            if (!username || !password) {
                throw new Error('Missing Instagram credentials');
            }

            logger.info('Logging in to Instagram...');
            await this.page.goto('https://www.instagram.com/accounts/login/', { waitUntil: 'networkidle0', timeout: LOGIN_TIMEOUT_MS });

            // Wait for and handle any cookie consent dialog
            try {
                const cookieDialog = await this.page.$('button[type="button"]');
                if (cookieDialog) {
                    await cookieDialog.click();
                    await this.delay(1000);
                }
            } catch (error) {
                logger.info('No cookie dialog found');
            }

            // Fill in login form (IG uses name="email" or name="username", and name="pass" or name="password")
            const usernameInput = await this.page.waitForSelector(
                'input[name="username"], input[name="email"]',
                { timeout: LOGIN_TIMEOUT_MS }
            );
            if (!usernameInput) throw new Error('Username input not found');
            await usernameInput.click();
            await this.delay(300);
            await usernameInput.type(username, { delay: 50 });

            const passwordInput = await this.page.$('input[name="password"]') ||
                                  await this.page.$('input[name="pass"]');
            if (!passwordInput) throw new Error('Password input not found');
            await passwordInput.click();
            await this.delay(300);
            await passwordInput.type(password, { delay: 50 });

            await this.delay(500);

            // Submit: try visible button first, then evaluate click on input, then Enter key
            const submitButton = await this.page.$('button[type="submit"]');
            if (submitButton) {
                await submitButton.click();
            } else {
                // Use evaluate to click hidden input[type="submit"] or just press Enter
                const clicked = await this.page.evaluate(() => {
                    const submit = document.querySelector('input[type="submit"]') as HTMLInputElement;
                    if (submit) { submit.click(); return true; }
                    const form = document.querySelector('form');
                    if (form) { form.submit(); return true; }
                    return false;
                });
                if (!clicked) {
                    await this.page.keyboard.press('Enter');
                }
            }

            // Wait for navigation
            await this.page.waitForNavigation({ waitUntil: 'networkidle0', timeout: LOGIN_TIMEOUT_MS });

            // Check for successful login
            const loginError = await this.page.$('p[role="alert"]');
            if (loginError) {
                const errorText = await this.page.evaluate(el => el.textContent, loginError);
                throw new Error(`Login failed: ${errorText}`);
            }

            // Handle 2FA / verification challenges
            const pageText = await this.page.evaluate(() => document.body?.innerText || '');
            const isVerificationPage = pageText.includes('confirm it') || pageText.includes('Confirm') ||
                pageText.includes('verification') || pageText.includes('security code') ||
                pageText.includes('Check your text') || pageText.includes('Enter the code') ||
                pageText.includes('two-factor') || pageText.includes('Choose a way');

            if (isVerificationPage) {
                logger.info('Verification challenge detected: ' + pageText.slice(0, 100));

                // If "Choose a way to confirm" page, click Continue to trigger SMS
                const hasChoosePage = pageText.includes('Choose a way') || pageText.includes('confirm it');
                if (hasChoosePage) {
                    const allButtons = await this.page.$$('button, div[role="button"]');
                    for (const btn of allButtons) {
                        const btnText = await btn.evaluate(el => el.textContent?.trim() || '');
                        if (btnText.toLowerCase().includes('continue') || btnText.toLowerCase().includes('send')) {
                            await btn.click();
                            logger.info(`Clicked "${btnText}" to trigger verification code`);
                            await this.delay(3000);
                            break;
                        }
                    }
                }

                // Now wait for user to complete verification (SMS code, phone approval, etc.)
                // The browser window is visible — user can type the code manually
                logger.info('[login] Waiting for user to complete verification in browser window (up to 120s)...');
                const verificationTimeout = 120000;
                const startTime = Date.now();
                let verified = false;
                while (Date.now() - startTime < verificationTimeout) {
                    await this.delay(5000);
                    const currentUrl = this.page.url();
                    const currentText = await this.page.evaluate(() => document.body?.innerText || '');
                    // Check if we've moved past the verification page
                    const stillOnVerification = currentText.includes('confirm it') ||
                        currentText.includes('security code') || currentText.includes('Check your text') ||
                        currentText.includes('Enter the code') || currentText.includes('Choose a way') ||
                        currentUrl.includes('challenge');
                    const stillOnLogin = currentUrl.includes('/accounts/login');
                    if (!stillOnVerification && !stillOnLogin) {
                        verified = true;
                        break;
                    }
                    const elapsed = Math.round((Date.now() - startTime) / 1000);
                    logger.info(`[login] Still waiting for verification... (${elapsed}s) URL: ${currentUrl.slice(0, 60)}`);
                }

                if (!verified) {
                    throw new Error('Verification challenge timed out — enter the code in the browser window and retry');
                }
                logger.info('Verification completed successfully');
            }

            // Session is persisted via Chrome profile (userDataDir)
            logger.info('Login successful, session saved in profile');
            this.isLoggedIn = true;

            // Handle "Save Login Info" dialog if it appears
            await this.dismissDialog('Save Your Login Info');

            // Handle notifications dialog if it appears
            await this.dismissDialog('Turn on Notifications');

        } catch (error) {
            logger.error('Login failed:', error);
            throw error;
        }
    }

    async processHomeFeed(trace?: any): Promise<void> {
        try {
            if (!this.page) {
                throw new Error('Page not initialized');
            }

            logger.info('Processing home feed', {
                component: 'Instagram-AI',
                event: 'home_feed_start'
            });

            // Navigate to home feed
            await this.page.goto('https://www.instagram.com/', { waitUntil: 'networkidle0', timeout: LOGIN_TIMEOUT_MS });
            logger.info('Successfully navigated to home feed');

            // Wait for posts to load
            await this.page.waitForSelector('article', { timeout: LOGIN_TIMEOUT_MS });

            // Get all posts
            let posts = await this.page.$$('article');
            if (!posts.length) {
                logger.info('No posts found on first try, waiting longer');
                await this.delay(5000);
                posts = await this.page.$$('article');
            }

            logger.info(`Found ${posts.length} posts`, {
                component: 'Instagram-AI',
                event: 'posts_found',
                count: posts.length
            });

            if (posts.length === 0) {
                logger.warn('No posts found in home feed', {
                    component: 'Instagram-AI',
                    event: 'no_posts'
                });
                return;
            }

            // Process posts with trace so artifacts and steps get recorded
            await processPosts(posts, this.page, trace);

            this.lastBatchTime = new Date();
            logger.info('Finished processing home feed', {
                component: 'Instagram-AI',
                event: 'home_feed_complete',
                timestamp: this.lastBatchTime
            });

        } catch (error) {
            logger.error('Error processing home feed:', {
                error: error instanceof Error ? error.message : String(error),
                component: 'Instagram-AI',
                event: 'home_feed_error'
            });
            throw error;
        }
    }

    async processDMs(options: { autoRespond?: boolean; maxConversations?: number; trace?: any } = {}): Promise<DMProcessResult | null> {
        try {
            if (!this.page) {
                throw new Error('Page not initialized');
            }

            logger.info('Processing DMs', {
                component: 'Instagram-AI',
                event: 'dm_processing_start',
                autoRespond: options.autoRespond
            });

            const result = await processDMs(this.page, {
                maxConversations: options.maxConversations || 5,
                autoRespond: options.autoRespond || false,
                onlyUnread: true,
                trace: options.trace
            });

            logger.info('DM processing completed', {
                component: 'Instagram-AI',
                event: 'dm_processing_complete',
                conversationsProcessed: result.conversationsProcessed,
                messagesSent: result.messagesSent
            });

            return result;
        } catch (error) {
            logger.error('Error processing DMs:', {
                error: error instanceof Error ? error.message : String(error),
                component: 'Instagram-AI',
                event: 'dm_processing_error'
            });
            return null;
        }
    }

    async processHashtagFeed(hashtag: string): Promise<void> {
        try {
            if (!this.page) {
                throw new Error('Page not initialized');
            }

            logger.info(`Processing hashtag feed: #${hashtag}`, {
                component: 'Instagram-AI',
                event: 'hashtag_feed_start',
                hashtag
            });

            // Navigate to hashtag page
            await this.page.goto(`https://www.instagram.com/explore/tags/${hashtag}/`, { waitUntil: 'networkidle0', timeout: LOGIN_TIMEOUT_MS });

            // Wait for posts to load
            await this.page.waitForSelector('article', { timeout: LOGIN_TIMEOUT_MS });

            // Get all posts
            const posts = await this.page.$$('article');
            logger.info(`Found ${posts.length} posts in hashtag feed`, {
                component: 'Instagram-AI',
                event: 'hashtag_posts_found',
                count: posts.length,
                hashtag
            });

            if (posts.length === 0) {
                logger.warn('No posts found in hashtag feed', {
                    component: 'Instagram-AI',
                    event: 'no_hashtag_posts',
                    hashtag
                });
                return;
            }

            // Process posts
            await processPosts(posts, this.page);

            this.lastBatchTime = new Date();
            logger.info(`Finished processing hashtag feed #${hashtag}`, {
                component: 'Instagram-AI',
                event: 'hashtag_feed_complete',
                hashtag,
                timestamp: this.lastBatchTime
            });

        } catch (error) {
            logger.error(`Error processing hashtag feed #${hashtag}:`, {
                error: error instanceof Error ? error.message : String(error),
                component: 'Instagram-AI',
                event: 'hashtag_feed_error',
                hashtag
            });
            throw error;
        }
    }

    async close(): Promise<void> {
        try {
            if (this.browser) {
                await this.browser.close();
                this.browser = null;
                this.page = null;
                this.isLoggedIn = false;
                logger.info('Browser closed successfully', {
                    component: 'Instagram-AI',
                    event: 'browser_close'
                });
            }
        } catch (error) {
            logger.error('Error closing browser:', {
                error: error instanceof Error ? error.message : String(error),
                component: 'Instagram-AI',
                event: 'browser_close_error'
            });
            throw error;
        }
    }

    // Expose the underlying Puppeteer page for targeted actions
    public getPage(): Page | null {
        return this.page;
    }

    // Get a fresh page from the browser (recovers from detached frame)
    public async getFreshPage(): Promise<Page | null> {
        try {
            // Try to reuse existing browser pages first
            if (this.browser) {
                try {
                    const pages = await this.browser.pages();
                    if (pages.length > 0) {
                        // Use the first available page
                        const existingPage = pages[0] as Page;
                        this.page = existingPage;
                        await existingPage.bringToFront();
                        return existingPage;
                    }
                } catch (e) { logger.debug('[niche] Failed to reuse existing page: ' + formatError(e)); }

                // No usable pages — create a new one
                try {
                    const newPage = await this.browser.newPage();
                    this.page = newPage;
                    await newPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36');
                    const fsMod = await import('fs');
                    const cookiePath = './cookies.json';
                    if (fsMod.existsSync(cookiePath)) {
                        const cookies = JSON.parse(fsMod.readFileSync(cookiePath, 'utf-8'));
                        await newPage.setCookie(...cookies);
                    }
                    return newPage;
                } catch (e) { logger.debug('[niche] Failed to create new page: ' + formatError(e)); }
            }

            // Browser connection is dead — relaunch entirely
            logger.info('[niche] Browser died, relaunching...');
            await this.initialize();
            return this.page;
        } catch (e) {
            logger.error(`[niche] Failed to get fresh page: ${e}`);
            return null;
        }
    }
}

/**
 * Dismiss any Instagram popup dialogs (notifications, save login, etc.)
 * Uses multiple strategies: text matching, aria-labels, and Instagram's dialog CSS classes.
 */
async function dismissPopups(page: any, logPrefix: string = ''): Promise<boolean> {
    try {
        const result = await page.evaluate(() => {
            // Strategy 1: Text-based "Not Now" button detection
            const buttons = document.querySelectorAll('button');
            for (const btn of buttons) {
                const text = btn.textContent?.trim();
                if (text === 'Not Now' || text === 'Not now') {
                    btn.click();
                    return 'Not Now (text)';
                }
            }

            // Strategy 2: div[role="button"] with "Not Now"
            const roleBtns = document.querySelectorAll('div[role="button"]');
            for (const btn of roleBtns) {
                const text = btn.textContent?.trim();
                if (text === 'Not Now' || text === 'Not now') {
                    (btn as HTMLElement).click();
                    return 'Not Now (role-button)';
                }
            }

            // Strategy 3: Instagram dialog class-based selectors
            // These catch popups where button text might not be "Not Now"
            const dialogSelectors = [
                'div._a9-z button._a9--._ap36._asz1',
                'div[role="dialog"] button._a9--._ap36',
            ];
            for (const sel of dialogSelectors) {
                const btn = document.querySelector(sel) as HTMLElement;
                if (btn) {
                    const text = btn.textContent?.trim() || '';
                    btn.click();
                    return `dialog-class: "${text}" via ${sel}`;
                }
            }

            // Strategy 4: Generic dialog first-button (dismiss/cancel is typically first)
            const dialog = document.querySelector('div[role="dialog"]');
            if (dialog) {
                const dialogBtns = dialog.querySelectorAll('button');
                for (const btn of dialogBtns) {
                    const text = btn.textContent?.trim()?.toLowerCase() || '';
                    if (text === 'not now' || text === 'cancel' || text === 'close' || text === 'dismiss') {
                        btn.click();
                        return `dialog-generic: "${text}"`;
                    }
                }
            }

            return null;
        });

        if (result) {
            logger.info(`${logPrefix} Dismissed popup: ${result}`, {
                component: 'Instagram-AI',
                event: 'popup_dismissed'
            });
            await new Promise(r => setTimeout(r, 1500));
            return true;
        }
        return false;
    } catch {
        return false;
    }
}

// Single-batch run: open browser, comment on posts, close browser, exit
// Designed to be called by a scheduler that spins this up periodically
export async function runSingleBatch(username: string, trace?: any, keepOpen?: boolean): Promise<{ commentsPosted: number; session: SessionLog; instagramAI?: InstagramAI }> {
    const instagramAI = new InstagramAI();
    const session = createSession();
    let commentsPosted = 0;

    try {
        // Initialize Supabase storage (non-blocking)
        try { await initStorage(); } catch (e) {
            logger.warn('Storage init failed in runSingleBatch — continuing without persistent storage');
        }

        if (trace) pushStep(trace, { name: 'init_browser', status: 'ok' });
        await instagramAI.initialize();

        const postsPerRun = parseInt(process.env.POSTS_PER_RUN || '10', 10);
        logger.info(`Single batch run: targeting ${postsPerRun} posts`);

        if (trace) pushStep(trace, { name: 'process_batch', status: 'ok' });

        if (!instagramAI.getPage()) throw new Error('Page not initialized');
        const page = instagramAI.getPage()!;

        // Navigate to home feed
        await page.goto('https://www.instagram.com/', { waitUntil: 'networkidle0', timeout: 30000 });
        await new Promise(r => setTimeout(r, 5000));

        // Dismiss any popups (notifications, save login, etc.)
        await dismissPopups(page, '[batch]');

        // Process posts in multiple iterations, refreshing the page each time
        // to discover new content that hasn't been commented on
        const REFRESH_ITERATIONS = 3;
        const POSTS_PER_ITERATION = 10;

        for (let iteration = 0; iteration < REFRESH_ITERATIONS; iteration++) {
            logger.info(`[batch] ── Iteration ${iteration + 1}/${REFRESH_ITERATIONS} ──`);

            if (iteration > 0) {
                // Refresh the page to load fresh content
                logger.info(`[batch] Refreshing page to discover new content...`);
                await page.goto('https://www.instagram.com/', { waitUntil: 'networkidle0', timeout: 30000 });
                await new Promise(r => setTimeout(r, 5000));

                // Dismiss any popups after refresh
                await dismissPopups(page, '[batch]');
                await new Promise(r => setTimeout(r, 1500));
            }

            // Find posts - scroll down to pre-load more articles
            await page.waitForSelector('article', { timeout: 15000 }).catch(() => {});
            let posts = await page.$$('article');

            // Scroll to load at least POSTS_PER_ITERATION posts
            let scrollRounds = 0;
            while (posts.length < POSTS_PER_ITERATION && scrollRounds < 8) {
                await page.evaluate(() => window.scrollBy(0, 1200));
                await new Promise(r => setTimeout(r, 2000));
                posts = await page.$$('article');
                scrollRounds++;
            }
            // Scroll back to top so we process from the beginning
            await page.evaluate(() => window.scrollTo(0, 0));
            await new Promise(r => setTimeout(r, 1500));
            posts = await page.$$('article');

            logger.info(`[batch] Iteration ${iteration + 1}: found ${posts.length} posts (after ${scrollRounds} scroll rounds)`);

            if (posts.length > 0) {
                // Process posts with session tracking — persistent tracker handles cross-iteration dedup
                await processPosts(posts, page, trace, session);
            }

            // If we've hit the daily target or run out of content, stop early
            if (session.commentsPosted >= postsPerRun) {
                logger.info(`[batch] Reached target of ${postsPerRun} comments, stopping iterations`);
                break;
            }
        }

        // Use session tracker for accurate count
        commentsPosted = session.commentsPosted;

        // Also check trace steps as backup
        if (commentsPosted === 0 && trace && trace.steps) {
            commentsPosted = trace.steps.filter((s: any) => s.name === 'comment_posted').length;
        }

        logger.info(`Batch complete: ${commentsPosted} comments posted, ${session.commentsVerified} verified, ${session.postsSkippedDuplicate} duplicates skipped`);
    } catch (error: any) {
        if (trace) pushStep(trace, { name: 'batch_error', status: 'error', notes: error?.message });
        session.errors.push(error?.message || 'Unknown error');
        logger.error('Error in single batch run:', error);
    } finally {
        // Save session report and update daily stats
        saveSession(session);
        updateDailyStats(session);

        if (!keepOpen) {
            if (trace) pushStep(trace, { name: 'close_browser', status: 'ok' });
            await instagramAI.close();
        }
    }

    return { commentsPosted, session, instagramAI: keepOpen ? instagramAI : undefined };
}

/**
 * Niche-specific batch: navigate to hashtag pages, collect post URLs from the grid,
 * then visit each post individually to comment on it.
 *
 * @param niche - hashtag or keyword (e.g. "artificialintelligence", "fitness")
 * @param targetPosts - how many posts to collect and process (default 150)
 */
export async function runNicheBatch(
    niche: string,
    targetPosts: number = 150,
    trace?: any,
    keepOpen?: boolean,
): Promise<{ commentsPosted: number; session: SessionLog; instagramAI?: InstagramAI }> {
    const instagramAI = new InstagramAI();
    const session = createSession();
    let commentsPosted = 0;

    // Clean the niche: remove # prefix, spaces → no spaces for hashtag URL
    const hashtag = niche.replace(/^#/, '').replace(/\s+/g, '').toLowerCase();

    try {
        // Initialize Supabase storage (non-blocking)
        try { await initStorage(); } catch (e) {
            logger.warn('Storage init failed in runNicheBatch — continuing without persistent storage');
        }

        await instagramAI.initialize();
        if (!instagramAI.getPage()) throw new Error('Page not initialized');
        let page = instagramAI.getPage()!;

        logger.info(`[niche] Starting niche batch for #${hashtag}, target: ${targetPosts} posts`, {
            component: 'Instagram-AI',
            event: 'niche_batch_start',
            hashtag,
            targetPosts
        });

        // Navigate to hashtag explore page
        const hashtagUrl = `https://www.instagram.com/explore/tags/${hashtag}/`;
        await page.goto(hashtagUrl, { waitUntil: 'networkidle0', timeout: 30000 });
        await new Promise(r => setTimeout(r, 4000));

        // Dismiss popups
        await dismissPopups(page, '[niche]');

        // ── Phase 1: Collect post URLs from the grid ──
        logger.info(`[niche] Collecting post URLs from #${hashtag} grid...`);

        let postUrls: string[] = [];
        let scrollAttempts = 0;
        const maxScrollAttempts = 50; // Safety cap
        let noNewPostsCount = 0;

        while (postUrls.length < targetPosts && scrollAttempts < maxScrollAttempts) {
            // Extract all post links from the grid
            const urls: string[] = await page.evaluate(() => {
                const links = document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]');
                const hrefs: string[] = [];
                for (const link of links) {
                    const href = link.getAttribute('href');
                    if (href && (href.startsWith('/p/') || href.startsWith('/reel/'))) {
                        hrefs.push(`https://www.instagram.com${href}`);
                    }
                }
                return [...new Set(hrefs)];
            });

            const prevCount = postUrls.length;
            // Merge with existing, dedup
            const urlSet = new Set(postUrls);
            for (const url of urls) {
                urlSet.add(url);
            }
            postUrls = [...urlSet];

            if (postUrls.length === prevCount) {
                noNewPostsCount++;
                if (noNewPostsCount >= 5) {
                    logger.info(`[niche] No new posts after ${noNewPostsCount} scrolls, stopping collection at ${postUrls.length} posts`);
                    break;
                }
            } else {
                noNewPostsCount = 0;
            }

            logger.info(`[niche] Scroll ${scrollAttempts + 1}: ${postUrls.length}/${targetPosts} posts collected`);

            // Scroll down to load more grid items
            await page.evaluate(() => window.scrollBy(0, 1500));
            await new Promise(r => setTimeout(r, 2000 + Math.random() * 1500));

            // Dismiss popups during scroll
            await dismissPopups(page, '[niche]');

            scrollAttempts++;
        }

        logger.info(`[niche] Collection complete: ${postUrls.length} unique post URLs from #${hashtag}`, {
            component: 'Instagram-AI',
            event: 'niche_collection_complete',
            hashtag,
            postCount: postUrls.length,
            scrollAttempts
        });

        if (postUrls.length === 0) {
            logger.warn(`[niche] No posts found for #${hashtag}`);
            return { commentsPosted: 0, session };
        }

        // ── Phase 2: Visit each post, extract caption via page.evaluate, like, comment ──
        // We do NOT use processPostWithRetry() here because individual post pages
        // don't have <article> and ElementHandles go stale after like clicks.
        // Instead, we use page-level evaluate/$ calls for each step independently.
        const processedPermalinks = new Set<string>();

        for (let i = 0; i < postUrls.length; i++) {
            const postUrl = postUrls[i];

            try {
                // Duplicate check: persistent tracker
                if (hasCommentedOnPost(postUrl)) {
                    logger.info(`[niche] SKIP (already commented) ${postUrl}`);
                    session.postsSkippedDuplicate++;
                    session.postsProcessed++;
                    continue;
                }

                // In-batch duplicate check
                if (processedPermalinks.has(postUrl)) {
                    session.postsSkippedDuplicate++;
                    session.postsProcessed++;
                    continue;
                }
                processedPermalinks.add(postUrl);

                logger.info(`[niche] Processing post ${i + 1}/${postUrls.length}: ${postUrl}`);

                // Navigate to individual post
                await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
                await new Promise(r => setTimeout(r, 2000 + Math.random() * 2000));

                // Dismiss popups on post page
                await dismissPopups(page, '[niche]');

                // ── Step 1: Extract metadata via page.evaluate (no ElementHandle needed) ──
                const meta = await page.evaluate(() => {
                    const reserved = ['', 'p', 'reel', 'reels', 'stories', 'explore', 'accounts', 'direct', 'tags'];

                    // Strategy 1: Extract from post header — look inside <main> or <article> to avoid nav bar links
                    let username = 'unknown';
                    const contentArea = document.querySelector('main') || document.querySelector('article') || document.body;

                    // On individual post pages, the author's profile link appears in the post header
                    // Look for links that contain a profile-style href inside the content area
                    const contentLinks = [...contentArea.querySelectorAll('a[href]')];

                    // First, try to find header-style username links (usually near the top of the post)
                    // These typically have the username as visible text AND as the href
                    for (const a of contentLinks) {
                        const href = a.getAttribute('href') || '';
                        const match = href.match(/^\/([a-zA-Z0-9._]+)\/?$/);
                        if (match && !reserved.includes(match[1].toLowerCase())) {
                            // Prefer links where the text matches the href username (header links)
                            const linkText = (a.textContent || '').trim().toLowerCase();
                            if (linkText === match[1].toLowerCase()) {
                                username = match[1];
                                break;
                            }
                        }
                    }

                    // Fallback: if no text-matching link found, use the first valid profile link in content
                    if (username === 'unknown') {
                        for (const a of contentLinks) {
                            const href = a.getAttribute('href') || '';
                            const match = href.match(/^\/([a-zA-Z0-9._]+)\/?$/);
                            if (match && !reserved.includes(match[1].toLowerCase())) {
                                username = match[1];
                                break;
                            }
                        }
                    }

                    // Caption: look for span[dir="auto"] with substantial text
                    const uiTexts = ['notifications', 'dashboard', 'also from meta', 'start the conversation', 'consumer health', 'log in', 'sign up'];
                    let caption = '';
                    const spans = document.querySelectorAll('span[dir="auto"]');
                    for (const span of spans) {
                        const text = (span.textContent || '').trim();
                        if (text.length > 20 && text.length < 3000) {
                            const lower = text.toLowerCase();
                            if (!uiTexts.some(u => lower.startsWith(u))) {
                                caption = text;
                                break;
                            }
                        }
                    }

                    const hasLikeBtn = Boolean(document.querySelector('svg[aria-label="Like"]'));
                    const alreadyLiked = Boolean(document.querySelector('svg[aria-label="Unlike"]'));

                    return { username, caption, hasLikeBtn, alreadyLiked };
                });

                session.postsProcessed++;

                // Skip own posts
                const botUsername = (process.env.INSTAGRAM_BOT_USERNAME || '').toLowerCase().replace(/\//g, '');
                if (botUsername && meta.username.toLowerCase().replace(/\//g, '') === botUsername) {
                    logger.info(`[niche] SKIP (own post) @${meta.username} ${postUrl}`);
                    session.postsSkippedOther++;
                    continue;
                }

                if (!meta.caption) {
                    logger.warn(`[niche] No caption found on ${postUrl}, skipping comment`);
                    session.postsSkippedOther++;
                    continue;
                }

                logger.info(`[niche] @${meta.username}: "${meta.caption.slice(0, 80)}..."`);

                // ── Step 2: Like the post ──
                if (meta.hasLikeBtn && !meta.alreadyLiked) {
                    const liked = await page.evaluate(() => {
                        const svg = document.querySelector('svg[aria-label="Like"]');
                        if (svg) {
                            const btn = svg.closest('button') || svg.closest('div[role="button"]') || svg.parentElement;
                            if (btn) { (btn as HTMLElement).click(); return true; }
                        }
                        return false;
                    });
                    if (liked) {
                        await new Promise(r => setTimeout(r, 1500));
                        logger.info(`[niche] Liked post`);
                    }
                }

                // ── Step 3: Generate comment via GPT ──
                const comment = await generateComment(meta.caption);
                if (!comment) {
                    logger.warn(`[niche] Failed to generate comment for ${postUrl}`);
                    session.commentsFailed++;
                    continue;
                }
                logger.info(`[niche] Generated: "${comment}"`);

                // ── Step 4: Post the comment ──
                // Use the existing postComment() which handles all textarea/contenteditable
                // variants, comment icon clicks, modal detection, and submission methods.
                // We pass a fresh <main> handle — postComment searches at page level first.
                const freshContainer = await page.$('main');
                if (!freshContainer) {
                    logger.warn(`[niche] No main element for comment on ${postUrl}`);
                    session.commentsFailed++;
                    continue;
                }

                const commentResult = await postComment(freshContainer, page, comment);
                if (!commentResult.success) {
                    logger.warn(`[niche] Comment failed on ${postUrl}: ${commentResult.error}`);
                    session.commentsFailed++;
                    session.errors.push(commentResult.error || `Comment failed on ${postUrl}`);
                    continue;
                }

                // ── Step 5: Verify comment was posted ──
                // postComment already waits and verifies internally
                const verified = commentResult.metadata?.commentVerified ?? true;

                const tracked: TrackedComment = {
                    postUrl,
                    postUsername: meta.username,
                    commentText: comment,
                    timestamp: new Date().toISOString(),
                    verified,
                    sessionId: session.sessionId,
                    captionSnippet: meta.caption.slice(0, 100),
                    liked: true
                };
                trackComment(tracked);
                session.commentsPosted++;
                if (verified) session.commentsVerified++;
                session.likesPosted++;
                session.comments.push(tracked);
                commentsPosted++;

                logger.info(`[niche] ✓ Comment ${commentsPosted} on ${postUrl} (@${meta.username}) verified=${verified}`);

                // Human-like delay between posts
                await new Promise(r => setTimeout(r, getRandomDelay(4000, 8000)));

            } catch (error) {
                const errMsg = error instanceof Error ? error.message : String(error);
                logger.error(`[niche] Error on post ${postUrl}: ${errMsg}`);
                session.errors.push(errMsg);
                session.commentsFailed++;

                // Recover from detached frame by getting a fresh page
                if (errMsg.includes('detached Frame') || errMsg.includes('Session closed') || errMsg.includes('Target closed')) {
                    logger.info(`[niche] Frame detached — recovering with fresh page...`);
                    const freshPage = await instagramAI.getFreshPage();
                    if (freshPage) {
                        page = freshPage;
                        logger.info(`[niche] Fresh page acquired, continuing...`);
                    } else {
                        logger.error(`[niche] Failed to recover, stopping batch`);
                        break;
                    }
                }
            }

            // Progress log every 10 posts
            if ((i + 1) % 10 === 0) {
                logger.info(`[niche] Progress: ${i + 1}/${postUrls.length} visited, ${commentsPosted} comments posted, ${session.postsSkippedDuplicate} skipped`);
            }
        }

        logger.info(`[niche] Batch complete for #${hashtag}: ${commentsPosted} comments on ${postUrls.length} posts`, {
            component: 'Instagram-AI',
            event: 'niche_batch_complete',
            hashtag,
            commentsPosted,
            postsProcessed: session.postsProcessed,
            duplicatesSkipped: session.postsSkippedDuplicate,
            failed: session.commentsFailed
        });

    } catch (error: any) {
        session.errors.push(error?.message || 'Unknown error');
        logger.error(`[niche] Fatal error in niche batch for #${hashtag}:`, error);
    } finally {
        saveSession(session);
        updateDailyStats(session);

        if (!keepOpen) {
            await instagramAI.close();
        }
    }

    return { commentsPosted, session, instagramAI: keepOpen ? instagramAI : undefined };
}

// Legacy loop mode (kept for backwards compatibility)
export async function startInteractionLoop(username: string, trace?: any): Promise<void> {
    const result = await runSingleBatch(username, trace);
    logger.info(`Interaction loop completed with ${result.commentsPosted} comments`);
}

export async function runInstagram(externalTrace?: any): Promise<void> {
    const trace = externalTrace ?? startRun({
        action: 'instagram_automation',
        cookieFile: './cookies.json',
        target: { username: process.env.INSTAGRAM_BOT_USERNAME }
    });

    try {
        await saveTrace(trace);
        await sendTraceEvent('run.updated', trace);

        const username = process.env.INSTAGRAM_BOT_USERNAME;
        const password = process.env.INSTAGRAM_BOT_PASSWORD;

        if (!username || !password) {
            throw new Error('Missing Instagram credentials');
        }

        if (!username.match(/^[a-zA-Z0-9._]+$/)) {
            throw new Error('Invalid username format');
        }

        pushStep(trace, { name: 'validate_credentials', status: 'ok', ms: 0 });
        logger.info('Starting Instagram automation');

        // Initialize Storage (non-blocking - agent can run without DB)
        pushStep(trace, { name: 'init_storage', status: 'ok' });
        try {
            await initStorage();
        } catch (storageError) {
            logger.warn('Storage initialization failed - continuing without persistent storage', {
                error: storageError instanceof Error ? storageError.message : String(storageError)
            });
        }

        // Initialize DM Storage
        pushStep(trace, { name: 'init_dm_storage', status: 'ok' });
        await initDMStorage();

        pushStep(trace, { name: 'start_automation_loop', status: 'ok' });
        await startInteractionLoop(username, trace);

        finishRun(trace, true);
        logger.info('Instagram automation completed');
    } catch (error: any) {
        trace.error = { message: error?.message || 'Unknown error', stack: error?.stack };
        finishRun(trace, false);
        logger.error('Error in Instagram automation:', error);
    } finally {
        await saveTrace(trace);
        await sendTraceEvent('run.completed', trace);
    }
}