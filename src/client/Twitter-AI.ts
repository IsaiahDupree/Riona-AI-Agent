import { Page, Browser, ElementHandle } from 'puppeteer';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { logger } from '../utils/logger';
import { formatError, sanitizeForPrompt } from '../utils/errors';
import { delay } from '../utils/delay';
import * as path from 'path';
import * as fs from 'fs';
import dotenv from 'dotenv';
import OpenAI from 'openai';
import {
    extractTweetMetadata, generateReply, validateReply,
    postReply, likeTweet, hasAlreadyReplied, hasAlreadyLiked,
    extractTweetUrl, processTweets, TweetMetadata,
    postTweet, quoteTweet, postThread, followUser, unfollowUser, bookmarkTweet,
    PostTweetOptions, PostTweetResult, ThreadTweet
} from './Twitter-Core';
import {
    hasRepliedToTweet, trackReply, getTodayReplyCount,
    createSession, saveSession, updateDailyStats,
    SessionLog, TrackedReply
} from '../tracking/twitterTracker';
import { hasSentTwitterDMTo } from '../tracking/twitterDMTracker';
import { safeReadJSON, safeWriteJSON } from '../utils/errors';
import { startRun, pushStep, finishRun } from '../trace/runtime';
import { saveTrace } from '../trace/store';

// Load environment variables
dotenv.config();

// Set up plugins
puppeteer.use(StealthPlugin());

// Configurable timeouts
const TWITTER_TIMEOUT_MS: number = parseInt(process.env.TWITTER_TIMEOUT_MS || '30000', 10);
const TWITTER_POSTS_PER_RUN: number = parseInt(process.env.TWITTER_POSTS_PER_RUN || '10', 10);
const TWITTER_SKIP_RETWEETS: boolean = (process.env.TWITTER_SKIP_RETWEETS || 'true').toLowerCase() === 'true';

// Twitter cookies file path
const TWITTER_COOKIES_PATH = path.join(process.cwd(), 'twitter-cookies.json');

// ── Utility helpers ──────────────────────────────────────────────────

