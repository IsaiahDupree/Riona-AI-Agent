/**
 * Browser Adapter
 * 
 * Provides a unified interface to use either Puppeteer (Chrome) or Playwright (Safari/WebKit).
 * This allows switching between browsers for different use cases.
 */

import { Browser as PuppeteerBrowser, Page as PuppeteerPage } from 'puppeteer';
import { Browser as PlaywrightBrowser, Page as PlaywrightPage, webkit, chromium, firefox } from 'playwright';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { logger } from '../utils/logger';
import dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';

dotenv.config();

// Setup puppeteer stealth
puppeteer.use(StealthPlugin());

export type BrowserType = 'chrome' | 'safari' | 'firefox';

export interface BrowserConfig {
    browserType: BrowserType;
    headless: boolean;
    userDataDir?: string;
    proxy?: string;
    slowMo?: number;
}

export interface UnifiedPage {
    goto(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<any>;
    $(selector: string): Promise<any>;
    $$(selector: string): Promise<any[]>;
    click(selector: string): Promise<void>;
    type(selector: string, text: string, options?: { delay?: number }): Promise<void>;
    waitForSelector(selector: string, options?: { timeout?: number; visible?: boolean }): Promise<any>;
    waitForNavigation(options?: { waitUntil?: string; timeout?: number }): Promise<any>;
    evaluate<T>(fn: (...args: any[]) => T, ...args: any[]): Promise<T>;
    cookies(): Promise<any[]>;
    setCookie(...cookies: any[]): Promise<void>;
    keyboard: {
        type(text: string, options?: { delay?: number }): Promise<void>;
        press(key: string): Promise<void>;
        down(key: string): Promise<void>;
        up(key: string): Promise<void>;
    };
    mouse: {
        click(x: number, y: number, options?: { clickCount?: number }): Promise<void>;
        move(x: number, y: number, options?: { steps?: number }): Promise<void>;
        down(): Promise<void>;
        up(): Promise<void>;
    };
    setDefaultTimeout(timeout: number): void;
    setDefaultNavigationTimeout(timeout: number): void;
    close(): Promise<void>;
    url(): string;
    content(): Promise<string>;
    screenshot(options?: { path?: string; fullPage?: boolean }): Promise<Buffer>;
    // Original page reference for advanced operations
    _rawPage: PuppeteerPage | PlaywrightPage;
    _browserType: BrowserType;
}

export interface UnifiedBrowser {
    newPage(): Promise<UnifiedPage>;
    close(): Promise<void>;
    browserType: BrowserType;
}

/**
 * Wrap a Puppeteer page to match our unified interface
 */
function wrapPuppeteerPage(page: PuppeteerPage): UnifiedPage {
    return {
        goto: async (url, options) => {
            const waitUntil = options?.waitUntil as any || 'networkidle0';
            return page.goto(url, { waitUntil, timeout: options?.timeout });
        },
        $: (selector) => page.$(selector),
        $$: (selector) => page.$$(selector),
        click: (selector) => page.click(selector),
        type: (selector, text, options) => page.type(selector, text, options),
        waitForSelector: (selector, options) => page.waitForSelector(selector, options as any),
        waitForNavigation: (options) => page.waitForNavigation(options as any),
        evaluate: (fn, ...args) => page.evaluate(fn, ...args),
        cookies: () => page.cookies(),
        setCookie: (...cookies) => page.setCookie(...cookies),
        keyboard: {
            type: (text, options) => page.keyboard.type(text, options),
            press: (key) => page.keyboard.press(key as any),
            down: (key) => page.keyboard.down(key as any),
            up: (key) => page.keyboard.up(key as any),
        },
        mouse: {
            click: (x, y, options) => page.mouse.click(x, y, options),
            move: (x, y, options) => page.mouse.move(x, y, options),
            down: () => page.mouse.down(),
            up: () => page.mouse.up(),
        },
        setDefaultTimeout: (timeout) => page.setDefaultTimeout(timeout),
        setDefaultNavigationTimeout: (timeout) => page.setDefaultNavigationTimeout(timeout),
        close: () => page.close(),
        url: () => page.url(),
        content: () => page.content(),
        screenshot: (options) => page.screenshot(options) as Promise<Buffer>,
        _rawPage: page,
        _browserType: 'chrome',
    };
}

/**
 * Wrap a Playwright page to match our unified interface
 */
function wrapPlaywrightPage(page: PlaywrightPage, browserType: BrowserType): UnifiedPage {
    return {
        goto: async (url, options) => {
            // Map Puppeteer's waitUntil to Playwright's
            let waitUntil: 'load' | 'domcontentloaded' | 'networkidle' | 'commit' = 'networkidle';
            if (options?.waitUntil === 'networkidle0' || options?.waitUntil === 'networkidle2') {
                waitUntil = 'networkidle';
            } else if (options?.waitUntil === 'domcontentloaded') {
                waitUntil = 'domcontentloaded';
            } else if (options?.waitUntil === 'load') {
                waitUntil = 'load';
            }
            return page.goto(url, { waitUntil, timeout: options?.timeout });
        },
        $: (selector) => page.$(selector),
        $$: (selector) => page.$$(selector),
        click: (selector) => page.click(selector),
        type: async (selector, text, options) => {
            await page.fill(selector, ''); // Clear first
            await page.type(selector, text, { delay: options?.delay });
        },
        waitForSelector: (selector, options) => page.waitForSelector(selector, { 
            timeout: options?.timeout,
            state: options?.visible ? 'visible' : 'attached'
        }),
        waitForNavigation: (options) => {
            let waitUntil: 'load' | 'domcontentloaded' | 'networkidle' | 'commit' = 'networkidle';
            if (options?.waitUntil === 'networkidle0' || options?.waitUntil === 'networkidle2') {
                waitUntil = 'networkidle';
            }
            return page.waitForLoadState(waitUntil, { timeout: options?.timeout });
        },
        evaluate: (fn, ...args) => page.evaluate(fn, ...args),
        cookies: async () => {
            const context = page.context();
            return context.cookies();
        },
        setCookie: async (...cookies) => {
            const context = page.context();
            await context.addCookies(cookies);
        },
        keyboard: {
            type: (text, options) => page.keyboard.type(text, { delay: options?.delay }),
            press: (key) => page.keyboard.press(key),
            down: (key) => page.keyboard.down(key),
            up: (key) => page.keyboard.up(key),
        },
        mouse: {
            click: (x, y, options) => page.mouse.click(x, y, { clickCount: options?.clickCount }),
            move: (x, y, options) => page.mouse.move(x, y, { steps: options?.steps }),
            down: () => page.mouse.down(),
            up: () => page.mouse.up(),
        },
        setDefaultTimeout: (timeout) => page.setDefaultTimeout(timeout),
        setDefaultNavigationTimeout: (timeout) => page.setDefaultNavigationTimeout(timeout),
        close: () => page.close(),
        url: () => page.url(),
        content: () => page.content(),
        screenshot: (options) => page.screenshot(options) as Promise<Buffer>,
        _rawPage: page,
        _browserType: browserType,
    };
}

/**
 * Launch a browser with the specified configuration
 */
async function launchBrowser(config: BrowserConfig): Promise<UnifiedBrowser> {
    const { browserType, headless, userDataDir, proxy, slowMo } = config;

    logger.info(`Launching ${browserType} browser`, {
        component: 'BrowserAdapter',
        event: 'launch_browser',
        browserType,
        headless
    });

    if (browserType === 'chrome') {
        // Use Puppeteer for Chrome (with stealth plugin)
        const browser = await puppeteer.launch({
            headless: headless,
            userDataDir,
            slowMo,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-infobars',
                '--window-position=0,0',
                '--ignore-certifcate-errors',
                '--ignore-certifcate-errors-spki-list',
                '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                '--start-maximized',
                ...(proxy ? [`--proxy-server=${proxy}`] : [])
            ]
        }) as PuppeteerBrowser;

        return {
            newPage: async () => {
                const page = await browser.newPage();
                return wrapPuppeteerPage(page);
            },
            close: () => browser.close(),
            browserType: 'chrome'
        };
    } else {
        // Use Playwright for Safari/Firefox
        const launchOptions = {
            headless,
            slowMo,
            proxy: proxy ? { server: proxy } : undefined,
        };

        let browser: PlaywrightBrowser;
        
        if (browserType === 'safari') {
            logger.info('Launching Safari/WebKit browser via Playwright');
            browser = await webkit.launch(launchOptions);
        } else if (browserType === 'firefox') {
            logger.info('Launching Firefox browser via Playwright');
            browser = await firefox.launch(launchOptions);
        } else {
            // Fallback to Chromium via Playwright
            browser = await chromium.launch(launchOptions);
        }

        return {
            newPage: async () => {
                const context = await browser.newContext({
                    userAgent: browserType === 'safari' 
                        ? 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'
                        : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    viewport: { width: 1920, height: 1080 },
                });
                const page = await context.newPage();
                return wrapPlaywrightPage(page, browserType);
            },
            close: () => browser.close(),
            browserType
        };
    }
}

