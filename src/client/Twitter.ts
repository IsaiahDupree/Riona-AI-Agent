/**
 * Twitter.ts — Browser automation base for Twitter/X
 * Mirrors the Instagram.ts / Threads-AI.ts architecture
 * Handles login, cookie persistence, and browser lifecycle
 */

import { Page, Browser } from 'puppeteer';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { logger } from '../utils/logger';
import { formatError, screenshotPath } from '../utils/errors';
import * as path from 'path';
import * as fs from 'fs';
import dotenv from 'dotenv';

dotenv.config({ override: true });

// Stealth plugin (idempotent — puppeteer-extra deduplicates)
puppeteer.use(StealthPlugin());

// ── Config ───────────────────────────────────────────────────────────

const TWITTER_TIMEOUT = parseInt(process.env.TWITTER_TIMEOUT_MS || '60000', 10);
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const TWITTER_PROFILE = path.join(process.cwd(), 'chrome-profile-twitter');
const HEADLESS = process.env.TWITTER_HEADLESS === 'true';

function getCookiesPath(username: string): string {
    return path.join(process.cwd(), 'cookies', `Twitter_${username}_cookies.json`);
}

// ── Utilities ────────────────────────────────────────────────────────

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

function randomJitter(baseMs: number, jitterPercentage = 0.3): number {
    const jitterAmount = baseMs * jitterPercentage;
    return Math.floor(baseMs + (Math.random() * jitterAmount * 2) - jitterAmount);
}

function humanLikeDelay(minMs = 800, maxMs = 3000): number {
    const lambda = 1 / ((maxMs - minMs) / 3);
    const randomValue = -Math.log(1 - Math.random()) / lambda;
    return Math.min(Math.floor(minMs + randomValue * (maxMs - minMs)), maxMs);
}

async function humanTyping(page: Page, selector: string, text: string): Promise<void> {
    await page.click(selector);
    await delay(humanLikeDelay(200, 600));
    for (const char of text) {
        await page.keyboard.type(char, { delay: humanLikeDelay(40, 120) });
    }
}

// ── TwitterAI Class ──────────────────────────────────────────────────

export class TwitterAI {
    private browser: Browser | null = null;
    private page: Page | null = null;
    private username: string;
    private password: string;
    private cookiesPath: string;

    constructor() {
        this.username = process.env.TWITTER_BOT_USERNAME || '';
        this.password = process.env.TWITTER_BOT_PASSWORD || '';
        if (!this.username || !this.password) {
            throw new Error('Missing TWITTER_BOT_USERNAME or TWITTER_BOT_PASSWORD in .env');
        }
        this.cookiesPath = getCookiesPath(this.username);
    }

    // ── Public accessors ─────────────────────────────────────────────

    getPage(): Page | null {
        return this.page;
    }

    getBrowser(): Browser | null {
        return this.browser;
    }

    // ── Lifecycle ────────────────────────────────────────────────────

