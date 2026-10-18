import { Browser, DEFAULT_INTERCEPT_RESOLUTION_PRIORITY } from "puppeteer";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import AdblockerPlugin from "puppeteer-extra-plugin-adblocker";
import UserAgent from "user-agents";
import { Server } from "proxy-chain";
import logger from "../config/logger";
import { Instagram_cookiesExist, loadCookies, saveCookies } from "../utils";
import { getInstagramCommentSchema } from "../Agent/schema";
import fs from 'fs';
import path from 'path';

// Add stealth plugin to puppeteer
puppeteer.use(StealthPlugin());
puppeteer.use(
    AdblockerPlugin({
        interceptResolutionPriority: DEFAULT_INTERCEPT_RESOLUTION_PRIORITY,
    })
);

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

interface PostInteraction {
    postIndex: number;
    timestamp: string;
    caption: string;
    likeMethod: string | null;
    commentMethod: string | null;
    commentText: string | null;
    success: boolean;
    details: string;
    hasExistingComment?: boolean;
}

const postInteractions: PostInteraction[] = [];

// Enhanced version of getPostCaption with more selectors and better error handling
async function getPostCaption(post: any): Promise<string> {
    try {
        // First try to find the "More" button and click it
        const moreButton = await post.$('div[role="button"]:has-text("more")');
        if (moreButton) {
            await moreButton.click();
            await delay(2000);
        }

        // Extended list of selectors for better caption detection
        const selectors = [
            'h1:first-of-type',
            'div._a9zs',
            'div[data-testid="post-title"]',
            'div.C4VMK span',
            'span._aacl._aaco._aacu._aacx._aad7._aade',
            'article div._a9zs',
            'div[class*="caption"] span',
            'ul._a9z6._a9za li._a9zc span',
            'div._a9zs span._aacl._aaco._aacu._aacx._aad7._aade'
        ];

        for (const selector of selectors) {
            const element = await post.$(selector);
            if (element) {
                const text = await element.evaluate((el: HTMLElement) => el.textContent);
                if (text && text.trim()) {
                    logger.info('Caption found using selector:', selector);
                    return text.trim();
                }
            }
        }

        // Try finding caption in article text content as fallback
        try {
            const articleText = await post.evaluate(() => {
                const article = document.querySelector('article');
                if (!article) return null;

                const walker = document.createTreeWalker(
                    article,
                    NodeFilter.SHOW_TEXT,
                    null
                );

                let node;
                let text = '';
                while (node = walker.nextNode()) {
                    const trimmed = node.textContent?.trim();
                    if (trimmed && trimmed.length > 20) {
                        text = trimmed;
                        break;
                    }
                }
                return text;
            });

            if (articleText) {
                logger.info('Caption found in article text content');
                return articleText;
            }
        } catch (error) {
            logger.debug('Error extracting caption from article:', error);
        }

        logger.warn('No caption found with any method');
        return '';
    } catch (error: any) {
        logger.warn('Error getting post caption:', error.message);
        return '';
    }
}

// Enhanced version of hasAlreadyCommented with better detection
async function hasAlreadyCommented(post: any, username: string): Promise<boolean> {
    try {
        logger.info('Checking for existing comments...');

        // Try to expand comments if there's a "View all comments" button
        try {
            const viewCommentsButton = await post.$('text/View all comments');
            if (viewCommentsButton) {
                logger.info('Expanding comments...');
                await viewCommentsButton.click();
                await delay(2000);
            }
        } catch (error) {
            logger.debug('No view comments button or error expanding comments');
        }

        // Try multiple selectors for comments
        const commentSelectors = [
            'ul._a9z6._a9za li._a9zc',
            'div[class*="comment"]',
            'span._aacl._aaco._aacu._aacx._aad7._aade'
        ];

        for (const selector of commentSelectors) {
            try {
                const comments = await post.$$(selector);
                logger.info(`Found ${comments.length} comments with selector: ${selector}`);

                for (const comment of comments) {
                    const commentData = await comment.evaluate((el: HTMLElement) => {
                        const userElement = el.querySelector('a[class*="user"]') || 
                                         el.querySelector('a[href*="/"]') ||
                                         el.querySelector('h3');
                        return {
                            username: userElement?.textContent?.trim() || '',
                            text: el.textContent?.trim() || ''
                        };
                    });

                    if (commentData.username.replace('@', '') === username.replace('@', '')) {
                        logger.info('Found existing comment by user:', commentData.text);
                        return true;
                    }
                }
            } catch (error) {
                logger.debug(`Error checking comments with selector ${selector}:`, error);
            }
        }

        logger.info('No existing comment found from user');
        return false;
    } catch (error) {
        logger.error('Error checking for existing comments:', error);
        return false;
    }
}