function getRandomDelay(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Dismiss Twitter popup dialogs (notifications prompt, cookie consent, etc.)
 * Handles: "Turn on notifications", "Don't miss what's happening", cookie banners.
 */
async function dismissPopups(page: Page, logPrefix: string = ''): Promise<boolean> {
    try {
        const result = await page.evaluate(() => {
            // Strategy 1: "Not now" / "Maybe later" / dismiss text-based buttons
            const dismissTexts = [
                'not now', 'maybe later', 'dismiss', 'close', 'no thanks',
                'skip for now', 'decline', "don't allow", 'x'
            ];
            const buttons = document.querySelectorAll('button, [role="button"], a[role="button"]');
            for (const btn of buttons) {
                const text = (btn.textContent || '').trim().toLowerCase();
                if (dismissTexts.includes(text)) {
                    (btn as HTMLElement).click();
                    return `text-match: "${text}"`;
                }
            }

            // Strategy 2: Twitter-specific notification prompt dismiss
            // The "Turn on notifications" dialog has a close (X) button
            const layers = document.querySelectorAll('[data-testid="sheetDialog"], [role="dialog"]');
            for (const layer of layers) {
                const layerText = (layer.textContent || '').toLowerCase();
                if (layerText.includes('turn on notifications') || layerText.includes("don't miss what's happening")) {
                    // Find the close/dismiss button inside
                    const closeBtn = layer.querySelector('[data-testid="app-bar-close"]') ||
                        layer.querySelector('[aria-label="Close"]') ||
                        layer.querySelector('button');
                    if (closeBtn) {
                        (closeBtn as HTMLElement).click();
                        return 'notification-dialog-dismissed';
                    }
                }
            }

            // Strategy 3: Bottom banner / cookie consent
            const bannerBtns = document.querySelectorAll('[data-testid="BottomBar"] button, [id="layers"] button');
            for (const btn of bannerBtns) {
                const text = (btn.textContent || '').trim().toLowerCase();
                if (text.includes('refuse') || text.includes('not now') || text.includes('decline') || text === 'x') {
                    (btn as HTMLElement).click();
                    return `banner-dismiss: "${text}"`;
                }
            }

            // Strategy 4: Generic close button on overlays
            const closeSelectors = [
                '[data-testid="app-bar-close"]',
                '[aria-label="Close"]',
                '[data-testid="xMigrationBottomBar"] button'
            ];
            for (const sel of closeSelectors) {
                const el = document.querySelector(sel) as HTMLElement;
                if (el) {
                    el.click();
                    return `selector-close: ${sel}`;
                }
            }

            return null;
        });

        if (result) {
            logger.info(`${logPrefix} Dismissed Twitter popup: ${result}`, {
                component: 'Twitter-AI',
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

// ── TwitterAI Class ──────────────────────────────────────────────────

export class TwitterAI {
    private browser: Browser | null = null;
    private page: Page | null = null;
    private isLoggedIn: boolean = false;
    private lastBatchTime: Date | null = null;
    private readonly cookiesPath: string;

    constructor() {
        this.setupLogging();
        this.cookiesPath = TWITTER_COOKIES_PATH;
    }

    private setupLogging() {
        logger.info('Initializing TwitterAI', {
            component: 'Twitter-AI',
            event: 'init'
        });
    }

    async initialize(): Promise<void> {
        try {
            this.browser = await puppeteer.launch({
                headless: false,
                defaultViewport: null,
                executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
                userDataDir: process.env.TWITTER_CHROME_PROFILE || './chrome-profile-twitter',
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
                    '--start-maximized'
                ]
            });

            const pages = await this.browser.pages();
            this.page = pages[0] || await this.browser.newPage();
            if (this.page) {
                this.page.setDefaultNavigationTimeout(TWITTER_TIMEOUT_MS);
                this.page.setDefaultTimeout(TWITTER_TIMEOUT_MS);
            }

            // Load cookies if they exist
            await this.loadCookies();

            logger.info('Twitter browser initialized successfully', {
                component: 'Twitter-AI',
                event: 'browser_initialized'
            });
        } catch (error) {
            logger.error('Error initializing Twitter browser:', error);
            throw error;
        }
    }

    private async loadCookies(): Promise<void> {
        if (!this.page) return;

        try {
            // With userDataDir, the browser may already have a valid session.
            // Navigate to home and check if we're logged in.
            await this.page.goto('https://x.com/home', { waitUntil: 'networkidle2', timeout: TWITTER_TIMEOUT_MS });
            await delay(2000);

            const currentUrl = this.page.url();
            if (!currentUrl.includes('/login') && !currentUrl.includes('/i/flow/login')) {
                logger.info('Twitter session valid (via browser profile)');
                this.isLoggedIn = true;
                await dismissPopups(this.page, '[init]');
                return;
            }

            // If we have a cookies JSON file, try loading those
            if (fs.existsSync(this.cookiesPath)) {
                const cookiesString = fs.readFileSync(this.cookiesPath, 'utf8');
                const cookies = JSON.parse(cookiesString);
                await this.page.setCookie(...cookies);
                logger.info('Twitter cookies loaded from file');

                await this.page.goto('https://x.com/home', { waitUntil: 'networkidle2', timeout: TWITTER_TIMEOUT_MS });
                const urlAfterCookies = this.page.url();
                if (!urlAfterCookies.includes('/login') && !urlAfterCookies.includes('/i/flow/login')) {
                    logger.info('Twitter cookies are valid');
                    this.isLoggedIn = true;
                    await delay(2000);
                    await dismissPopups(this.page, '[init]');
                    return;
                }
                logger.info('Twitter cookies expired, logging in again');
            } else {
                logger.info('No Twitter cookies found, performing fresh login');
            }

            await this.login();
        } catch (error) {
            logger.error('Error loading Twitter cookies:', error);
            await this.login();
        }
    }

    private async login(): Promise<void> {
        if (!this.page) throw new Error('Page not initialized');

        try {
            const username = process.env.TWITTER_BOT_USERNAME;
            const password = process.env.TWITTER_BOT_PASSWORD;

            if (!username || !password) {
                throw new Error('Missing Twitter credentials (TWITTER_BOT_USERNAME, TWITTER_BOT_PASSWORD)');
            }

            logger.info('Logging in to Twitter/X...');
            await this.page.goto('https://x.com/i/flow/login', { waitUntil: 'networkidle2', timeout: TWITTER_TIMEOUT_MS });

            // Wait for username input
            await this.page.waitForSelector('input[autocomplete="username"], input[name="text"]', { timeout: TWITTER_TIMEOUT_MS });
            await delay(1000);

            // Type username
            const usernameInput = await this.page.$('input[autocomplete="username"]') || await this.page.$('input[name="text"]');
            if (!usernameInput) throw new Error('Username input not found');
            await usernameInput.type(username, { delay: 50 });

            // Click "Next" button
            const nextButton = await this.page.evaluateHandle(() => {
                const buttons = document.querySelectorAll('button, [role="button"]');
                for (const btn of buttons) {
                    const text = (btn.textContent || '').trim().toLowerCase();
                    if (text === 'next') return btn;
                }
                return null;
            });
            if (nextButton) {
                await (nextButton as ElementHandle<Element>).click();
                await delay(2000);
            }

            // Handle potential "unusual login activity" — phone/email verification
            const verificationInput = await this.page.$('input[data-testid="ocfEnterTextTextInput"]');
            if (verificationInput) {
                const verificationValue = process.env.TWITTER_BOT_EMAIL || process.env.TWITTER_BOT_PHONE || '';
                if (verificationValue) {
                    await verificationInput.type(verificationValue, { delay: 50 });
                    const verifyNext = await this.page.evaluateHandle(() => {
                        const buttons = document.querySelectorAll('[data-testid="ocfEnterTextNextButton"], button');
                        for (const btn of buttons) {
                            const text = (btn.textContent || '').trim().toLowerCase();
                            if (text === 'next' || (btn as Element).getAttribute('data-testid') === 'ocfEnterTextNextButton') return btn;
                        }
                        return null;
                    });
                    if (verifyNext) {
                        await (verifyNext as ElementHandle<Element>).click();
                        await delay(2000);
                    }
                } else {
                    logger.warn('Verification step detected but no TWITTER_BOT_EMAIL or TWITTER_BOT_PHONE set');
                }
            }

            // Wait for password input and fill it
            await this.page.waitForSelector('input[name="password"], input[type="password"]', { timeout: TWITTER_TIMEOUT_MS });
            const passwordInput = await this.page.$('input[name="password"]') || await this.page.$('input[type="password"]');
            if (!passwordInput) throw new Error('Password input not found');
            await passwordInput.type(password, { delay: 50 });

            // Click "Log in" button
            const loginButton = await this.page.$('[data-testid="LoginForm_Login_Button"]');
            if (loginButton) {
                await loginButton.click();
            } else {
                // Fallback: find button with "Log in" text
                await this.page.evaluate(() => {
                    const buttons = document.querySelectorAll('button, [role="button"]');
                    for (const btn of buttons) {
                        const text = (btn.textContent || '').trim().toLowerCase();
                        if (text === 'log in') {
                            (btn as HTMLElement).click();
                            return;
                        }
                    }
                });
            }

            // Wait for navigation to home
            await this.page.waitForNavigation({ waitUntil: 'networkidle2', timeout: TWITTER_TIMEOUT_MS }).catch(() => {
                // Navigation may not trigger if already on home
            });
            await delay(3000);

            // Check for successful login by looking for home timeline indicators
            const currentUrl = this.page.url();
            if (currentUrl.includes('/login') || currentUrl.includes('/i/flow/login')) {
                // Check for error messages
                const errorEl = await this.page.$('[data-testid="inline_error"], [role="alert"]');
                if (errorEl) {
                    const errorText = await this.page.evaluate(el => el.textContent, errorEl);
                    throw new Error(`Twitter login failed: ${errorText}`);
                }
                throw new Error('Twitter login failed: still on login page after submission');
            }

            // Save cookies
            const cookies = await this.page.cookies();
            fs.writeFileSync(this.cookiesPath, JSON.stringify(cookies));
            logger.info('Twitter login successful, cookies saved');
            this.isLoggedIn = true;

            // Dismiss popups after login
            await delay(2000);
            await dismissPopups(this.page, '[login]');

        } catch (error) {
            logger.error('Twitter login failed:', error);
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
                logger.info('Twitter browser closed successfully', {
                    component: 'Twitter-AI',
                    event: 'browser_close'
                });
            }
        } catch (error) {
            logger.error('Error closing Twitter browser:', {
                error: error instanceof Error ? error.message : String(error),
                component: 'Twitter-AI',
                event: 'browser_close_error'
            });
            throw error;
        }
    }

    getPage(): Page | null {
        return this.page;
    }

    getBrowser(): Browser | null {
        return this.browser;
    }

    /**
     * Get a fresh page from the browser (recovers from detached frame).
     */
    async getFreshPage(): Promise<Page | null> {
        try {
            if (this.browser) {
                try {
                    const pages = await this.browser.pages();
                    if (pages.length > 0) {
                        const existingPage = pages[0] as Page;
                        this.page = existingPage;
                        await existingPage.bringToFront();
                        return existingPage;
                    }
                } catch (e) {
                    logger.debug('[twitter] Failed to reuse existing page: ' + formatError(e));
                }

                // No usable pages — create a new one
                try {
                    const newPage = await this.browser.newPage();
                    this.page = newPage;
                    await newPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36');
                    if (fs.existsSync(this.cookiesPath)) {
                        const cookies = JSON.parse(fs.readFileSync(this.cookiesPath, 'utf-8'));
                        await newPage.setCookie(...cookies);
                    }
                    return newPage;
                } catch (e) {
                    logger.debug('[twitter] Failed to create new page: ' + formatError(e));
                }
            }

            // Browser connection is dead — relaunch entirely
            logger.info('[twitter] Browser died, relaunching...');
            await this.initialize();
            return this.page;
        } catch (e) {
            logger.error(`[twitter] Failed to get fresh page: ${e}`);
            return null;
        }
    }
}

// ── runTwitterBatch ──────────────────────────────────────────────────

/**
 * Single-batch run for Twitter home feed: open browser, find tweets,
 * generate AI replies, post replies, like tweets, close browser.
 * Designed to be called by a scheduler that spins this up periodically.
 */
export async function runTwitterBatch(
    username: string,
    postsPerRun: number = TWITTER_POSTS_PER_RUN,
    trace?: any
): Promise<{ commentsPosted: number; session: SessionLog; twitterAI?: TwitterAI }> {
    const twitterAI = new TwitterAI();
    const session = createSession();
    let commentsPosted = 0;
    let keepOpen = false;

    try {
        if (trace) pushStep(trace, { name: 'twitter_init_browser', status: 'ok' });
        await twitterAI.initialize();

        logger.info(`[twitter-batch] Starting batch run: targeting ${postsPerRun} tweets`);

        if (!twitterAI.getPage()) throw new Error('Page not initialized');
        const page = twitterAI.getPage()!;

        // Navigate to home feed
        if (trace) pushStep(trace, { name: 'twitter_navigate_home', status: 'ok' });
        await page.goto('https://x.com/home', { waitUntil: 'networkidle2', timeout: TWITTER_TIMEOUT_MS });
        await delay(5000);

        // Dismiss any popups (notifications, etc.)
        await dismissPopups(page, '[batch]');

        // Process tweets in multiple iterations, refreshing the page each time
        const REFRESH_ITERATIONS = 3;
        const TWEETS_PER_ITERATION = Math.ceil(postsPerRun / REFRESH_ITERATIONS);

        for (let iteration = 0; iteration < REFRESH_ITERATIONS; iteration++) {
            logger.info(`[twitter-batch] -- Iteration ${iteration + 1}/${REFRESH_ITERATIONS} --`);

            if (iteration > 0) {
                // Refresh the page to load fresh content
                logger.info(`[twitter-batch] Refreshing page to discover new tweets...`);
                await page.goto('https://x.com/home', { waitUntil: 'networkidle2', timeout: TWITTER_TIMEOUT_MS });
                await delay(5000);

                // Dismiss any popups after refresh
                await dismissPopups(page, '[batch]');
                await delay(1500);
            }

            // Wait for tweets to load
            await page.waitForSelector('article[data-testid="tweet"]', { timeout: 15000 }).catch(() => {
                logger.warn('[twitter-batch] No tweets found on page');
            });

            // Scroll down to pre-load more tweets
            let tweets = await page.$$('article[data-testid="tweet"]');
            let scrollRounds = 0;
            while (tweets.length < TWEETS_PER_ITERATION && scrollRounds < 8) {
                await page.evaluate(() => window.scrollBy(0, 1200));
                await delay(2000);
                tweets = await page.$$('article[data-testid="tweet"]');
                scrollRounds++;
            }

            // Scroll back to top so we process from the beginning
            await page.evaluate(() => window.scrollTo(0, 0));
            await delay(1500);
            tweets = await page.$$('article[data-testid="tweet"]');

            logger.info(`[twitter-batch] Iteration ${iteration + 1}: found ${tweets.length} tweets (after ${scrollRounds} scroll rounds)`);

            if (tweets.length === 0) continue;

            // Process each tweet
            for (const tweet of tweets) {
                try {
                    // Extract tweet URL for dedup
                    const tweetUrl = await extractTweetUrl(tweet);
                    if (!tweetUrl) {
                        logger.debug('[twitter-batch] Could not extract tweet URL, skipping');
                        continue;
                    }

                    // Check if we've already replied (persistent tracker)
                    if (hasRepliedToTweet(tweetUrl)) {
                        logger.info(`[twitter-batch] SKIP (already replied) ${tweetUrl}`);
                        session.tweetsSkippedDuplicate++;
                        session.tweetsProcessed++;
                        continue;
                    }

                    // Extract tweet metadata
                    const metadata = await extractTweetMetadata(tweet, page);
                    if (!metadata) {
                        logger.warn('[twitter-batch] Could not extract tweet metadata, skipping');
                        session.tweetsSkippedOther++;
                        session.tweetsProcessed++;
                        continue;
                    }

                    session.tweetsProcessed++;

                    // Skip retweets if configured
                    if (TWITTER_SKIP_RETWEETS && metadata.isRetweet) {
                        logger.info(`[twitter-batch] SKIP (retweet) @${metadata.username}`);
                        session.tweetsSkippedOther++;
                        continue;
                    }

                    // Skip own tweets
                    const botUsername = (process.env.TWITTER_BOT_USERNAME || '').toLowerCase().replace(/@/g, '');
                    if (botUsername && metadata.username.toLowerCase().replace(/@/g, '') === botUsername) {
                        logger.info(`[twitter-batch] SKIP (own tweet) @${metadata.username}`);
                        session.tweetsSkippedOther++;
                        continue;
                    }

                    // Check if already replied in DOM
                    const alreadyReplied = await hasAlreadyReplied(tweet, page, botUsername);
                    if (alreadyReplied) {
                        logger.info(`[twitter-batch] SKIP (already replied in DOM) ${tweetUrl}`);
                        session.tweetsSkippedDuplicate++;
                        continue;
                    }

                    if (!metadata.text) {
                        logger.warn(`[twitter-batch] No tweet text found for ${tweetUrl}, skipping`);
                        session.tweetsSkippedOther++;
                        continue;
                    }

                    // ── Content filter — language, topic, risk, blocked accounts ──
                    const { filterTweet } = await import('../filters/twitter-content-filter');
                    const filterResult = filterTweet(metadata.text, metadata.username, metadata.displayName);
                    if (!filterResult.allowed) {
                        logger.info(`[twitter-batch] SKIP (filter: ${filterResult.gate}) @${metadata.username}: ${filterResult.reason}`);
                        session.tweetsSkippedOther++;
                        continue;
                    }

                    logger.info(`[twitter-batch] @${metadata.username}: "${metadata.text.slice(0, 80)}..."`);

                    // Like the tweet (if not already liked)
                    const alreadyLiked = await hasAlreadyLiked(tweet, page);
                    if (!alreadyLiked) {
                        const liked = await likeTweet(tweet, page);
                        if (liked) {
                            await delay(1500);
                            logger.info(`[twitter-batch] Liked tweet`);
                            session.likesPosted++;
                        }
                    }

                    // Generate AI reply
                    const reply = await generateReply(metadata.text, metadata.username);
                    if (!reply) {
                        logger.warn(`[twitter-batch] Failed to generate reply for ${tweetUrl}`);
                        session.repliesFailed++;
                        continue;
                    }

                    // Validate reply
                    const validationResult = validateReply(reply);
                    if (!validationResult.valid) {
                        logger.warn(`[twitter-batch] Reply validation failed: ${validationResult.reason}`);
                        session.repliesFailed++;
                        continue;
                    }

                    logger.info(`[twitter-batch] Generated reply: "${reply}"`);

                    // Post reply
                    const replyResult = await postReply(tweet, page, reply);
                    if (!replyResult.success) {
                        logger.warn(`[twitter-batch] Reply failed on ${tweetUrl}: ${replyResult.error}`);
                        session.repliesFailed++;
                        session.errors.push(replyResult.error || `Reply failed on ${tweetUrl}`);
                        continue;
                    }

                    // Track the reply
                    const tracked: TrackedReply = {
                        tweetUrl,
                        tweetAuthor: metadata.username,
                        replyText: reply,
                        timestamp: new Date().toISOString(),
                        verified: replyResult.success ?? true,
                        sessionId: session.sessionId,
                        tweetSnippet: metadata.text.slice(0, 100),
                        liked: !alreadyLiked,
                        retweeted: false
                    };
                    trackReply(tracked);
                    session.repliesPosted++;
                    if (tracked.verified) session.repliesVerified++;
                    session.replies.push(tracked);
                    commentsPosted++;

                    if (trace) pushStep(trace, { name: 'reply_posted', status: 'ok', notes: `@${metadata.username} ${tweetUrl}` });

                    logger.info(`[twitter-batch] Reply ${commentsPosted} on ${tweetUrl} (@${metadata.username}) verified=${tracked.verified}`);

                    // Human-like delay between tweets
                    await delay(getRandomDelay(4000, 8000));

                    // Check if we've hit the target
                    if (commentsPosted >= postsPerRun) {
                        logger.info(`[twitter-batch] Reached target of ${postsPerRun} replies, stopping`);
                        break;
                    }

                } catch (error) {
                    const errMsg = error instanceof Error ? error.message : String(error);
                    logger.error(`[twitter-batch] Error processing tweet: ${errMsg}`);
                    session.errors.push(errMsg);
                    session.repliesFailed++;
                }
            }

            // If we've hit the target, stop iterations
            if (commentsPosted >= postsPerRun) {
                logger.info(`[twitter-batch] Reached target of ${postsPerRun} replies, stopping iterations`);
                break;
            }
        }

        logger.info(`[twitter-batch] Batch complete: ${commentsPosted} replies posted, ${session.repliesVerified} verified, ${session.tweetsSkippedDuplicate} duplicates skipped`);
        keepOpen = true;
    } catch (error: any) {
        if (trace) pushStep(trace, { name: 'twitter_batch_error', status: 'error', notes: error?.message });
        session.errors.push(error?.message || 'Unknown error');
        logger.error('[twitter-batch] Error in batch run:', error);
    } finally {
        if (!keepOpen) {
            if (trace) pushStep(trace, { name: 'twitter_close_browser', status: 'ok' });
            await twitterAI.close();
        }

        // Save session report and update daily stats
        saveSession(session);
        updateDailyStats(session);
    }

    // Return twitterAI so caller can reuse the browser for content posting before closing
    return { commentsPosted, session, twitterAI: keepOpen ? twitterAI : undefined };
}

// ── runTwitterNicheBatch ─────────────────────────────────────────────

/**
 * Niche/search-specific batch: navigate to Twitter search results,
 * collect tweets, then process each one (reply + like).
 *
 * @param searchTerm - keyword or phrase to search for
 * @param postsPerRun - how many tweets to process (default from env)
 */
export async function runTwitterNicheBatch(
    searchTerm: string,
    postsPerRun: number = TWITTER_POSTS_PER_RUN,
    trace?: any
): Promise<{ commentsPosted: number; session: SessionLog; twitterAI?: TwitterAI }> {
    const twitterAI = new TwitterAI();
    const session = createSession();
    let commentsPosted = 0;
    let keepOpen = false;

    try {
        await twitterAI.initialize();
        if (!twitterAI.getPage()) throw new Error('Page not initialized');
        let page = twitterAI.getPage()!;

        logger.info(`[twitter-niche] Starting niche batch for "${searchTerm}", target: ${postsPerRun} tweets`, {
            component: 'Twitter-AI',
            event: 'niche_batch_start',
            searchTerm,
            postsPerRun
        });

        // Navigate to search results (Top tab)
        const searchUrl = `https://x.com/search?q=${encodeURIComponent(searchTerm)}&src=typed_query&f=top`;
        await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: TWITTER_TIMEOUT_MS });
        await delay(4000);

        // Dismiss popups
        await dismissPopups(page, '[niche]');

        // ── Phase 1: Collect tweet URLs from search results ──
        logger.info(`[twitter-niche] Collecting tweet URLs for "${searchTerm}"...`);

        let tweetUrls: string[] = [];
        let scrollAttempts = 0;
        const maxScrollAttempts = 50;
        let noNewTweetsCount = 0;

        while (tweetUrls.length < postsPerRun && scrollAttempts < maxScrollAttempts) {
            // Extract tweet links from search results
            const urls: string[] = await page.evaluate(() => {
                const tweetArticles = document.querySelectorAll('article[data-testid="tweet"]');
                const hrefs: string[] = [];
                for (const article of tweetArticles) {
                    // Find the tweet permalink: look for a time element's parent link
                    const timeEl = article.querySelector('time');
                    if (timeEl) {
                        const link = timeEl.closest('a');
                        if (link) {
                            const href = link.getAttribute('href');
                            if (href && href.match(/\/[^/]+\/status\/\d+/)) {
                                hrefs.push(`https://x.com${href}`);
                            }
                        }
                    }
                }
                return [...new Set(hrefs)];
            });

            const prevCount = tweetUrls.length;
            const urlSet = new Set(tweetUrls);
            for (const url of urls) {
                urlSet.add(url);
            }
            tweetUrls = [...urlSet];

            if (tweetUrls.length === prevCount) {
                noNewTweetsCount++;
                if (noNewTweetsCount >= 5) {
                    logger.info(`[twitter-niche] No new tweets after ${noNewTweetsCount} scrolls, stopping collection at ${tweetUrls.length} tweets`);
                    break;
                }
            } else {
                noNewTweetsCount = 0;
            }

            logger.info(`[twitter-niche] Scroll ${scrollAttempts + 1}: ${tweetUrls.length}/${postsPerRun} tweets collected`);

            // Scroll down to load more results
            await page.evaluate(() => window.scrollBy(0, 1500));
            await delay(2000 + Math.random() * 1500);

            // Dismiss popups during scroll
            await dismissPopups(page, '[niche]');

            scrollAttempts++;
        }

        logger.info(`[twitter-niche] Collection complete: ${tweetUrls.length} unique tweet URLs for "${searchTerm}"`, {
            component: 'Twitter-AI',
            event: 'niche_collection_complete',
            searchTerm,
            tweetCount: tweetUrls.length,
            scrollAttempts
        });

        if (tweetUrls.length === 0) {
            logger.warn(`[twitter-niche] No tweets found for "${searchTerm}"`);
            return { commentsPosted: 0, session };
        }

        // ── Phase 2: Visit each tweet, extract text, reply, like ──
        const processedUrls = new Set<string>();

        for (let i = 0; i < tweetUrls.length; i++) {
            const tweetUrl = tweetUrls[i];

            try {
                // Persistent tracker duplicate check
                if (hasRepliedToTweet(tweetUrl)) {
                    logger.info(`[twitter-niche] SKIP (already replied) ${tweetUrl}`);
                    session.tweetsSkippedDuplicate++;
                    session.tweetsProcessed++;
                    continue;
                }

                // In-batch duplicate check
                if (processedUrls.has(tweetUrl)) {
                    session.tweetsSkippedDuplicate++;
                    session.tweetsProcessed++;
                    continue;
                }
                processedUrls.add(tweetUrl);

                logger.info(`[twitter-niche] Processing tweet ${i + 1}/${tweetUrls.length}: ${tweetUrl}`);

                // Navigate to individual tweet
                await page.goto(tweetUrl, { waitUntil: 'domcontentloaded', timeout: TWITTER_TIMEOUT_MS });
                await delay(2000 + Math.random() * 2000);

                // Dismiss popups on tweet page
                await dismissPopups(page, '[niche]');

                // Wait for the tweet article to load
                await page.waitForSelector('article[data-testid="tweet"]', { timeout: 10000 }).catch(() => {});

                // ── Step 1: Extract tweet metadata via page.evaluate ──
                const meta = await page.evaluate(() => {
                    const article = document.querySelector('article[data-testid="tweet"]');
                    if (!article) return null;

                    // Extract username from the tweet
                    let username = 'unknown';
                    const userLink = article.querySelector('a[href*="/"]');
                    if (userLink) {
                        const href = userLink.getAttribute('href') || '';
                        const match = href.match(/^\/([a-zA-Z0-9_]+)\/?$/);
                        if (match) username = match[1];
                    }

                    // Fallback: look for [data-testid="User-Name"] span
                    if (username === 'unknown') {
                        const userNameEl = article.querySelector('[data-testid="User-Name"]');
                        if (userNameEl) {
                            const handleMatch = (userNameEl.textContent || '').match(/@([a-zA-Z0-9_]+)/);
                            if (handleMatch) username = handleMatch[1];
                        }
                    }

                    // Extract tweet text
                    const tweetTextEl = article.querySelector('[data-testid="tweetText"]');
                    const text = tweetTextEl ? (tweetTextEl.textContent || '').trim() : '';

                    // Check if it's a retweet
                    const isRetweet = Boolean(article.querySelector('[data-testid="socialContext"]'));

                    // Check like state
                    const likeBtn = article.querySelector('[data-testid="like"]');
                    const unlikeBtn = article.querySelector('[data-testid="unlike"]');
                    const alreadyLiked = Boolean(unlikeBtn);
                    const hasLikeBtn = Boolean(likeBtn);

                    return { username, text, isRetweet, alreadyLiked, hasLikeBtn };
                });

                if (!meta) {
                    logger.warn(`[twitter-niche] Could not extract metadata for ${tweetUrl}`);
                    session.tweetsSkippedOther++;
                    session.tweetsProcessed++;
                    continue;
                }

                session.tweetsProcessed++;

                // Skip retweets if configured
                if (TWITTER_SKIP_RETWEETS && meta.isRetweet) {
                    logger.info(`[twitter-niche] SKIP (retweet) @${meta.username}`);
                    session.tweetsSkippedOther++;
                    continue;
                }

                // Skip own tweets
                const botUsername = (process.env.TWITTER_BOT_USERNAME || '').toLowerCase().replace(/@/g, '');
                if (botUsername && meta.username.toLowerCase().replace(/@/g, '') === botUsername) {
                    logger.info(`[twitter-niche] SKIP (own tweet) @${meta.username}`);
                    session.tweetsSkippedOther++;
                    continue;
                }

                if (!meta.text) {
                    logger.warn(`[twitter-niche] No tweet text found on ${tweetUrl}, skipping`);
                    session.tweetsSkippedOther++;
                    continue;
                }

                // ── Content filter — language, topic, risk, blocked accounts ──
                const { filterTweet } = await import('../filters/twitter-content-filter');
                const filterResult = filterTweet(meta.text, meta.username);
                if (!filterResult.allowed) {
                    logger.info(`[twitter-niche] SKIP (filter: ${filterResult.gate}) @${meta.username}: ${filterResult.reason}`);
                    session.tweetsSkippedOther++;
                    continue;
                }

                logger.info(`[twitter-niche] @${meta.username}: "${meta.text.slice(0, 80)}..."`);

                // ── Step 2: Like the tweet ──
                if (meta.hasLikeBtn && !meta.alreadyLiked) {
                    const liked = await page.evaluate(() => {
                        const likeBtn = document.querySelector('article[data-testid="tweet"] [data-testid="like"]') as HTMLElement;
                        if (likeBtn) {
                            likeBtn.click();
                            return true;
                        }
                        return false;
                    });
                    if (liked) {
                        await delay(1500);
                        logger.info(`[twitter-niche] Liked tweet`);
                        session.likesPosted++;
                    }
                }

                // ── Step 3: Generate reply via AI ──
                const reply = await generateReply(meta.text, meta.username);
                if (!reply) {
                    logger.warn(`[twitter-niche] Failed to generate reply for ${tweetUrl}`);
                    session.repliesFailed++;
                    continue;
                }

                // Validate reply
                const validationResult = validateReply(reply);
                if (!validationResult.valid) {
                    logger.warn(`[twitter-niche] Reply validation failed: ${validationResult.reason}`);
                    session.repliesFailed++;
                    continue;
                }

                logger.info(`[twitter-niche] Generated reply: "${reply}"`);

                // ── Step 4: Post the reply ──
                // On individual tweet pages, click the reply input and type
                const tweetArticle = await page.$('article[data-testid="tweet"]');
                if (!tweetArticle) {
                    logger.warn(`[twitter-niche] No tweet article found for reply on ${tweetUrl}`);
                    session.repliesFailed++;
                    continue;
                }

                const replyResult = await postReply(tweetArticle, page, reply);
                if (!replyResult.success) {
                    logger.warn(`[twitter-niche] Reply failed on ${tweetUrl}: ${replyResult.error}`);
                    session.repliesFailed++;
                    session.errors.push(replyResult.error || `Reply failed on ${tweetUrl}`);
                    continue;
                }

                // ── Step 5: Track the reply ──
                const tracked: TrackedReply = {
                    tweetUrl,
                    tweetAuthor: meta.username,
                    replyText: reply,
                    timestamp: new Date().toISOString(),
                    verified: replyResult.success ?? true,
                    sessionId: session.sessionId,
                    tweetSnippet: meta.text.slice(0, 100),
                    liked: !meta.alreadyLiked,
                    retweeted: false
                };
                trackReply(tracked);
                session.repliesPosted++;
                if (tracked.verified) session.repliesVerified++;
                session.replies.push(tracked);
                commentsPosted++;

                if (trace) pushStep(trace, { name: 'reply_posted', status: 'ok', notes: `@${meta.username} ${tweetUrl}` });

                logger.info(`[twitter-niche] Reply ${commentsPosted} on ${tweetUrl} (@${meta.username}) verified=${tracked.verified}`);

                // Human-like delay between tweets
                await delay(getRandomDelay(4000, 8000));

            } catch (error) {
                const errMsg = error instanceof Error ? error.message : String(error);
                logger.error(`[twitter-niche] Error on tweet ${tweetUrl}: ${errMsg}`);
                session.errors.push(errMsg);
                session.repliesFailed++;

                // Recover from detached frame by getting a fresh page
                if (errMsg.includes('detached Frame') || errMsg.includes('Session closed') || errMsg.includes('Target closed')) {
                    logger.info(`[twitter-niche] Frame detached - recovering with fresh page...`);
                    const freshPage = await twitterAI.getFreshPage();
                    if (freshPage) {
                        page = freshPage;
                        logger.info(`[twitter-niche] Fresh page acquired, continuing...`);
                    } else {
                        logger.error(`[twitter-niche] Failed to recover, stopping batch`);
                        break;
                    }
                }
            }

            // Progress log every 10 tweets
            if ((i + 1) % 10 === 0) {
                logger.info(`[twitter-niche] Progress: ${i + 1}/${tweetUrls.length} visited, ${commentsPosted} replies posted, ${session.tweetsSkippedDuplicate} skipped`);
            }
        }

        logger.info(`[twitter-niche] Batch complete for "${searchTerm}": ${commentsPosted} replies on ${tweetUrls.length} tweets`, {
            component: 'Twitter-AI',
            event: 'niche_batch_complete',
            searchTerm,
            commentsPosted,
            postsProcessed: session.tweetsProcessed,
            duplicatesSkipped: session.tweetsSkippedDuplicate,
            failed: session.repliesFailed
        });

        keepOpen = true;
    } catch (error: any) {
        session.errors.push(error?.message || 'Unknown error');
        logger.error(`[twitter-niche] Fatal error in niche batch for "${searchTerm}":`, error);
    } finally {
        if (!keepOpen) {
            await twitterAI.close();
        }
        saveSession(session);
        updateDailyStats(session);
    }

    return { commentsPosted, session, twitterAI: keepOpen ? twitterAI : undefined };
}

// ── Multi-Niche Blitz ────────────────────────────────────────────────

/**
 * Rapidly reply across multiple niches in a single browser session.
 * Reuses one browser instance, navigating search → collect → reply for each niche.
 *
 * @param niches - Array of search terms / niches to target
 * @param repliesPerNiche - How many replies per niche (default 1)
 * @param options.delayBetweenReplies - ms between replies (default 3000-5000)
 * @param options.delayBetweenNiches - ms between niche switches (default 2000)
 * @param options.maxScrollsPerNiche - max scroll attempts to collect tweets (default 3)
 */
export async function runMultiNicheBlitz(
    niches: string[],
    repliesPerNiche: number = 1,
    options: {
        delayBetweenReplies?: [number, number];
        delayBetweenNiches?: number;
        maxScrollsPerNiche?: number;
    } = {}
): Promise<{
    totalReplies: number;
    perNiche: Record<string, number>;
    session: SessionLog;
    durationSec: number;
    twitterAI?: TwitterAI;
}> {
    const {
        delayBetweenReplies = [3000, 5000],
        delayBetweenNiches = 2000,
        maxScrollsPerNiche = 3,
    } = options;

    const startTime = Date.now();
    const twitterAI = new TwitterAI();
    const session = createSession();
    const perNiche: Record<string, number> = {};
    let totalReplies = 0;
    let keepOpen = false;

    try {
        await twitterAI.initialize();
        if (!twitterAI.getPage()) throw new Error('Page not initialized');
        let page = twitterAI.getPage()!;

        const botUsername = (process.env.TWITTER_BOT_USERNAME || '').toLowerCase().replace(/@/g, '');

        logger.info(`[multi-niche] Starting blitz: ${niches.length} niches x ${repliesPerNiche} replies = ${niches.length * repliesPerNiche} target`);

        for (let ni = 0; ni < niches.length; ni++) {
            const niche = niches[ni];
            perNiche[niche] = 0;

            logger.info(`[multi-niche] ── Niche ${ni + 1}/${niches.length}: "${niche}" ──`);

            try {
                // Navigate to search
                const searchUrl = `https://x.com/search?q=${encodeURIComponent(niche)}&src=typed_query&f=top`;
                await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: TWITTER_TIMEOUT_MS });
                await delay(3000);
                await dismissPopups(page, '[multi-niche]');

                // Collect tweet URLs (minimal scrolling for speed)
                let tweetUrls: string[] = [];
                for (let scroll = 0; scroll < maxScrollsPerNiche; scroll++) {
                    const urls: string[] = await page.evaluate(() => {
                        const articles = document.querySelectorAll('article[data-testid="tweet"]');
                        const hrefs: string[] = [];
                        for (const article of articles) {
                            const timeEl = article.querySelector('time');
                            if (timeEl) {
                                const link = timeEl.closest('a');
                                if (link) {
                                    const href = link.getAttribute('href');
                                    if (href && href.match(/\/[^/]+\/status\/\d+/)) {
                                        hrefs.push(`https://x.com${href}`);
                                    }
                                }
                            }
                        }
                        return [...new Set(hrefs)];
                    });

                    const urlSet = new Set(tweetUrls);
                    for (const u of urls) urlSet.add(u);
                    tweetUrls = [...urlSet];

                    if (tweetUrls.length >= repliesPerNiche * 2) break; // 2x buffer for skips

                    await page.evaluate(() => window.scrollBy(0, 1200));
                    await delay(1500);
                }

                logger.info(`[multi-niche] Collected ${tweetUrls.length} tweets for "${niche}"`);

                if (tweetUrls.length === 0) {
                    logger.warn(`[multi-niche] No tweets found for "${niche}", skipping`);
                    continue;
                }

                // Process tweets until we hit repliesPerNiche
                let nicheReplies = 0;

                for (const tweetUrl of tweetUrls) {
                    if (nicheReplies >= repliesPerNiche) break;

                    try {
                        // Dedup check
                        if (hasRepliedToTweet(tweetUrl)) {
                            session.tweetsSkippedDuplicate++;
                            continue;
                        }

                        // Navigate to tweet
                        await page.goto(tweetUrl, { waitUntil: 'domcontentloaded', timeout: TWITTER_TIMEOUT_MS });
                        await delay(2000);
                        await dismissPopups(page, '[multi-niche]');

                        await page.waitForSelector('article[data-testid="tweet"]', { timeout: 8000 }).catch(() => {});

                        // Extract metadata
                        const meta = await page.evaluate(() => {
                            const article = document.querySelector('article[data-testid="tweet"]');
                            if (!article) return null;

                            let username = 'unknown';
                            const userNameEl = article.querySelector('[data-testid="User-Name"]');
                            if (userNameEl) {
                                const handleMatch = (userNameEl.textContent || '').match(/@([a-zA-Z0-9_]+)/);
                                if (handleMatch) username = handleMatch[1];
                            }
                            if (username === 'unknown') {
                                const userLink = article.querySelector('a[href*="/"]');
                                if (userLink) {
                                    const href = userLink.getAttribute('href') || '';
                                    const match = href.match(/^\/([a-zA-Z0-9_]+)\/?$/);
                                    if (match) username = match[1];
                                }
                            }

                            const tweetTextEl = article.querySelector('[data-testid="tweetText"]');
                            const text = tweetTextEl ? (tweetTextEl.textContent || '').trim() : '';
                            const isRetweet = Boolean(article.querySelector('[data-testid="socialContext"]'));
                            const likeBtn = article.querySelector('[data-testid="like"]');
                            const unlikeBtn = article.querySelector('[data-testid="unlike"]');

                            return { username, text, isRetweet, alreadyLiked: Boolean(unlikeBtn), hasLikeBtn: Boolean(likeBtn) };
                        });

                        if (!meta || !meta.text) {
                            session.tweetsSkippedOther++;
                            continue;
                        }

                        session.tweetsProcessed++;

                        if (meta.isRetweet) { session.tweetsSkippedOther++; continue; }
                        if (botUsername && meta.username.toLowerCase() === botUsername) { session.tweetsSkippedOther++; continue; }

                        // Like
                        if (meta.hasLikeBtn && !meta.alreadyLiked) {
                            await page.evaluate(() => {
                                const btn = document.querySelector('article[data-testid="tweet"] [data-testid="like"]') as HTMLElement;
                                if (btn) btn.click();
                            });
                            await delay(800);
                            session.likesPosted++;
                        }

                        // Generate + validate reply
                        const reply = await generateReply(meta.text, meta.username);
                        if (!reply) { session.repliesFailed++; continue; }
                        const validation = validateReply(reply);
                        if (!validation.valid) { session.repliesFailed++; continue; }

                        // Post reply
                        const tweetArticle = await page.$('article[data-testid="tweet"]');
                        if (!tweetArticle) { session.repliesFailed++; continue; }

                        const replyResult = await postReply(tweetArticle, page, reply);
                        if (!replyResult.success) {
                            session.repliesFailed++;
                            session.errors.push(replyResult.error || `Reply failed: ${tweetUrl}`);
                            continue;
                        }

                        // Track
                        const tracked: TrackedReply = {
                            tweetUrl,
                            tweetAuthor: meta.username,
                            replyText: reply,
                            timestamp: new Date().toISOString(),
                            verified: true,
                            sessionId: session.sessionId,
                            tweetSnippet: meta.text.slice(0, 100),
                            liked: !meta.alreadyLiked,
                            retweeted: false,
                        };
                        trackReply(tracked);
                        session.repliesPosted++;
                        session.repliesVerified++;
                        session.replies.push(tracked);
                        nicheReplies++;
                        totalReplies++;

                        logger.info(`[multi-niche] Reply ${nicheReplies}/${repliesPerNiche} on "${niche}" → @${meta.username}: "${reply.slice(0, 60)}..."`);

                        // Inter-reply delay
                        if (nicheReplies < repliesPerNiche) {
                            await delay(getRandomDelay(delayBetweenReplies[0], delayBetweenReplies[1]));
                        }

                    } catch (tweetErr) {
                        const errMsg = formatError(tweetErr);
                        logger.warn(`[multi-niche] Error on ${tweetUrl}: ${errMsg}`);
                        session.repliesFailed++;
                        session.errors.push(errMsg);

                        if (errMsg.includes('detached Frame') || errMsg.includes('Session closed') || errMsg.includes('Target closed')) {
                            const freshPage = await twitterAI.getFreshPage();
                            if (freshPage) { page = freshPage; } else break;
                        }
                    }
                }

                perNiche[niche] = nicheReplies;
                logger.info(`[multi-niche] "${niche}" done: ${nicheReplies}/${repliesPerNiche} replies`);

            } catch (nicheErr) {
                logger.warn(`[multi-niche] Niche "${niche}" failed: ${formatError(nicheErr)}`);
                session.errors.push(`Niche "${niche}": ${formatError(nicheErr)}`);

                // Recover page for next niche
                const freshPage = await twitterAI.getFreshPage();
                if (freshPage) { page = freshPage; } else break;
            }

            // Delay between niches
            if (ni < niches.length - 1) {
                await delay(delayBetweenNiches);
            }
        }

        keepOpen = true;
    } catch (error: any) {
        session.errors.push(error?.message || 'Unknown error');
        logger.error('[multi-niche] Fatal error:', error);
    } finally {
        if (!keepOpen) await twitterAI.close();
        saveSession(session);
        updateDailyStats(session);
    }

    const durationSec = Math.round((Date.now() - startTime) / 1000);
    const nicheResults = Object.entries(perNiche).map(([n, c]) => `${n}: ${c}`).join(', ');
    logger.info(`[multi-niche] Blitz complete in ${durationSec}s: ${totalReplies} replies across ${niches.length} niches (${nicheResults})`);

    return { totalReplies, perNiche, session, durationSec, twitterAI: keepOpen ? twitterAI : undefined };
}

