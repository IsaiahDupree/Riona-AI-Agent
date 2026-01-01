import { Page, ElementHandle } from 'puppeteer';
import { logger } from '../utils/logger';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import AdblockerPlugin from 'puppeteer-extra-plugin-adblocker';
import puppeteer from 'puppeteer-extra';
import dotenv from 'dotenv';
import { OpenAI } from 'openai';
import * as path from 'path';
import * as fs from 'fs';
import { delay } from '../utils/delay';
import { startRun, pushStep, finishRun } from '../trace/runtime';
import { AccountModel } from '../hitl/models';
import { InteractionHistory } from '../analytics/interactionHistory';
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

// Import DM functionality
import {
    processDMs,
    initDMStorage,
    DMProcessResult
} from './InstagramDM';

// Load environment variables
dotenv.config();

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

    constructor() {
        this.setupLogging();
        this.cookiesPath = path.join(process.cwd(), 'cookies.json');
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

    async initialize(): Promise<void> {
        try {
            // Initialize browser with stealth mode
            this.browser = await puppeteer.launch({
                headless: false,  // Keep browser visible
                defaultViewport: null,  // Use default viewport
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-infobars',
                    '--window-position=0,0',
                    '--ignore-certifcate-errors',
                    '--ignore-certifcate-errors-spki-list',
                    '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                    '--start-maximized'  // Start with maximized window
                ]
            });

            // Create new page with stealth
            this.page = await this.browser.newPage();
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
            if (fs.existsSync(this.cookiesPath)) {
                const cookiesString = fs.readFileSync(this.cookiesPath, 'utf8');
                const cookies = JSON.parse(cookiesString);
                await this.page.setCookie(...cookies);
                logger.info('Cookies loaded successfully');

                // Verify cookies are still valid
                await this.page.goto('https://www.instagram.com/', { waitUntil: 'networkidle0', timeout: LOGIN_TIMEOUT_MS });
                const loginButton = await this.page.$('button[type="submit"]');
                if (loginButton) {
                    logger.info('Cookies expired, logging in again');
                    await this.login();
                } else {
                    logger.info('Cookies are valid');
                    this.isLoggedIn = true;
                }
            } else {
                logger.info('No cookies found, performing fresh login');
                await this.login();
            }
        } catch (error) {
            logger.error('Error loading cookies:', error);
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

            // Fill in login form
            await this.page.waitForSelector('input[name="username"]', { timeout: LOGIN_TIMEOUT_MS });
            await this.page.type('input[name="username"]', username, { delay: 50 });
            await this.page.type('input[name="password"]', password, { delay: 50 });

            // Click login button
            await this.page.waitForSelector('button[type="submit"]', { timeout: LOGIN_TIMEOUT_MS });
            await this.page.click('button[type="submit"]');

            // Wait for navigation
            await this.page.waitForNavigation({ waitUntil: 'networkidle0', timeout: LOGIN_TIMEOUT_MS });

            // Check for successful login
            const loginError = await this.page.$('p[role="alert"]');
            if (loginError) {
                const errorText = await this.page.evaluate(el => el.textContent, loginError);
                throw new Error(`Login failed: ${errorText}`);
            }

            // Save new cookies
            const cookies = await this.page.cookies();
            fs.writeFileSync(this.cookiesPath, JSON.stringify(cookies));
            logger.info('Login successful, cookies saved');
            this.isLoggedIn = true;

            // Handle "Save Login Info" dialog if it appears
            try {
                const saveLoginButton = await this.page.$('button:has-text("Not Now")');
                if (saveLoginButton) {
                    await saveLoginButton.click();
                    await this.delay(1000);
                }
            } catch (error) {
                logger.info('No save login dialog found');
            }

            // Handle notifications dialog if it appears
            try {
                const notifyButton = await this.page.$('button:has-text("Not Now")');
                if (notifyButton) {
                    await notifyButton.click();
                    await this.delay(1000);
                }
            } catch (error) {
                logger.info('No notifications dialog found');
            }

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
}

// Main interaction loop
export async function startInteractionLoop(username: string, trace?: any): Promise<void> {
    const instagramAI = new InstagramAI();

    try {
        // Initialize browser and login
        if (trace) pushStep(trace, { name: 'init_browser', status: 'ok' });
        await instagramAI.initialize();

        // Load account preferences for scheduling and limits
        const account = await AccountModel.findOne({ platform: 'instagram', username }).lean();
        const prefs: any = (account as any)?.preferences || {};
        const dailyLimit: number = typeof prefs.dailyCommentLimit === 'number' ? prefs.dailyCommentLimit : 0;

        const withinWorkingWindow = (d: Date) => {
            try {
                const day = d.getDay(); // 0=Sun
                if (Array.isArray(prefs.daysOfWeek) && prefs.daysOfWeek.length > 0 && !prefs.daysOfWeek.includes(day)) return false;
                if (prefs.workingHours && prefs.workingHours.start && prefs.workingHours.end) {
                    const hhmm = (n: number) => String(n).padStart(2, '0');
                    const cur = `${hhmm(d.getHours())}:${hhmm(d.getMinutes())}`;
                    return cur >= prefs.workingHours.start && cur <= prefs.workingHours.end;
                }
                return true;
            } catch { return true; }
        };

        const startOfToday = () => {
            const now = new Date();
            return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
        };

        const countCommentsToday = async (): Promise<number> => {
            try {
                const accId = (account as any)?.id || username;
                const from = startOfToday();
                return await InteractionHistory.countDocuments({
                    accountId: accId,
                    interactionType: 'comment',
                    createdAt: { $gte: from }
                });
            } catch { return 0; }
        };

        let continueScraping = true;
        let batchCount = 0;
        while (continueScraping) {
            try {
                batchCount++;
                // Respect working window
                if (!withinWorkingWindow(new Date())) {
                    logger.info('Outside working window. Sleeping 5 minutes before re-check.');
                    await new Promise(resolve => setTimeout(resolve, 5 * 60 * 1000));
                    continue;
                }

                // Respect daily comment limit (if configured)
                if (dailyLimit > 0) {
                    const used = await countCommentsToday();
                    if (used >= dailyLimit) {
                        logger.info(`Daily comment limit reached (${used}/${dailyLimit}). Stopping loop for today.`);
                        break;
                    }
                }

                if (trace) pushStep(trace, { name: `process_batch_${batchCount}`, status: 'ok' });
                await instagramAI.processHomeFeed(trace);

                // Process DMs (check every batch)
                const dmEnabled = process.env.INSTAGRAM_DM_ENABLED === 'true';
                const dmAutoRespond = process.env.INSTAGRAM_DM_AUTO_RESPOND === 'true';
                if (dmEnabled) {
                    if (trace) pushStep(trace, { name: `process_dms_batch_${batchCount}`, status: 'ok' });
                    try {
                        await instagramAI.processDMs({
                            autoRespond: dmAutoRespond,
                            maxConversations: 5,
                            trace
                        });
                    } catch (dmError: any) {
                        logger.warn('DM processing failed, continuing with main loop:', dmError?.message);
                        if (trace) pushStep(trace, { name: `dms_error_batch_${batchCount}`, status: 'error', notes: dmError?.message });
                    }
                }

                // If limit is configured, re-check after batch
                if (dailyLimit > 0) {
                    const used = await countCommentsToday();
                    if (used >= dailyLimit) {
                        logger.info(`Daily comment limit reached after batch (${used}/${dailyLimit}). Ending loop.`);
                        break;
                    }
                }

                // Small randomized pause between batches
                const waitMs = getRandomDelay(30000, 60000);
                logger.info(`Waiting ${waitMs}ms before next batch`);
                await new Promise(resolve => setTimeout(resolve, waitMs));
            } catch (error: any) {
                if (trace) pushStep(trace, { name: `batch_${batchCount}_error`, status: 'error', notes: error?.message });
                logger.error('Error in interaction loop:', error);
                const delay = getRandomDelay(60000, 120000);
                logger.info(`Error occurred, waiting ${delay}ms before retry`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    } finally {
        if (trace) pushStep(trace, { name: 'close_browser', status: 'ok' });
        await instagramAI.close();
    }
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

        // Initialize Storage
        pushStep(trace, { name: 'init_storage', status: 'ok' });
        await initStorage();

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