// Enhanced version of postComment with improved validation
async function postComment(post: any, commentText: string): Promise<boolean> {
    try {
        // Click the comment button
        const commentButton = await post.$('svg[aria-label="Comment"]');
        if (!commentButton) {
            logger.warn('Comment button not found');
            return false;
        }

        await post.evaluate(() => {
            const button = document.querySelector('svg[aria-label="Comment"]')?.closest('button');
            if (button) {
                (button as HTMLButtonElement).click();
            }
        });
        await delay(2000);

        // Find and type in the comment box
        const commentBox = await post.$('textarea[aria-label="Add a comment…"]');
        if (!commentBox) {
            logger.warn('Comment box not found');
            return false;
        }

        // Clear and type the comment
        await commentBox.click();
        await delay(500);
        await commentBox.evaluate((el: HTMLTextAreaElement) => el.value = '');
        await commentBox.type(commentText, { delay: 100 });
        await delay(1000);

        // Use our successful center-click method
        const postButton = await findPostButton(post);
        if (!postButton) {
            logger.warn('Post button not found');
            return false;
        }

        const clicked = await clickExactCenter(post, postButton);
        if (!clicked) {
            logger.warn('Failed to click post button');
            return false;
        }

        // Verify the comment was posted
        await delay(2000);
        const validation = await validateComment(post, commentText);
        if (validation.success) {
            logger.info('Comment posted successfully');
            return true;
        }

        logger.warn('Comment validation failed:', validation.details);
        return false;
    } catch (error) {
        logger.error('Error posting comment:', error);
        return false;
    }
}

// Enhanced version of validateComment with multiple checks
async function validateComment(post: any, commentText: string): Promise<{ success: boolean; details: string }> {
    try {
        logger.info('Starting comment validation...');
        
        // Check 1: Look for success message
        const successMessage = await post.$('text/Comment posted');
        if (successMessage) {
            logger.info('Found success message');
            return { success: true, details: 'Success message found' };
        }

        // Check 2: Verify comment box is empty/closed
        const commentBox = await post.$('textarea[aria-label="Add a comment…"]');
        if (commentBox) {
            const value = await commentBox.evaluate((el: HTMLTextAreaElement) => el.value);
            if (!value) {
                logger.info('Comment box is empty, suggesting successful post');
                return { success: true, details: 'Comment box is empty' };
            }
        }

        // Check 3: Look for our comment in the comments section
        const comments = await post.$$('ul._a9z6._a9za li._a9zc');
        for (const comment of comments) {
            const text = await comment.evaluate((el: HTMLElement) => el.textContent);
            if (text && text.includes(commentText)) {
                logger.info('Found comment in comments section');
                return { success: true, details: 'Comment found in section' };
            }
        }

        // Check 4: Look for "Just now" indicator
        const newCommentIndicators = await post.$$('text/Just now');
        if (newCommentIndicators.length > 0) {
            logger.info('Found "Just now" indicator');
            return { success: true, details: 'New comment indicator found' };
        }

        return { success: false, details: 'Could not verify comment was posted' };
    } catch (error) {
        logger.error('Error validating comment:', error);
        return { success: false, details: 'Error during validation' };
    }
}