// ── Prospect Collection ─────────────────────────────────────────────

const OUTREACH_TARGETS_FILE = path.join(process.cwd(), 'logs', 'tracking', 'twitter-dm', 'outreach_targets.json');

/**
 * Discover prospects by searching Twitter for a term and extracting usernames.
 */
export async function collectNicheProspects(
    page: Page,
    searchTerm: string,
    maxProspects = 20
): Promise<string[]> {
    logger.info(`[twitter-ai] Collecting prospects for "${searchTerm}"...`);

    await page.goto(`https://x.com/search?q=${encodeURIComponent(searchTerm)}&f=top`, {
        waitUntil: 'domcontentloaded',
        timeout: 60000
    });
    await delay(3000);

    const collected = new Set<string>();
    const scrollAttempts = Math.min(10, Math.ceil(maxProspects / 5));

    for (let i = 0; i < scrollAttempts && collected.size < maxProspects; i++) {
        const usernames = await page.evaluate(() => {
            const results: string[] = [];
            const tweets = document.querySelectorAll('article[data-testid="tweet"]');
            for (const tweet of tweets) {
                const userNameEl = tweet.querySelector('div[data-testid="User-Name"]');
                if (!userNameEl) continue;
                const spans = userNameEl.querySelectorAll('span');
                for (const span of spans) {
                    const text = span.textContent?.trim() || '';
                    if (text.startsWith('@')) {
                        results.push(text.slice(1));
                        break;
                    }
                }
            }
            return results;
        });

        for (const u of usernames) {
            if (collected.size >= maxProspects) break;
            // Skip if already DMd
            if (hasSentTwitterDMTo(u)) continue;
            collected.add(u);
        }

        // Scroll down for more results
        await page.evaluate(() => window.scrollBy(0, 800));
        await delay(2000);
    }

    const prospects = Array.from(collected);

    // Merge with existing targets file
    const existing = safeReadJSON<string[]>(OUTREACH_TARGETS_FILE, [], 'twitter_outreach_targets');
    const merged = Array.from(new Set([...existing, ...prospects]));
    safeWriteJSON(OUTREACH_TARGETS_FILE, merged, 'twitter_outreach_targets');

    logger.info(`[twitter-ai] Collected ${prospects.length} new prospects for "${searchTerm}" (${merged.length} total targets)`);
    return prospects;
}