/**
 * Get browser type from environment or default
 */
function getBrowserTypeFromEnv(): BrowserType {
    const envBrowser = process.env.BROWSER_TYPE?.toLowerCase();
    if (envBrowser === 'safari' || envBrowser === 'webkit') {
        return 'safari';
    } else if (envBrowser === 'firefox') {
        return 'firefox';
    }
    return 'chrome';
}

/**
 * Load cookies for a specific browser
 */
async function loadCookiesForBrowser(
    page: UnifiedPage, 
    cookiesPath: string
): Promise<boolean> {
    try {
        if (!fs.existsSync(cookiesPath)) {
            logger.info('No cookies file found', { cookiesPath });
            return false;
        }

        const cookiesString = fs.readFileSync(cookiesPath, 'utf8');
        const cookies = JSON.parse(cookiesString);

        // Playwright requires slightly different cookie format
        if (page._browserType !== 'chrome') {
            // Transform cookies for Playwright
            const transformedCookies = cookies.map((c: any) => ({
                name: c.name,
                value: c.value,
                domain: c.domain || '.instagram.com',
                path: c.path || '/',
                expires: c.expires || -1,
                httpOnly: c.httpOnly || false,
                secure: c.secure || true,
                sameSite: c.sameSite || 'None'
            }));
            await page.setCookie(...transformedCookies);
        } else {
            await page.setCookie(...cookies);
        }

        logger.info('Cookies loaded successfully', {
            component: 'BrowserAdapter',
            browserType: page._browserType,
            cookieCount: cookies.length
        });

        return true;
    } catch (error) {
        logger.error('Error loading cookies:', {
            error: error instanceof Error ? error.message : String(error),
            component: 'BrowserAdapter'
        });
        return false;
    }
}

/**
 * Save cookies from browser
 */
async function saveCookiesFromBrowser(
    page: UnifiedPage,
    cookiesPath: string
): Promise<void> {
    try {
        const cookies = await page.cookies();
        
        // Ensure directory exists
        const dir = path.dirname(cookiesPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        fs.writeFileSync(cookiesPath, JSON.stringify(cookies, null, 2));
        logger.info('Cookies saved', {
            component: 'BrowserAdapter',
            cookieCount: cookies.length
        });
    } catch (error) {
        logger.error('Error saving cookies:', {
            error: error instanceof Error ? error.message : String(error),
            component: 'BrowserAdapter'
        });
    }
}

export {
    launchBrowser,
    getBrowserTypeFromEnv,
    loadCookiesForBrowser,
    saveCookiesFromBrowser
};