// Helper function to find the post button
async function findPostButton(post: any) {
    try {
        const button = await post.$('button[type="submit"]');
        if (button) {
            const isEnabled = await button.evaluate((el: HTMLButtonElement) => {
                const style = window.getComputedStyle(el);
                return !el.disabled && 
                       !el.hasAttribute('disabled') && 
                       style.opacity !== '0.3' &&
                       style.display !== 'none' &&
                       style.visibility !== 'hidden';
            });

            if (isEnabled) {
                return button;
            }
        }
    } catch (error) {
        logger.warn('Error finding post button:', error);
    }
    return null;
}

// Helper function to click the exact center of an element
async function clickExactCenter(post: any, element: any): Promise<boolean> {
    try {
        const box = await element.boundingBox();
        if (!box) {
            logger.warn('Could not get element bounding box');
            return false;
        }

        // Calculate exact center
        const centerX = box.x + (box.width / 2);
        const centerY = box.y + (box.height / 2);

        // Move to center gradually
        await post.mouse.move(centerX, centerY, { steps: 10 });
        await delay(100);
        await post.mouse.down();
        await delay(100);
        await post.mouse.up();

        return true;
    } catch (error) {
        logger.warn('Error in clickExactCenter:', error);
        return false;
    }
}

// Add new utility functions for rate limiting and randomization
const getRandomDelay = (min: number, max: number) => {
    return Math.floor(Math.random() * (max - min + 1) + min);
};

const rateLimiter = {
    lastAction: 0,
    minDelay: 2000,
    maxDelay: 5000,
    async wait() {
        const now = Date.now();
        const timeSinceLastAction = now - this.lastAction;
        const randomDelay = getRandomDelay(this.minDelay, this.maxDelay);
        
        if (timeSinceLastAction < randomDelay) {
            await delay(randomDelay - timeSinceLastAction);
        }
        this.lastAction = Date.now();
    }
};

// Enhanced session management
interface SessionStats {
    startTime: Date;
    totalPosts: number;
    successfulLikes: number;
    successfulComments: number;
    failedAttempts: number;
    errors: Array<{ timestamp: Date; error: string }>;
}

class SessionManager {
    private stats: SessionStats;
    private maxFailedAttempts: number;
    private maxErrors: number;

    constructor(maxFailedAttempts = 5, maxErrors = 10) {
        this.maxFailedAttempts = maxFailedAttempts;
        this.maxErrors = maxErrors;
        this.stats = this.initStats();
    }

    private initStats(): SessionStats {
        return {
            startTime: new Date(),
            totalPosts: 0,
            successfulLikes: 0,
            successfulComments: 0,
            failedAttempts: 0,
            errors: []
        };
    }

    recordSuccess(type: 'like' | 'comment') {
        if (type === 'like') this.stats.successfulLikes++;
        else this.stats.successfulComments++;
        this.stats.totalPosts++;
    }

    recordError(error: string) {
        this.stats.errors.push({ timestamp: new Date(), error });
        this.stats.failedAttempts++;
        return this.shouldPause();
    }

    shouldPause(): boolean {
        return this.stats.failedAttempts >= this.maxFailedAttempts || 
               this.stats.errors.length >= this.maxErrors;
    }

    getStats(): SessionStats {
        return { ...this.stats };
    }

    reset() {
        this.stats = this.initStats();
    }
}

// Export the InstagramEnhanced class
export class InstagramEnhanced {
    private page: any;
    private sessionManager: SessionManager;
    private cookiesPath: string;

    constructor(page: any) {
        this.page = page;
        this.sessionManager = new SessionManager();
        
        const username = process.env.INSTAGRAM_USERNAME;
        if (!username) {
            throw new Error('Missing INSTAGRAM_USERNAME in environment variables');
        }
        
        const cookiesDir = path.join(process.cwd(), 'cookies');
        if (!fs.existsSync(cookiesDir)) {
            fs.mkdirSync(cookiesDir, { recursive: true });
        }
        this.cookiesPath = path.join(cookiesDir, `Instagram_${username}_cookies.json`);
    }