/**
 * Collect followers from a specific Twitter user's followers page.
 */
export async function collectFollowers(
    page: Page,
    username: string,
    maxFollowers = 50
): Promise<string[]> {
    logger.info(`[twitter-ai] Collecting followers of @${username}...`);

    await page.goto(`https://x.com/${username}/followers`, {
        waitUntil: 'domcontentloaded',
        timeout: 60000
    });
    await delay(3000);

    const collected = new Set<string>();
    const scrollAttempts = Math.min(15, Math.ceil(maxFollowers / 5));

    for (let i = 0; i < scrollAttempts && collected.size < maxFollowers; i++) {
        const usernames = await page.evaluate(() => {
            const results: string[] = [];
            const cells = document.querySelectorAll('div[data-testid="cellInnerDiv"], div[data-testid="UserCell"]');
            for (const cell of cells) {
                const links = cell.querySelectorAll('a[href^="/"]');
                for (const link of links) {
                    const href = link.getAttribute('href') || '';
                    const parts = href.split('/').filter(Boolean);
                    if (parts.length === 1 && !['home', 'explore', 'notifications', 'messages', 'settings'].includes(parts[0])) {
                        results.push(parts[0]);
                        break;
                    }
                }
            }
            return results;
        });

        for (const u of usernames) {
            if (collected.size >= maxFollowers) break;
            if (hasSentTwitterDMTo(u)) continue;
            collected.add(u);
        }

        await page.evaluate(() => window.scrollBy(0, 600));
        await delay(2000);
    }

    const followers = Array.from(collected);
    logger.info(`[twitter-ai] Collected ${followers.length} followers of @${username}`);
    return followers;
}

