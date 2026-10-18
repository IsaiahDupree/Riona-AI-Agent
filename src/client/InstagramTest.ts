import { Browser, DEFAULT_INTERCEPT_RESOLUTION_PRIORITY } from "puppeteer";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import AdblockerPlugin from "puppeteer-extra-plugin-adblocker";
import { Server } from "proxy-chain";
import logger from "../config/logger";
import { Instagram_cookiesExist, loadCookies, saveCookies } from "../utils";
import dotenv from 'dotenv';

// Load environment variables
dotenv.config({ override: true });

// Add stealth plugin to puppeteer
puppeteer.use(StealthPlugin());
puppeteer.use(AdblockerPlugin({
    interceptResolutionPriority: DEFAULT_INTERCEPT_RESOLUTION_PRIORITY,
}));

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function runInstagramTest() {
    try {
        // Check environment variables first
        const utils = require('../utils');
        await utils.checkRequiredEnvVars();

        // Get credentials from environment variables
        const username = process.env.INSTAGRAM_BOT_USERNAME;
        const password = process.env.INSTAGRAM_BOT_PASSWORD;

        if (!username || !password) {
            throw new Error('Instagram credentials not found in environment variables');
        }

        const proxyPort = process.env.INSTAGRAM_PROXY_PORT || '9000';
        const server = new Server({ port: parseInt(proxyPort) });
        await server.listen();
        const proxyUrl = `http://localhost:${proxyPort}`;

        const browser = await puppeteer.launch({
            headless: false,
            args: [`--proxy-server=${proxyUrl}`],
        });

        const page = await browser.newPage();
        const cookiesPath = "./cookies/Instagramcookies.json";
        const checkCookies = await Instagram_cookiesExist(cookiesPath);
        logger.info(`Checking cookies existence: ${checkCookies}`);

        if (checkCookies) {
            const cookies = await loadCookies(cookiesPath);
            await page.setCookie(...cookies);
            logger.info('Cookies loaded and set on the page.');
            await page.goto("https://www.instagram.com/", { waitUntil: 'networkidle2' });
            const isLoggedIn = await page.$("a[href='/direct/inbox/']");
            if (isLoggedIn) {
                logger.info("Login verified with cookies.");
            } else {
                logger.warn("Cookies invalid or expired. Logging in again...");
                await loginWithCredentials(page, username, password, cookiesPath);
            }
        } else {
            await loginWithCredentials(page, username, password, cookiesPath);
        }

        // Navigate to home feed and test like button interactions
        await testLikeButtonInteractions(page);

        await browser.close();
        await server.close(true);
    } catch (error) {
        logger.error("Error running Instagram test:", error);
    }
}

async function loginWithCredentials(page: any, username: string, password: string, cookiesPath: string) {
    try {
        await page.goto("https://www.instagram.com/accounts/login/");
        await page.waitForSelector('input[name="username"]');
        await page.type('input[name="username"]', username);
        await page.type('input[name="password"]', password);
        await page.click('button[type="submit"]');
        await page.waitForNavigation();
        const cookies = await page.cookies();
        await saveCookies(cookiesPath, cookies);
    } catch (error) {
        logger.error("Error logging in with credentials:", error);
        throw error;
    }
}

async function testLikeButtonInteractions(page: any) {
    try {
        logger.info('Starting like button interaction tests...');
        
        // Navigate to home feed
        await page.goto('https://www.instagram.com/', { 
            waitUntil: 'networkidle2',
            timeout: 30000
        });
        
        // Wait for posts to load
        await page.waitForSelector('article', { visible: true, timeout: 10000 });
        logger.info('Posts loaded successfully');

        // Get first post
        const post = await page.$('article');
        if (!post) {
            throw new Error('No posts found');
        }

        // Test different Puppeteer click methods
        const clickMethods = [
            {
                name: 'Method 1: ElementHandle.click()',
                async execute() {
                    const likeButton = await post.$('svg[aria-label="Like"]');
                    if (likeButton) {
                        await likeButton.click();
                        return true;
                    }
                    return false;
                }
            },
            {
                name: 'Method 2: page.click() with selector',
                async execute() {
                    const result = await page.click('article svg[aria-label="Like"]');
                    return true;
                }
            },
            {
                name: 'Method 3: Mouse click with coordinates',
                async execute() {
                    const likeButton = await post.$('svg[aria-label="Like"]');
                    if (likeButton) {
                        const box = await likeButton.boundingBox();
                        if (box) {
                            await page.mouse.move(box.x + box.width/2, box.y + box.height/2);
                            await page.mouse.down();
                            await delay(100);
                            await page.mouse.up();
                            return true;
                        }
                    }
                    return false;
                }
            },
            {
                name: 'Method 4: Click parent button',
                async execute() {
                    const likeButton = await post.$('button:has(svg[aria-label="Like"])');
                    if (likeButton) {
                        await likeButton.click({ delay: 100 });
                        return true;
                    }
                    return false;
                }
            },
            {
                name: 'Method 5: JavaScript click via evaluate',
                async execute() {
                    const clicked = await post.evaluate((el: HTMLElement) => {
                        const likeBtn = el.querySelector('button:has(svg[aria-label="Like"])') as HTMLButtonElement;
                        if (likeBtn) {
                            likeBtn.click();
                            return true;
                        }
                        return false;
                    });
                    return clicked;
                }
            },
            {
                name: 'Method 6: Trusted click event',
                async execute() {
                    const clicked = await post.evaluate((el: HTMLElement) => {
                        const likeBtn = el.querySelector('button:has(svg[aria-label="Like"])') as HTMLButtonElement;
                        if (likeBtn) {
                            const clickEvent = new MouseEvent('click', {
                                view: window,
                                bubbles: true,
                                cancelable: true,
                                buttons: 1
                            });
                            likeBtn.dispatchEvent(clickEvent);
                            return true;
                        }
                        return false;
                    });
                    return clicked;
                }
            }
        ];

        for (const method of clickMethods) {
            try {
                logger.info(`Testing ${method.name}...`);
                
                // First ensure we're starting with an unliked post
                const unlikeButton = await post.$('svg[aria-label="Unlike"]');
                if (unlikeButton) {
                    await unlikeButton.click();
                    await delay(2000);
                }

                // Execute the click method
                const success = await method.execute();
                await delay(2000);

                // Verify if the like was successful
                const isLiked = await post.$('svg[aria-label="Unlike"]');
                
                logger.info(`${method.name} results:`, {
                    clickExecuted: success,
                    likeVerified: !!isLiked
                });

                // Add a delay between methods
                await delay(3000);

            } catch (error: any) {
                logger.error(`Error with ${method.name}:`, error.message);
            }
        }

        logger.info('Like button interaction tests completed');

    } catch (error: any) {
        logger.error('Error in like button interaction tests:', error.message);
        throw error;
    }
}

export { runInstagramTest };