    async init() {
        logger.info('Initializing Instagram bot...');
        await this.page.setViewport({ width: 1920, height: 1080 });
        
        // Set a random user agent
        const userAgent = new UserAgent({ deviceCategory: 'desktop' });
        await this.page.setUserAgent(userAgent.toString());

        // Load cookies if they exist
        if (await Instagram_cookiesExist(this.cookiesPath)) {
            logger.info('Loading existing cookies...');
            const cookies = await loadCookies(this.cookiesPath);
            await this.page.setCookie(...cookies);
            logger.info('Cookies loaded successfully');
        }
    }

    async start() {
        logger.info('Starting Instagram bot...');
        
        // Navigate to Instagram and wait for initial load
        await Promise.all([
            this.page.goto('https://www.instagram.com/', {
                waitUntil: 'domcontentloaded'
            }),
            this.page.waitForSelector('body')
        ]);
        
        await delay(3000);

        // Check if we need to log in
        const loginButton = await this.page.$('button:has-text("Log in")');
        if (loginButton) {
            logger.info('Login required. Attempting to log in...');
            await this.loginWithCredentials();
        } else {
            logger.info('Already logged in');
        }

        // Reload the page after login
        await this.page.reload({ waitUntil: 'domcontentloaded' });
        await delay(3000);
    }

    private async loginWithCredentials() {
        const username = process.env.INSTAGRAM_USERNAME;
        const password = process.env.INSTAGRAM_PASSWORD;

        if (!username || !password) {
            throw new Error('Missing Instagram credentials in environment variables');
        }

        try {
            logger.info('Starting login process...');
            
            // Navigate and wait for form simultaneously
            const [, usernameInput] = await Promise.all([
                this.page.goto('https://www.instagram.com/accounts/login/', {
                    waitUntil: 'domcontentloaded'
                }),
                this.page.waitForSelector('input[name="username"]', {
                    visible: true,
                    timeout: 10000
                })
            ]);

            // Fill credentials in parallel
            logger.info('Entering credentials...');
            await Promise.all([
                this.page.type('input[name="username"]', username),
                this.page.type('input[name="password"]', password)
            ]);
            
            // Submit and wait for navigation
            logger.info('Submitting login form...');
            await Promise.all([
                this.page.click('button[type="submit"]'),
                this.page.waitForNavigation({
                    waitUntil: 'domcontentloaded'
                })
            ]);

            // Quick check for login success
            const loginError = await this.page.$('p[role="alert"]');
            if (loginError) {
                const errorText = await this.page.evaluate((el: any) => el.textContent, loginError);
                throw new Error(`Login failed: ${errorText}`);
            }

            // Verify login with inbox link
            const isLoggedIn = await this.page.$('a[href="/direct/inbox/"]')
                .then((element: any) => !!element)
                .catch(() => false);

            if (!isLoggedIn) {
                throw new Error('Login verification failed - inbox link not found');
            }

            logger.info('Login successful');

            // Save cookies
            logger.info('Saving cookies...');
            const cookies = await this.page.cookies();
            await saveCookies(this.cookiesPath, cookies);
            logger.info('Cookies saved successfully');

            // Handle "Save Login Info" popup if it appears
            const saveLoginButton = await this.page.$('button:has-text("Not Now")');
            if (saveLoginButton) {
                await saveLoginButton.click();
                await delay(2000);
            }

            // Handle notifications popup if it appears
            const notificationButton = await this.page.$('button:has-text("Not Now")');
            if (notificationButton) {
                await notificationButton.click();
                await delay(2000);
            }

        } catch (error: any) {
            logger.error('Error during login:', error.message);
            if (error.stack) {
                logger.error('Login error stack trace:', error.stack);
            }
            throw error;
        }
    }