// ── runTwitter (top-level entry, mirrors runInstagram) ───────────────

export async function runTwitter(externalTrace?: any): Promise<void> {
    const trace = externalTrace ?? startRun({
        action: 'twitter_automation',
        cookieFile: TWITTER_COOKIES_PATH,
        target: { username: process.env.TWITTER_BOT_USERNAME }
    });

    try {
        await saveTrace(trace);

        const username = process.env.TWITTER_BOT_USERNAME;
        const password = process.env.TWITTER_BOT_PASSWORD;

        if (!username || !password) {
            throw new Error('Missing Twitter credentials (TWITTER_BOT_USERNAME, TWITTER_BOT_PASSWORD)');
        }

        pushStep(trace, { name: 'validate_credentials', status: 'ok', ms: 0 });
        logger.info('Starting Twitter automation');

        pushStep(trace, { name: 'start_twitter_batch', status: 'ok' });
        await runTwitterBatch(username, TWITTER_POSTS_PER_RUN, trace);

        finishRun(trace, true);
        logger.info('Twitter automation completed');
    } catch (error: any) {
        trace.error = { message: error?.message || 'Unknown error', stack: error?.stack };
        finishRun(trace, false);
        logger.error('Error in Twitter automation:', error);
    } finally {
        await saveTrace(trace);
    }
}