    async initialize(): Promise<void> {
        try {
            logger.info('[twitter] Initializing browser...', {
                component: 'Twitter', event: 'init',
            });

            // Ensure profile dir exists
            if (!fs.existsSync(TWITTER_PROFILE)) {
                fs.mkdirSync(TWITTER_PROFILE, { recursive: true });
            }

            this.browser = await puppeteer.launch({
                headless: HEADLESS,
                defaultViewport: null,
                executablePath: CHROME_PATH,
                userDataDir: TWITTER_PROFILE,
                protocolTimeout: 180_000,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-infobars',
                    '--disable-dev-shm-usage',
                    '--disable-gpu',
                    '--disable-notifications',
                    '--window-position=0,0',
                    '--window-size=1280,900',
                    '--ignore-certificate-errors',
                    '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
                ],
            });

            this.page = await this.browser.newPage();
            this.page.setDefaultNavigationTimeout(TWITTER_TIMEOUT);
            this.page.setDefaultTimeout(TWITTER_TIMEOUT);

            // Dismiss dialog popups (notification prompts, alerts)
            this.page.on('dialog', async (dialog) => {
                try {
                    logger.debug(`[twitter] Dialog dismissed: ${dialog.type()} — ${dialog.message()}`);
                    await dialog.dismiss();
                } catch (e) {
                    logger.debug(`[twitter] Dialog dismiss failed: ${formatError(e)}`);
                }
            });

            // Load cookies if available
            await this.loadCookies();

            // Attempt to navigate and check login state
            const loggedIn = await this.checkLoginState();
            if (!loggedIn) {
                logger.info('[twitter] Not logged in — starting login flow');
                const loginSuccess = await this.login();
                if (!loginSuccess) {
                    throw new Error('Twitter login failed');
                }
            }

            logger.info('[twitter] Browser initialized and logged in');
        } catch (error) {
            logger.error(`[twitter] Init failed: ${formatError(error)}`);
            throw error;
        }
    }

    async close(): Promise<void> {
        try {
            if (this.page) {
                await this.saveCookies();
            }
            if (this.browser) {
                await this.browser.close();
                this.browser = null;
                this.page = null;
                logger.info('[twitter] Browser closed');
            }
        } catch (error) {
            logger.error(`[twitter] Close error: ${formatError(error)}`);
            this.browser = null;
            this.page = null;
        }
    }

    async getFreshPage(): Promise<Page | null> {
        try {
            if (this.browser) {
                // Try reusing existing page
                try {
                    const pages = await this.browser.pages();
                    if (pages.length > 0) {
                        const existing = pages[0] as Page;
                        this.page = existing;
                        await existing.bringToFront();
                        return existing;
                    }
                } catch (e) {
                    logger.debug(`[twitter] Existing page reuse failed: ${formatError(e)}`);
                }

                // Create a new page
                try {
                    const newPage = await this.browser.newPage();
                    newPage.setDefaultNavigationTimeout(TWITTER_TIMEOUT);
                    newPage.setDefaultTimeout(TWITTER_TIMEOUT);
                    await newPage.setUserAgent(
                        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36'
                    );
                    this.page = newPage;
                    await this.loadCookies();
                    return newPage;
                } catch (e) {
                    logger.debug(`[twitter] New page creation failed: ${formatError(e)}`);
                }
            }

            // Browser dead — relaunch
            logger.info('[twitter] Browser died, relaunching...');
            await this.initialize();
            return this.page;
        } catch (e) {
            logger.error(`[twitter] Failed to get fresh page: ${formatError(e)}`);
            return null;
        }
    }

    // ── Cookie management ────────────────────────────────────────────

    private async loadCookies(): Promise<void> {
        if (!this.page) return;
        try {
            if (fs.existsSync(this.cookiesPath)) {
                const cookies = JSON.parse(fs.readFileSync(this.cookiesPath, 'utf8'));
                await this.page.setCookie(...cookies);
                logger.info('[twitter] Cookies loaded');
            }
        } catch (e) {
            logger.warn(`[twitter] Failed to load cookies: ${formatError(e)}`);
        }
    }

    private async saveCookies(): Promise<void> {
        if (!this.page) return;
        try {
            const dir = path.dirname(this.cookiesPath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            const cookies = await this.page.cookies();
            fs.writeFileSync(this.cookiesPath, JSON.stringify(cookies, null, 2));
            logger.info('[twitter] Cookies saved');
        } catch (e) {
            logger.warn(`[twitter] Failed to save cookies: ${formatError(e)}`);
        }
    }

    // ── Login state check ────────────────────────────────────────────

    private async checkLoginState(): Promise<boolean> {
        if (!this.page) return false;
        try {
            await this.page.goto('https://x.com/home', {
                waitUntil: 'domcontentloaded',
                timeout: TWITTER_TIMEOUT,
            });
            await delay(randomJitter(3000));

            const url = this.page.url();

            // If redirected to login page, we are not logged in
            if (url.includes('/i/flow/login') || url.includes('/login')) {
                return false;
            }

            // Check for home timeline indicators
            const isHome = await this.page.evaluate(() => {
                const composeBtn = document.querySelector('a[href="/compose/post"]') ||
                    document.querySelector('[data-testid="SideNav_NewTweet_Button"]');
                const homeLink = document.querySelector('a[data-testid="AppTabBar_Home_Link"]');
                return !!(composeBtn || homeLink);
            });

            if (isHome) {
                logger.info('[twitter] Already logged in (session restored)');
                return true;
            }

            return false;
        } catch (e) {
            logger.warn(`[twitter] Login state check failed: ${formatError(e)}`);
            return false;
        }
    }

    // ── Login flow ───────────────────────────────────────────────────

    private async login(): Promise<boolean> {
        if (!this.page) return false;

        try {
            logger.info('[twitter] Navigating to login page...');
            await this.page.goto('https://x.com/i/flow/login', {
                waitUntil: 'domcontentloaded',
                timeout: TWITTER_TIMEOUT,
            });
            await delay(randomJitter(3000));

            // ── Step 1: Enter username/email ──────────────────────────
            logger.info('[twitter] Waiting for username input...');
            // Twitter's input may have autocomplete="username" or placeholder text
            const usernameSelector = 'input[autocomplete="username"], input[name="text"], input[type="text"]';
            await this.page.waitForSelector(usernameSelector, { timeout: TWITTER_TIMEOUT });
            await delay(humanLikeDelay(500, 1200));

            // Use email for initial login (less likely to trigger blocks), fallback to username
            const loginIdentity = process.env.TWITTER_BOT_EMAIL || this.username;
            logger.info(`[twitter] Entering login identity: ${loginIdentity.slice(0, 4)}...`);
            await humanTyping(this.page, usernameSelector, loginIdentity);
            await delay(humanLikeDelay(400, 800));

            // Click "Next" button
            logger.info('[twitter] Clicking Next...');
            await this.clickNextButton();
            await delay(randomJitter(3000));

            // Check for "Could not log you in" error banner
            const loginBlocked = await this.page.evaluate(() => {
                const text = (document.body.innerText || '').toLowerCase();
                return text.includes('could not log you in') || text.includes('try again later');
            });
            if (loginBlocked) {
                logger.error('[twitter] Login blocked by Twitter — "Could not log you in now. Please try again later."');
                await this.page.screenshot({ path: screenshotPath('twitter-blocked.png'), fullPage: false }).catch(() => {});
                return false;
            }

            // ── Step 2: Handle unusual activity challenge ────────────
            // Twitter may show multiple challenge steps (email, then phone, etc.)
            for (let challengeAttempt = 0; challengeAttempt < 3; challengeAttempt++) {
                const challengeHandled = await this.handleUnusualActivityChallenge();
                if (challengeHandled) {
                    logger.info(`[twitter] Challenge step ${challengeAttempt + 1} handled`);
                    await delay(randomJitter(2000));
                } else {
                    break;
                }
            }

            // ── Step 3: Enter password ───────────────────────────────
            logger.info('[twitter] Waiting for password input...');
            const passwordSelector = 'input[type="password"]';
            // Take a screenshot to debug if password field is missing
            await this.page.screenshot({ path: screenshotPath('twitter-pre-password.png'), fullPage: false }).catch(() => {});
            await this.page.waitForSelector(passwordSelector, { timeout: TWITTER_TIMEOUT });
            await delay(humanLikeDelay(500, 1200));

            await humanTyping(this.page, passwordSelector, this.password);
            await delay(humanLikeDelay(400, 800));

            // Click "Log in"
            logger.info('[twitter] Clicking Log in...');
            await this.clickLoginButton();
            await delay(randomJitter(4000));

            // ── Step 4: Verify login success ─────────────────────────
            const success = await this.waitForHomeTimeline();
            if (success) {
                logger.info('[twitter] Login successful');
                await this.saveCookies();

                // Dismiss any "Turn on notifications" prompt
                await this.dismissNotificationPrompt();
                return true;
            }

            logger.error('[twitter] Login failed — home timeline not detected');
            return false;
        } catch (error) {
            logger.error(`[twitter] Login error: ${formatError(error)}`);
            return false;
        }
    }

    // ── Login helpers ────────────────────────────────────────────────

    private async clickNextButton(): Promise<void> {
        if (!this.page) return;

        const clicked = await this.page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll('button'));
            const nextBtn = buttons.find(b => b.textContent?.trim() === 'Next');
            if (nextBtn) {
                nextBtn.click();
                return true;
            }
            // Fallback: role=button with "Next" text
            const roleButtons = Array.from(document.querySelectorAll('[role="button"]'));
            const roleNext = roleButtons.find(b => b.textContent?.trim() === 'Next');
            if (roleNext) {
                (roleNext as HTMLElement).click();
                return true;
            }
            return false;
        });

        if (!clicked) {
            logger.debug('[twitter] Next button not found, pressing Enter');
            await this.page.keyboard.press('Enter');
        }
    }

    private async clickLoginButton(): Promise<void> {
        if (!this.page) return;

        const clicked = await this.page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll('button'));
            const loginBtn = buttons.find(b => {
                const text = b.textContent?.trim().toLowerCase();
                return text === 'log in' || text === 'login';
            });
            if (loginBtn) {
                loginBtn.click();
                return true;
            }
            const testIdBtn = document.querySelector('[data-testid="LoginForm_Login_Button"]');
            if (testIdBtn) {
                (testIdBtn as HTMLElement).click();
                return true;
            }
            return false;
        });

        if (!clicked) {
            logger.debug('[twitter] Login button not found, pressing Enter');
            await this.page.keyboard.press('Enter');
        }
    }

    private async handleUnusualActivityChallenge(): Promise<boolean> {
        if (!this.page) return false;

        try {
            // Check for the "unusual login activity" verification screen
            // This typically asks for email or phone to confirm identity
            const challengeInput = await this.page.$('input[data-testid="ocfEnterTextTextInput"]');
            if (!challengeInput) {
                const hasChallenge = await this.page.evaluate(() => {
                    const text = document.body.innerText || '';
                    return text.includes('unusual login activity') ||
                        text.includes('Enter your phone number or email') ||
                        text.includes('verify your identity') ||
                        text.includes('Enter your phone number or username');
                });
                if (!hasChallenge) return false;

                // Wait for the input to appear
                await this.page.waitForSelector('input[data-testid="ocfEnterTextTextInput"]', {
                    timeout: 5000,
                }).catch(() => null);
            }

            const input = await this.page.$('input[data-testid="ocfEnterTextTextInput"]');
            if (!input) return false;

            logger.warn('[twitter] Unusual activity challenge detected — entering verification');

            // Take a screenshot for debugging
            await this.page.screenshot({ path: screenshotPath('twitter-challenge.png'), fullPage: false }).catch(() => {});

            // Detect what the challenge is asking for
            const challengeText = await this.page.evaluate(() => (document.body.innerText || '').toLowerCase());
            let verificationValue: string;

            if (challengeText.includes('phone') && process.env.TWITTER_BOT_PHONE) {
                verificationValue = process.env.TWITTER_BOT_PHONE;
                logger.info('[twitter] Challenge asks for phone — using TWITTER_BOT_PHONE');
            } else if (challengeText.includes('email') && process.env.TWITTER_BOT_EMAIL) {
                verificationValue = process.env.TWITTER_BOT_EMAIL;
                logger.info('[twitter] Challenge asks for email — using TWITTER_BOT_EMAIL');
            } else {
                // Fallback: try email, then phone, then username
                verificationValue = process.env.TWITTER_BOT_EMAIL ||
                    process.env.TWITTER_BOT_PHONE ||
                    this.username;
                logger.info(`[twitter] Challenge type unclear — using fallback: ${verificationValue.slice(0, 4)}...`);
            }

            await delay(humanLikeDelay(500, 1000));
            await humanTyping(this.page, 'input[data-testid="ocfEnterTextTextInput"]', verificationValue);
            await delay(humanLikeDelay(300, 700));

            // Click "Next" to proceed past challenge
            await this.clickNextButton();
            await delay(randomJitter(2500));

            return true;
        } catch (e) {
            logger.debug(`[twitter] Challenge handling: ${formatError(e)}`);
            return false;
        }
    }

    private async waitForHomeTimeline(): Promise<boolean> {
        if (!this.page) return false;

        try {
            const maxWait = TWITTER_TIMEOUT;
            const checkInterval = 2000;
            let elapsed = 0;

            while (elapsed < maxWait) {
                const url = this.page.url();
                const isHome = await this.page.evaluate(() => {
                    const homeLink = document.querySelector('a[data-testid="AppTabBar_Home_Link"]');
                    const composeBtn = document.querySelector('a[href="/compose/post"]') ||
                        document.querySelector('[data-testid="SideNav_NewTweet_Button"]');
                    const timeline = document.querySelector('[data-testid="primaryColumn"]');
                    return !!(homeLink || composeBtn || timeline);
                });

                if (isHome || (url.includes('x.com/home') && !url.includes('login'))) {
                    return true;
                }

                await delay(checkInterval);
                elapsed += checkInterval;
            }

            return false;
        } catch (e) {
            logger.warn(`[twitter] Home timeline wait failed: ${formatError(e)}`);
            return false;
        }
    }

    private async dismissNotificationPrompt(): Promise<void> {
        if (!this.page) return;

        try {
            await delay(randomJitter(2000));

            // Twitter shows "Turn on notifications?" modal after login
            const dismissed = await this.page.evaluate(() => {
                const buttons = Array.from(document.querySelectorAll('button'));
                const dismissBtn = buttons.find(b => {
                    const text = b.textContent?.trim().toLowerCase() || '';
                    return text === 'not now' || text === 'maybe later' ||
                        text === 'skip for now' || text === 'dismiss';
                });
                if (dismissBtn) {
                    dismissBtn.click();
                    return true;
                }
                // Also try the close/X button on modals
                const closeBtn = document.querySelector('[data-testid="app-bar-close"]') as HTMLElement;
                if (closeBtn) {
                    closeBtn.click();
                    return true;
                }
                return false;
            });

            if (dismissed) {
                logger.debug('[twitter] Notification prompt dismissed');
            }
        } catch (e) {
            logger.debug(`[twitter] Notification prompt dismiss: ${formatError(e)}`);
        }
    }
}