    async interactWithPosts() {
        try {
            logger.info('Starting post interaction process...');
            
            // Ensure we are on the home feed
            logger.info('Ensuring we are on the home feed...');
            await this.page.goto('https://www.instagram.com/', { waitUntil: 'networkidle0' });
            await delay(5000);
            
            // Wait for posts to load
            logger.info('Waiting for posts to load...');
            const posts = await this.page.$$('article');
            logger.info(`Found ${posts.length} posts`);
            
            // Process each post
            for (let i = 0; i < Math.min(posts.length, 5); i++) {
                logger.info(`Processing post ${i + 1}...`);
                
                // Get caption first
                const caption = await getPostCaption(posts[i]);
                logger.info(`Post ${i + 1} caption:`, caption);

                // Check if we've already commented
                const alreadyCommented = await hasAlreadyCommented(posts[i], process.env.INSTAGRAM_USERNAME || '');
                if (alreadyCommented) {
                    logger.info(`Already commented on post ${i + 1}, skipping...`);
                    continue;
                }

                // Like the post using one of our like methods
                const likeSuccess = await this.testLikeButtonMethods(posts[i], i + 1);
                if (likeSuccess) {
                    logger.info(`Successfully liked post ${i + 1}`);
                    
                    // Post a comment
                    const defaultComment = "This is awesome! ✨"; // Default comment
                    const commentSuccess = await this.postComment(posts[i], defaultComment);
                    
                    if (commentSuccess) {
                        logger.info(`Successfully commented on post ${i + 1}`);
                        // Log the interaction
                        const interaction: PostInteraction = {
                            postIndex: i + 1,
                            timestamp: new Date().toISOString(),
                            caption,
                            likeMethod: 'Method 2: Click with coordinates',
                            commentMethod: 'Direct comment method',
                            commentText: defaultComment,
                            success: true,
                            details: 'Successfully liked and commented on post'
                        };
                        await this.logInteraction(interaction);
                    } else {
                        logger.warn(`Failed to comment on post ${i + 1}`);
                    }
                } else {
                    logger.warn(`Failed to like post ${i + 1}`);
                }
                
                await delay(3000); // Wait between posts
            }
            
            logger.info('Post interactions completed successfully');
            
        } catch (error: any) {
            logger.error('Error in post interactions:', error.message);
            throw error;
        }
    }

    async testLikeButtonMethods(post: any, postIndex: number): Promise<boolean> {
        try {
            const likeButton = await post.$('button svg[aria-label="Like"]');
            if (likeButton) {
                await likeButton.click();
                logger.info(`Successfully liked post ${postIndex}`);
                return true;
            }
            logger.warn(`Could not find like button for post ${postIndex}`);
            return false;
        } catch (error: any) {
            logger.error(`Error liking post ${postIndex}:`, error.message);
            return false;
        }
    }

    async postComment(post: any, commentText: string): Promise<boolean> {
        try {
            // Find and click the comment button
            const commentButton = await post.$('button svg[aria-label="Comment"]');
            if (!commentButton) {
                logger.warn('Comment button not found');
                return false;
            }
            await commentButton.click();
            await delay(2000);

            // Find the comment input field
            const commentInput = await post.$('textarea[aria-label="Add a comment…"]');
            if (!commentInput) {
                logger.warn('Comment input not found');
                return false;
            }

            // Type the comment
            await commentInput.type(commentText);
            await delay(1000);

            // Find and click the post button
            const postButton = await post.$('button[type="submit"]');
            if (!postButton) {
                logger.warn('Post button not found');
                return false;
            }
            await postButton.click();
            await delay(2000);

            return true;
        } catch (error: any) {
            logger.error('Error posting comment:', error.message);
            return false;
        }
    }

    private async logInteraction(interaction: PostInteraction) {
        // Implementation of logInteraction
        logger.info('Post Interaction:', interaction);
    }

    private async generateComment(caption: string): Promise<string> {
        const commentSchema = getInstagramCommentSchema();
        // Add your comment generation logic here
        return `Great post! ${caption.substring(0, 50)}...`;
    }
}