// ── OpenAI instance for content generation ───────────────────────────

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ── AI-Powered Original Tweet Generation ─────────────────────────────

export async function generateTweetContent(options: {
    topic?: string;
    niche?: string;
    style?: 'informative' | 'opinion' | 'question' | 'tip' | 'story' | 'personal_story' | 'insight' | 'hot_take';
    includeHashtags?: boolean;
    maxLength?: number;
    brandContext?: string;
    learningContext?: string;
    offerContext?: string;
} = {}): Promise<string> {
    const {
        topic = '',
        niche = 'tech & AI',
        style = 'informative',
        includeHashtags = false,
        maxLength = 280,
        brandContext,
        learningContext,
        offerContext,
    } = options;

    const styleGuide: Record<string, string> = {
        informative: 'Share a fact, insight, or trend that your audience would find valuable.',
        opinion: 'Share a strong but respectful opinion or hot take that sparks debate.',
        question: 'Ask a thought-provoking question that encourages discussion and replies.',
        tip: 'Share a practical, actionable tip or hack people can use right now.',
        story: 'Share a brief personal anecdote or observation.',
        personal_story: 'Share a real personal experience — a struggle, win, lesson learned, or behind-the-scenes moment. Be vulnerable and authentic. First person. Make people feel like they know you.',
        insight: 'Share a non-obvious insight or contrarian observation from your experience. Something most people get wrong or overlook. Position yourself as someone who sees patterns others miss.',
        hot_take: 'Share a bold, provocative opinion that challenges conventional wisdom. Be confident and direct. The kind of tweet that makes people either strongly agree or reply to argue.',
    };

    const cleanLearning = learningContext ? sanitizeForPrompt(learningContext, 2000) : '';
    const cleanOffer = offerContext ? sanitizeForPrompt(offerContext, 500) : '';

    const prompt = `Generate an original tweet about ${sanitizeForPrompt(topic || niche, 200)}.

Style: ${styleGuide[style] || styleGuide.informative}
${cleanOffer ? `\nOffer context: ${cleanOffer}\n` : ''}
${cleanLearning ? `\n${cleanLearning}\n` : ''}
Rules:
1. Maximum ${maxLength} characters
2. Sound authentic — write like a real person, not a brand
3. No generic motivational quotes
4. ${includeHashtags ? 'Include 1-2 relevant hashtags' : 'Do NOT include hashtags'}
5. Be specific and add real value
6. Do NOT start with "Just" or "I just"
7. No emojis unless they genuinely add meaning
8. Write something that would make people want to engage (reply, retweet, like)

Reply with ONLY the tweet text, nothing else.`;

    const systemContent = brandContext
        ? `${brandContext} You write tweets that are insightful, concise, and drive engagement.`
        : `You are a knowledgeable voice in the ${niche} space on Twitter/X. You write tweets that are insightful, concise, and drive engagement. Your tone is confident but approachable.`;

    const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
            { role: 'system', content: systemContent },
            { role: 'user', content: prompt }
        ],
        max_tokens: 150,
        temperature: 0.9
    });

    const content = completion.choices[0]?.message?.content?.trim() || '';
    // Strip surrounding quotes if present
    return content.replace(/^["']|["']$/g, '');
}

// ── AI-Powered Thread Generation ─────────────────────────────────────

export async function generateThreadContent(options: {
    topic: string;
    niche?: string;
    tweetCount?: number;
    brandContext?: string;
    learningContext?: string;
} = { topic: 'AI trends' }): Promise<string[]> {
    const { topic, niche = 'tech & AI', tweetCount = 4, brandContext, learningContext } = options;

    const prompt = `Write a Twitter/X thread of exactly ${tweetCount} tweets about: ${topic}
${learningContext ? `\n${learningContext}\n` : ''}
Rules:
1. First tweet should be a hook — grab attention, make people want to read more
2. Each tweet is max 280 characters
3. Number each tweet (1/, 2/, etc.) at the start
4. Last tweet should end with a call-to-action (ask a question, invite discussion)
5. Sound like a real person, not a content mill
6. Be specific with examples, data, or insights
7. No hashtags except optionally in the last tweet
8. Each tweet should stand alone but flow as a story

Reply with each tweet on a new line, numbered.`;

    const systemContent = brandContext
        ? `${brandContext} You write viral Twitter threads that educate, inspire, and drive discussion.`
        : `You are a thought leader in ${niche} who writes viral Twitter threads. Your threads educate, inspire, and drive discussion.`;

    const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
            {
                role: 'system',
                content: systemContent
            },
            { role: 'user', content: prompt }
        ],
        max_tokens: 600,
        temperature: 0.85
    });

    const raw = completion.choices[0]?.message?.content?.trim() || '';
    // Parse numbered tweets: "1/ ...", "2/ ...", etc.
    const tweets = raw.split(/\n+/)
        .map(line => line.replace(/^\d+[\/\.]\s*/, '').trim())
        .filter(line => line.length > 0 && line.length <= 280);

    return tweets.length > 0 ? tweets : [raw.slice(0, 280)];
}

// ── Orchestrator: Post an original AI-generated tweet ────────────────

export async function postOriginalTweet(page: Page, options: {
    topic?: string;
    niche?: string;
    style?: 'informative' | 'opinion' | 'question' | 'tip' | 'story' | 'personal_story' | 'insight' | 'hot_take';
    mediaPath?: string;
    brandContext?: string;
    learningContext?: string;
    offerContext?: string;
    contentType?: 'value' | 'engagement' | 'promotional' | 'personal';
    offerId?: string;
} = {}): Promise<PostTweetResult> {
    logger.info('[twitter-ai] Generating original tweet content...');

    const text = await generateTweetContent({
        topic: options.topic,
        niche: options.niche,
        style: options.style,
        brandContext: options.brandContext,
        learningContext: options.learningContext,
        offerContext: options.offerContext,
    });

    if (!text) {
        logger.error('[twitter-ai] Failed to generate tweet content');
        return { success: false, error: 'Failed to generate content' };
    }

    logger.info(`[twitter-ai] Generated tweet: "${text.slice(0, 80)}..."`);

    const tweetOptions: PostTweetOptions = { text };
    if (options.mediaPath) tweetOptions.mediaPath = options.mediaPath;

    const result = await postTweet(page, tweetOptions);

    if (result.success) {
        logger.info(`[twitter-ai] Posted original tweet successfully: ${result.tweetUrl || 'no URL'}`);

        // Track tweet + sync to Supabase
        try {
            const { trackTweet } = await import('../tracking/twitterContentTracker');
            const { syncTweetToSupabase } = await import('../db/supabaseTwitterContent');

            const tracked = trackTweet({
                tweetUrl: result.tweetUrl || '',
                text,
                type: 'tweet',
                contentType: options.contentType || 'value',
                style: options.style || 'informative',
                topic: options.topic || options.niche || '',
                niche: options.niche || '',
                offerId: options.offerId,
                postedAt: new Date().toISOString(),
            });

            syncTweetToSupabase(tracked).catch(e =>
                logger.warn(`[twitter-ai] Supabase tweet sync failed: ${formatError(e)}`)
            );
        } catch (trackErr) {
            logger.warn(`[twitter-ai] Tweet tracking failed (non-fatal): ${formatError(trackErr)}`);
        }
    } else {
        logger.error(`[twitter-ai] Failed to post tweet: ${result.error}`);
    }

    return result;
}

// ── Orchestrator: Post an AI-generated thread ────────────────────────

export async function postAIThread(page: Page, options: {
    topic: string;
    niche?: string;
    tweetCount?: number;
    brandContext?: string;
    learningContext?: string;
    contentType?: 'value' | 'engagement' | 'promotional' | 'personal';
} = { topic: 'AI trends' }): Promise<PostTweetResult> {
    logger.info(`[twitter-ai] Generating thread about: ${options.topic}`);

    const tweets = await generateThreadContent({
        topic: options.topic,
        niche: options.niche,
        tweetCount: options.tweetCount,
        brandContext: options.brandContext,
        learningContext: options.learningContext,
    });

    if (!tweets || tweets.length === 0) {
        logger.error('[twitter-ai] Failed to generate thread content');
        return { success: false, error: 'Failed to generate thread content' };
    }

    logger.info(`[twitter-ai] Generated ${tweets.length}-tweet thread`);

    const threadTweets: ThreadTweet[] = tweets.map(text => ({ text }));
    const result = await postThread(page, threadTweets);

    if (result.success) {
        logger.info(`[twitter-ai] Posted thread successfully (${tweets.length} tweets)`);

        // Track thread + sync to Supabase
        try {
            const { trackTweet } = await import('../tracking/twitterContentTracker');
            const { syncTweetToSupabase } = await import('../db/supabaseTwitterContent');

            const tracked = trackTweet({
                tweetUrl: result.tweetUrl || '',
                text: tweets[0],
                type: 'thread',
                contentType: options.contentType || 'value',
                style: 'thread',
                topic: options.topic,
                niche: options.niche || '',
                postedAt: new Date().toISOString(),
                threadTweets: tweets,
            });

            syncTweetToSupabase(tracked).catch(e =>
                logger.warn(`[twitter-ai] Supabase thread sync failed: ${formatError(e)}`)
            );
        } catch (trackErr) {
            logger.warn(`[twitter-ai] Thread tracking failed (non-fatal): ${formatError(trackErr)}`);
        }
    } else {
        logger.error(`[twitter-ai] Failed to post thread: ${result.error}`);
    }

    return result;
}

// ── Strategic Content Orchestrator ────────────────────────────────────

export async function postStrategicContent(page: Page, runNumber: number): Promise<PostTweetResult> {
    const { loadBrandIdentity, getBrandPromptContext, getOfferContext } = await import('../strategy/twitter-brand');
    const { getNextContentSlot } = await import('../strategy/twitter-content-calendar');
    const { getContentLearningContext } = await import('./Twitter-Content-Analytics');

    const brand = loadBrandIdentity();
    const brandContext = getBrandPromptContext(brand);
    const slot = await getNextContentSlot(runNumber);

    logger.info(`[twitter-ai] Strategic content: ${slot.type}/${slot.style} (niche: ${slot.niche || brand.niche})`);

    const learningContext = getContentLearningContext(slot.type, slot.style);
    const offerContext = slot.offerId ? getOfferContext(brand, slot.offerId) : null;

    // Thread posts
    if (slot.style === 'thread') {
        return postAIThread(page, {
            topic: slot.topic || slot.niche || brand.niche,
            niche: slot.niche || brand.niche,
            tweetCount: 4,
            brandContext,
            learningContext,
            contentType: slot.type,
        });
    }

    // Quote tweet — find a tweet in the feed and add commentary
    if (slot.style === 'quote_tweet') {
        return postStrategicQuoteTweet(page, {
            niche: slot.niche || brand.niche,
            brandContext,
            learningContext,
        });
    }

    const style = slot.style as 'informative' | 'opinion' | 'question' | 'tip' | 'story' | 'personal_story' | 'insight' | 'hot_take';

    return postOriginalTweet(page, {
        topic: slot.topic || slot.niche || brand.niche,
        niche: slot.niche || brand.niche,
        style,
        brandContext,
        learningContext,
        offerContext: offerContext || undefined,
        contentType: slot.type,
        offerId: slot.offerId,
    });
}

/**
 * Find an interesting tweet in the feed and quote-tweet it with AI commentary.
 */
async function postStrategicQuoteTweet(page: Page, options: {
    niche: string;
    brandContext?: string;
    learningContext?: string;
}): Promise<PostTweetResult> {
    try {
        // Navigate to home feed
        await page.goto('https://x.com/home', { waitUntil: 'networkidle2', timeout: 15000 });
        await delay(3000);

        // Find tweets in the feed that are worth quote-tweeting
        const tweets = await page.$$('article[data-testid="tweet"]');
        if (tweets.length === 0) {
            return { success: false, error: 'No tweets found in feed for quote tweeting' };
        }

        // Try up to 5 tweets to find one worth quoting
        const candidates = tweets.slice(0, Math.min(tweets.length, 8));
        // Shuffle to add variety
        for (let i = candidates.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
        }

        for (const tweet of candidates.slice(0, 5)) {
            try {
                const metadata = await extractTweetMetadata(tweet, page);
                if (!metadata || !metadata.text || metadata.text.length < 20) continue;
                // Skip our own tweets and retweets
                if (metadata.isRetweet) continue;

                // Content filter — skip political/toxic/non-English tweets
                const { filterTweet: filterQT } = await import('../filters/twitter-content-filter');
                const qtFilter = filterQT(metadata.text, metadata.username, metadata.displayName);
                if (!qtFilter.allowed) {
                    logger.debug(`[twitter-ai] QT skip (${qtFilter.gate}): ${qtFilter.reason}`);
                    continue;
                }

                const result = await aiQuoteTweet(page, tweet, metadata.text, metadata.username || 'unknown', {
                    niche: options.niche,
                    learningContext: options.learningContext,
                });

                if (result.success) {
                    // Track as strategic content
                    try {
                        const { trackTweet } = await import('../tracking/twitterContentTracker');
                        const { syncTweetToSupabase } = await import('../db/supabaseTwitterContent');
                        const tracked = trackTweet({
                            tweetUrl: result.tweetUrl || '',
                            text: `QT @${metadata.username}: ${metadata.text.slice(0, 100)}`,
                            type: 'quote',
                            contentType: 'engagement',
                            style: 'quote_tweet',
                            topic: options.niche,
                            niche: options.niche,
                            postedAt: new Date().toISOString(),
                        });
                        syncTweetToSupabase(tracked).catch(e =>
                            logger.warn(`[twitter-ai] Supabase quote tweet sync failed: ${formatError(e)}`)
                        );
                    } catch (trackErr) {
                        logger.warn(`[twitter-ai] Quote tweet tracking failed (non-fatal): ${formatError(trackErr)}`);
                    }
                    return result;
                }
            } catch (qtErr) {
                logger.debug(`[twitter-ai] Quote tweet attempt failed: ${formatError(qtErr)}`);
                continue;
            }
        }

        // Fallback: post an opinion tweet instead
        logger.info('[twitter-ai] No suitable tweet found for quoting, falling back to hot take');
        return postOriginalTweet(page, {
            niche: options.niche,
            style: 'hot_take',
            contentType: 'engagement',
            brandContext: options.brandContext,
        });
    } catch (e) {
        logger.warn(`[twitter-ai] Strategic quote tweet failed: ${formatError(e)}`);
        return { success: false, error: formatError(e) };
    }
}

// ── Auto-follow prospects ────────────────────────────────────────────

export async function autoFollowProspects(page: Page, options: {
    maxFollows?: number;
    source?: 'outreach_targets' | 'niche_search';
    niche?: string;
} = {}): Promise<{ followed: string[]; failed: string[] }> {
    const { maxFollows = 5, source = 'outreach_targets', niche } = options;
    const TARGETS_FILE = path.join(process.cwd(), 'logs', 'tracking', 'twitter-dm', 'outreach_targets.json');

    let usernames: string[] = [];

    if (source === 'outreach_targets') {
        const targets = safeReadJSON<string[]>(TARGETS_FILE, [], 'twitter_outreach_targets');
        usernames = targets.slice(0, maxFollows);
    } else if (source === 'niche_search' && niche) {
        usernames = await collectNicheProspects(page, niche, maxFollows);
    }

    const followed: string[] = [];
    const failed: string[] = [];

    for (const username of usernames) {
        try {
            const result = await followUser(page, username);
            if (result) {
                followed.push(username);
                logger.info(`[twitter-ai] Followed @${username}`);
            } else {
                failed.push(username);
            }
            await delay(getRandomDelay(3000, 6000));
        } catch (e) {
            logger.warn(`[twitter-ai] Failed to follow @${username}: ${formatError(e)}`);
            failed.push(username);
        }
    }

    logger.info(`[twitter-ai] Follow results: ${followed.length} followed, ${failed.length} failed`);
    return { followed, failed };
}

// ── AI Quote Tweet ───────────────────────────────────────────────────

export async function aiQuoteTweet(page: Page, tweet: ElementHandle, tweetText: string, author: string, options: {
    niche?: string;
    learningContext?: string;
} = {}): Promise<PostTweetResult> {
    const { niche = 'tech & AI', learningContext } = options;

    const prompt = `Write commentary for a quote tweet of this tweet by @${author}: "${tweetText}"
${learningContext ? `\n${learningContext}\n` : ''}
Rules:
1. Max 200 characters
2. Add your perspective — agree, disagree, expand, or contextualize
3. Sound authentic and thoughtful
4. No generic praise like "So true!" or "Great point!"
5. No hashtags

Reply with ONLY the commentary text.`;

    const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
            {
                role: 'system',
                content: `You are an engaged Twitter/X user in the ${niche} space. You add value when quote tweeting.`
            },
            { role: 'user', content: prompt }
        ],
        max_tokens: 80,
        temperature: 0.85
    });

    const commentary = completion.choices[0]?.message?.content?.trim()?.replace(/^["']|["']$/g, '') || '';

    if (!commentary) {
        return { success: false, error: 'Failed to generate quote tweet commentary' };
    }

    logger.info(`[twitter-ai] Quote tweeting @${author} with: "${commentary.slice(0, 50)}..."`);
    return await quoteTweet(tweet, page, commentary);
}
