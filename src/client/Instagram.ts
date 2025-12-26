import { Browser, DEFAULT_INTERCEPT_RESOLUTION_PRIORITY } from "puppeteer";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
// Temporarily disable AdBlocker plugin due to network timeout issues
// import AdblockerPlugin from 'puppeteer-extra-plugin-adblocker';
import UserAgent from "user-agents";
import { Server } from "proxy-chain";
import logger from "../config/logger";
import { Instagram_cookiesExist, loadCookies, saveCookies } from "../utils";
import { getInstagramCommentSchema } from "../Agent/schema";
import { join } from 'path';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'fs';

// Add stealth plugin to puppeteer
puppeteer.use(StealthPlugin());

// Temporarily disable AdBlocker plugin due to network timeout issues
// puppeteer.use(AdblockerPlugin({...}));

// Add utility functions for jitter and randomization
function randomJitter(baseMs: number, jitterPercentage = 0.3): number {
    // Add random jitter within +/- percentage of the base value
    const jitterAmount = baseMs * jitterPercentage;
    return Math.floor(baseMs + (Math.random() * jitterAmount * 2) - jitterAmount);
}

function humanLikeDelay(minMs = 800, maxMs = 3000): number {
    // More realistic human timing follows an exponential distribution
    // biased toward shorter delays but with occasional longer pauses
    const lambda = 1 / ((maxMs - minMs) / 3); // Shape parameter
    const randomValue = -Math.log(1 - Math.random()) / lambda;
    return Math.min(Math.floor(minMs + randomValue * (maxMs - minMs)), maxMs);
}

async function humanTyping(page: any, selector: string, text: string): Promise<void> {
    // Type like a human with variable delays between characters
    await page.waitForSelector(selector, { visible: true, timeout: 10000 });
    
    // Clear the field first if needed
    await page.evaluate((sel: string) => {
        document.querySelector(sel)?.setAttribute('value', '');
    }, selector);
    
    // Click into the field
    await page.click(selector);
    await delay(randomJitter(500, 0.4));
    
    // Type with variable speed
    const avgDelay = Math.random() < 0.7 ? 
        randomJitter(100, 0.3) : // Normal typing (70% of the time)
        randomJitter(250, 0.5);  // Slow typing (30% of the time)
    
    for (let i = 0; i < text.length; i++) {
        // Occasionally pause longer as if thinking
        if (Math.random() < 0.1 && i > 3) {
            await delay(humanLikeDelay(500, 2000));
        }
        
        // Type the character with variable speed
        await page.keyboard.type(text[i], { delay: randomJitter(avgDelay, 0.5) });
        
        // Occasionally make a typo and correct it (about 5% chance per character)
        if (Math.random() < 0.05 && i < text.length - 2) {
            // Type a random wrong character
            const wrongChar = String.fromCharCode(97 + Math.floor(Math.random() * 26));
            await page.keyboard.type(wrongChar, { delay: randomJitter(avgDelay, 0.3) });
            await delay(randomJitter(300, 0.3));
            
            // Delete the wrong character
            await page.keyboard.press('Backspace');
            await delay(randomJitter(400, 0.4));
        }
    }
}

// Add natural mouse movement function
async function naturalMouseMovement(page: any, targetSelector: string): Promise<void> {
    try {
        const target = await page.$(targetSelector);
        if (!target) {
            throw new Error(`Target element not found: ${targetSelector}`);
        }
        
        // Get the bounding box of the target element
        const box = await target.boundingBox();
        if (!box) {
            throw new Error(`Could not get bounding box for ${targetSelector}`);
        }
        
        // Get the current mouse position or use a default starting point
        const currentPosition = await page.evaluate(() => {
            return { x: window.innerWidth / 2, y: window.innerHeight / 3 };
        });
        
        // Calculate target center
        const targetX = box.x + box.width / 2;
        const targetY = box.y + box.height / 2;
        
        // Generate a slightly curved path with variable speed
        const points = generateCurvedPath(
            currentPosition.x, currentPosition.y,
            targetX, targetY,
            Math.random() < 0.7 ? 0.5 : 1.5 // Occasionally use more curve
        );
        
        // Move through the points with variable timing
        for (let i = 0; i < points.length; i++) {
            const point = points[i];
            
            // Determine speed based on position in the curve
            // Slow at beginning, faster in middle, slower at end
            let stepDelay = 12; // Base delay in ms
            
            if (i < points.length * 0.2 || i > points.length * 0.8) {
                // Slower at start and end
                stepDelay = randomJitter(20, 0.4);
            } else {
                // Faster in the middle
                stepDelay = randomJitter(8, 0.3);
            }
            
            // Move to the next point
            await page.mouse.move(point.x, point.y);
            await delay(stepDelay);
        }
        
        // Hover briefly before clicking
        await delay(humanLikeDelay(200, 600));
        
        // Randomize click type (normal vs double)
        if (Math.random() < 0.05) {
            // Occasional double-click (5% chance)
            await page.mouse.click(targetX, targetY, { clickCount: 2 });
        } else {
            // Standard click with random delay before releasing
            await page.mouse.down();
            await delay(randomJitter(50, 0.8));
            await page.mouse.up();
        }
        
        return;
    } catch (error) {
        logger.warn(`Natural mouse movement failed, falling back to direct click: ${error}`);
        await page.click(targetSelector);
    }
}

// Helper function to generate points along a curved path
function generateCurvedPath(startX: number, startY: number, endX: number, endY: number, curvature: number = 1): Array<{x: number, y: number}> {
    const points: Array<{x: number, y: number}> = [];
    const numPoints = Math.floor(randomJitter(25, 0.4)); // Variable number of points
    
    // Control point offset for bezier curve
    const midX = (startX + endX) / 2;
    const midY = (startY + endY) / 2;
    const distance = Math.sqrt(Math.pow(endX - startX, 2) + Math.pow(endY - startY, 2));
    
    // Random offset perpendicular to the direct path
    const perpX = -(endY - startY);
    const perpY = endX - startX;
    const perpLength = Math.sqrt(perpX * perpX + perpY * perpY);
    
    // Normalize and scale by curvature and distance
    const cpOffsetX = (perpX / perpLength) * distance * 0.3 * curvature;
    const cpOffsetY = (perpY / perpLength) * distance * 0.3 * curvature;
    
    // Add some randomness to the control point
    const ctrlX = midX + cpOffsetX * (Math.random() * 0.4 + 0.8);
    const ctrlY = midY + cpOffsetY * (Math.random() * 0.4 + 0.8);
    
    for (let i = 0; i <= numPoints; i++) {
        const t = i / numPoints;
        
        // Quadratic bezier curve formula
        const x = Math.pow(1 - t, 2) * startX + 
                  2 * (1 - t) * t * ctrlX + 
                  Math.pow(t, 2) * endX;
                  
        const y = Math.pow(1 - t, 2) * startY + 
                  2 * (1 - t) * t * ctrlY + 
                  Math.pow(t, 2) * endY;
                  
        points.push({ x, y });
    }
    
    return points;
}

// Add jitter to scrolling
async function naturalScroll(page: any, distance: number): Promise<void> {
    // Scroll with variable speed and small pauses
    const steps = Math.floor(randomJitter(15, 0.4));
    const stepSize = distance / steps;
    
    let accumulatedDistance = 0;
    
    for (let i = 0; i < steps; i++) {
        // Variable step size to simulate acceleration and deceleration
        let multiplier = 1;
        
        if (i < steps * 0.2) {
            // Start slower (acceleration)
            multiplier = 0.5 + (i / (steps * 0.2)) * 0.5;
        } else if (i > steps * 0.8) {
            // End slower (deceleration)
            multiplier = 1 - ((i - steps * 0.8) / (steps * 0.2)) * 0.5;
        }
        
        const thisStepSize = stepSize * multiplier;
        accumulatedDistance += thisStepSize;
        
        // Scroll the step
        await page.evaluate((scrollAmount: number) => {
            window.scrollBy(0, scrollAmount);
        }, thisStepSize);
        
        // Variable delay between scrolls
        await delay(randomJitter(30, 0.5));
        
        // Occasionally pause during scrolling as humans do
        if (Math.random() < 0.2) {
            await delay(humanLikeDelay(200, 1000));
        }
    }
    
    // Account for any rounding errors by scrolling the remaining distance
    const remaining = distance - accumulatedDistance;
    if (Math.abs(remaining) > 1) {
        await page.evaluate((scrollAmount: number) => {
            window.scrollBy(0, scrollAmount);
        }, remaining);
    }
    
    // Pause briefly after scrolling completes
    await delay(humanLikeDelay(300, 800));
}

// Enhanced random delay function
async function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

interface PostInteraction {
    postIndex: number;
    timestamp: string;
    caption: string;
    likeMethod: string | null;
    commentMethod: string | null;
    commentText: string | null;
    success: boolean;
    details: string;
}

const postInteractions: PostInteraction[] = [];

async function getPostCaption(post: any): Promise<string> {
    try {
        // First try to find and expand "more" button with multiple selector approaches
        try {
            // Try different approaches to find and click the "more" button
            const moreButtonSelectors = [
                // Using attribute selectors instead of :has-text
                'div[role="button"][aria-label*="more"]',
                'div[role="button"]:not([aria-disabled="true"])',
                'span[role="button"]',
                // Using classes that often contain "more" text
                'div._ab8w._ab94._ab97._ab9h._ab9k._ab9p._abcm',
                // Find by common text content
                'div._a9zr div:not(:empty)'
            ];
            
            // Try each selector
            for (const selector of moreButtonSelectors) {
                try {
                    const buttons = await post.$$(selector);
                    for (const button of buttons) {
                        // Check if this element contains "more" text
                        const buttonText = await button.evaluate((el: any) => el.textContent || '');
                        if (buttonText.toLowerCase().includes('more')) {
                            await button.click();
                            await delay(randomJitter(2000, 0.3));
                            logger.info('Successfully expanded caption with "more" button');
                            break;
                        }
                    }
                } catch (buttonError) {
                    // Continue to next selector
                }
            }
        } catch (moreError: unknown) {
            logger.debug('Could not find or click "more" button:', moreError instanceof Error ? moreError.message : String(moreError));
            // Continue to caption extraction
        }

        // Enhanced selector list for caption extraction
        const selectors = [
            'h1:first-of-type', // Main heading
            'div._a9zs', // Instagram caption class
            'div[data-testid="post-title"]', // Post title
            'div.C4VMK span', // Another common caption location
            'span._aacl._aaco._aacu._aacx._aad7._aade', // Current Instagram caption class
            'article div._a9zs', // Article caption
            'div._ae5q._ae5r._ae5s', // Another caption container
            'div[class*="caption"] span', // Any div with "caption" in class name
            'ul._a9z6._a9za li._a9zc span', // List-based captions
            'div._a9zs span._aacl._aaco._aacu._aacx._aad7._aade', // Nested spans in caption div
        ];

        // Try each selector in the list
        if (Array.isArray(selectors)) {
            for (const selector of selectors) {
                try {
                    const element = await post.$(selector);
                    if (element) {
                        const text = await element.evaluate((el: HTMLElement) => el.textContent);
                        if (text && text.trim()) {
                            return text.trim();
                        }
                    }
                } catch (selectorError) {
                    // Continue to next selector
                }
            }
        }

        // Fallback method: try to extract text from the post's article element
        try {
            const article = await post.$('article');
            if (article) {
                const articleText = await article.evaluate((el: HTMLElement) => {
                    // Get all text nodes in the article
                    const walker = document.createTreeWalker(
                        el,
                        NodeFilter.SHOW_TEXT,
                        null
                    );
                    
                    const textNodes = [];
                    let node;
                    while (node = walker.nextNode()) {
                        if (node.textContent && node.textContent.trim().length > 10) {
                            textNodes.push(node.textContent.trim());
                        }
                    }
                    
                    // Return the longest text (likely to be the caption)
                    return textNodes.sort((a, b) => b.length - a.length)[0] || '';
                });
                
                if (articleText && articleText.trim()) {
                    return articleText.trim();
                }
            }
        } catch (articleError: unknown) {
            logger.debug('Error extracting from article element:', articleError instanceof Error ? articleError.message : String(articleError));
        }

        logger.warn('No caption found with any selector');
        return 'No caption found';
    } catch (error: unknown) {
        logger.warn('Error getting post caption:', error instanceof Error ? error.message : String(error));
        return 'Error getting caption';
    }
}

async function logInteraction(interaction: PostInteraction) {
    postInteractions.push(interaction);
    logger.info('Post Interaction Log:', interaction);
    
    // Save to a JSON file
    try {
        const logPath = join(process.cwd(), 'logs');
        if (!existsSync(logPath)) {
            mkdirSync(logPath, { recursive: true });
        }
        
        const logFile = join(logPath, 'post_interactions.json');
        writeFileSync(logFile, JSON.stringify(postInteractions, null, 2));
    } catch (error: unknown) {
        logger.error('Error saving interaction log:', error instanceof Error ? error.message : String(error));
    }
}

async function generateInteractionReport() {
    if (postInteractions.length === 0) {
        return 'No interactions recorded yet.';
    }

    const likeMethodStats: { [key: string]: number } = {};
    const commentMethodStats: { [key: string]: number } = {};
    let totalLikes = 0;
    let totalComments = 0;

    postInteractions.forEach(interaction => {
        if (interaction.likeMethod) {
            likeMethodStats[interaction.likeMethod] = (likeMethodStats[interaction.likeMethod] || 0) + 1;
            totalLikes++;
        }
        if (interaction.commentMethod) {
            commentMethodStats[interaction.commentMethod] = (commentMethodStats[interaction.commentMethod] || 0) + 1;
            totalComments++;
        }
    });

    let report = '## Instagram Interaction Report\n\n';
    
    report += '### Overall Statistics\n';
    report += `- Total Posts Processed: ${postInteractions.length}\n`;
    report += `- Successful Likes: ${totalLikes}\n`;
    report += `- Successful Comments: ${totalComments}\n\n`;

    report += '### Like Method Success Rates\n';
    Object.entries(likeMethodStats).forEach(([method, count]) => {
        const percentage = ((count / totalLikes) * 100).toFixed(1);
        report += `- ${method}: ${count} successes (${percentage}%)\n`;
    });

    report += '\n### Comment Method Success Rates\n';
    Object.entries(commentMethodStats).forEach(([method, count]) => {
        const percentage = ((count / totalComments) * 100).toFixed(1);
        report += `- ${method}: ${count} successes (${percentage}%)\n`;
    });

    report += '\n### Recent Interactions\n';
    postInteractions.slice(-5).forEach(interaction => {
        report += `\n#### Post ${interaction.postIndex} (${interaction.timestamp})\n`;
        report += `- Caption: ${interaction.caption.substring(0, 100)}${interaction.caption.length > 100 ? '...' : ''}\n`;
        report += `- Like Method: ${interaction.likeMethod || 'Failed'}\n`;
        report += `- Comment Method: ${interaction.commentMethod || 'Failed'}\n`;
        if (interaction.commentText) {
            report += `- Comment: ${interaction.commentText}\n`;
        }
        report += `- Details: ${interaction.details}\n`;
    });

    return report;
}

async function runInstagram() {
    let browser: Browser | null = null;
    let proxyServer: Server | null = null;
    let useProxy = process.env.INSTAGRAM_USE_PROXY === 'true';
    let retryCount = 0;
    const maxRetries = 3;

    try {
        // Load environment variables with detailed logging
        const username = process.env.INSTAGRAM_BOT_USERNAME;
        const password = process.env.INSTAGRAM_BOT_PASSWORD;
        const proxyPort = process.env.INSTAGRAM_PROXY_PORT || '9000';
        const proxyHost = process.env.INSTAGRAM_PROXY_HOST || 'localhost';

        logger.info('Checking environment variables...');
        if (!username || !password) {
            throw new Error('Missing required environment variables: ' + 
                (!username ? 'INSTAGRAM_BOT_USERNAME ' : '') + 
                (!password ? 'INSTAGRAM_BOT_PASSWORD' : ''));
        }

        logger.info(`Starting Instagram bot for account: ${username}`);
        
        // Main retry loop for handling connection issues
        while (retryCount <= maxRetries) {
            try {
                // Only use proxy if enabled
                if (useProxy) {
                    logger.info(`Using proxy ${proxyHost}:${proxyPort}`);
                    
                    // Start proxy server
                    logger.info(`Starting proxy server on ${proxyHost}:${proxyPort}...`);
                    proxyServer = new Server({ port: parseInt(proxyPort), host: proxyHost });
                    await proxyServer.listen();
                    logger.info('Proxy server started successfully');
                } else {
                    logger.info('Running without proxy');
                }

                // Ensure cookies directory exists
                const cookiesDir = join(process.cwd(), 'cookies');
                if (!existsSync(cookiesDir)) {
                    logger.info('Creating cookies directory...');
                    mkdirSync(cookiesDir, { recursive: true });
                }
                
                const cookiesPath = join(cookiesDir, `Instagram_${username}_cookies.json`);

                const proxyUrl = useProxy ? `http://${proxyHost}:${proxyPort}` : undefined;

                // Launch browser with improved settings
                logger.info('Launching browser...');
                const launchArgs = [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-web-security',
                    '--disable-features=IsolateOrigins,site-per-process',
                    '--disable-site-isolation-trials',
                    '--window-size=1920,1080',
                    '--start-maximized',
                    '--disable-notifications',
                    '--ignore-certificate-errors',
                    '--lang=en-US,en'
                ];
                
                // Only add proxy if enabled
                if (useProxy && proxyUrl) {
                    launchArgs.push(`--proxy-server=${proxyUrl}`);
                }
                
                browser = await puppeteer.launch({
                    headless: false,
                    defaultViewport: null,
                    args: launchArgs,
                    ignoreHTTPSErrors: true
                });

                const page = await browser.newPage();
                
                // Set a realistic user agent (avoid detection)
                const userAgentString = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
                await page.setUserAgent(userAgentString);
                
                // Set extra HTTP headers to appear more like a normal browser
                await page.setExtraHTTPHeaders({
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                    'Connection': 'keep-alive',
                    'Upgrade-Insecure-Requests': '1'
                });
                
                // Execute JavaScript to mask automation fingerprints
                await page.evaluateOnNewDocument(() => {
                    // Overwrite navigator properties to appear as a normal browser
                    Object.defineProperty(navigator, 'webdriver', { get: () => false });
                    
                    // Add fake plugins array to appear more like a real browser
                    const pluginArray = [
                        { description: "Portable Document Format", filename: "internal-pdf-viewer", name: "Chrome PDF Plugin" },
                        { description: "", filename: "mhjfbmdgcfjbbpaeojofohoefgiehjai", name: "Chrome PDF Viewer" },
                        { description: "", filename: "internal-nacl-plugin", name: "Native Client" }
                    ];
                    Object.defineProperty(navigator, 'plugins', { 
                        get: () => pluginArray,
                        enumerable: true,
                        configurable: true
                    });
                    
                    // Mask Chrome automation indicators - use any type to bypass TypeScript checks
                    const chrome: any = window.chrome || {};
                    window.chrome = {
                        ...chrome,
                        runtime: chrome.runtime || {},
                        // Add typical Chrome browser properties
                        loadTimes: function() { 
                            return {
                                firstPaintTime: Date.now(),
                                firstPaintAfterLoadTime: Date.now(),
                                navigationType: "Other",
                                requestTime: Date.now() - 100,
                                startLoadTime: Date.now() - 100,
                                commitLoadTime: Date.now() - 50,
                                finishDocumentLoadTime: Date.now() - 50,
                                finishLoadTime: Date.now() - 40,
                                firstPaintCacheTime: 0
                            };
                        },
                        csi: function() { 
                            return {
                                onloadT: Date.now(),
                                pageT: Date.now(),
                                startE: Date.now(),
                                tran: 15
                            };
                        }
                    };
                    
                    // Hide automation flags
                    Object.defineProperty(navigator, 'permissions', {
                        value: {
                            query: async () => ({
                                state: "prompt",
                                status: "prompt",
                            }),
                        },
                    });
                    
                    // Add missing navigator functions and properties
                    if (!navigator.languages) {
                        Object.defineProperty(navigator, 'languages', {
                            get: () => ['en-US', 'en'],
                            enumerable: true,
                        });
                    }
                });

                logger.info('Browser launched successfully');

                // Check for existing cookies
                if (await Instagram_cookiesExist(cookiesPath)) {
                    logger.info('Found existing cookies, attempting to use them...');
                    try {
                        const cookies = await loadCookies(cookiesPath);
                        await page.setCookie(...cookies);
                        logger.info('Cookies loaded successfully');

                        // Verify login status with improved navigation approach and error handling
                        let navigationSuccess = false;
                        try {
                            // Set a very short timeout for detecting ERR_ABORTED quickly
                            await page.goto('https://www.instagram.com/', { 
                                waitUntil: 'domcontentloaded',
                                timeout: 15000
                            });
                            navigationSuccess = true;
                        } catch (navError: unknown) {
                            // Check specifically for ERR_ABORTED errors
                            if (navError instanceof Error && navError.message && navError.message.includes('net::ERR_ABORTED')) {
                                logger.error('Navigation aborted - cookies appear to be invalid');
                                await deleteCookies(cookiesPath);
                                logger.info('Proceeding with credential login after cookie failure...');
                                await loginWithCredentials(page, username, password, cookiesPath);
                                return;
                            } else {
                                logger.warn('Navigation error, retrying with different settings:', navError instanceof Error ? navError.message : String(navError));
                                try {
                                    await page.goto('https://www.instagram.com/', { 
                                        waitUntil: 'load',
                                        timeout: 30000
                                    });
                                    navigationSuccess = true;
                                } catch (retryError: unknown) {
                                    logger.error('Retry navigation failed, falling back to credentials');
                                    await deleteCookies(cookiesPath);
                                    await loginWithCredentials(page, username, password, cookiesPath);
                                    return;
                                }
                            }
                        }
                        
                        if (navigationSuccess) {
                            // Wait for page to render properly
                            await delay(3000);
                            
                            // Check if login was successful by looking for elements that only appear when logged in
                            const isLoggedIn = await Promise.race([
                                page.waitForSelector('svg[aria-label="Home"]', { timeout: 5000 })
                                    .then(() => true)
                                    .catch(() => false),
                                page.waitForSelector('input[name="username"]', { timeout: 5000 })
                                    .then(() => false)
                                    .catch(() => true),
                                new Promise(resolve => setTimeout(() => resolve(false), 6000))
                            ]);

                            if (isLoggedIn) {
                                logger.info('Successfully logged in with cookies');
                            } else {
                                logger.warn('Cookie login failed (no login indicators found), proceeding with credentials');
                                await deleteCookies(cookiesPath);
                                await loginWithCredentials(page, username, password, cookiesPath);
                            }
                        }
                    } catch (error: unknown) {
                        logger.error('Error using cookies:', error instanceof Error ? error.message : String(error));
                        logger.info('Proceeding with credential login after error...');
                        // Delete the invalid cookies before attempting credential login
                        await deleteCookies(cookiesPath);
                        await loginWithCredentials(page, username, password, cookiesPath);
                    }
                } else {
                    logger.info('No existing cookies found, logging in with credentials...');
                    await loginWithCredentials(page, username, password, cookiesPath);
                }

                // Run the main interaction loop
                logger.info('Starting post interactions...');
                await interactWithPosts(page);
                logger.info('Post interactions completed successfully');

                // Exit the retry loop
                break;
            } catch (error: unknown) {
                logger.error('Error in Instagram bot:', error instanceof Error ? error.message : String(error));
                if (error instanceof Error && error.stack) {
                    logger.error('Stack trace:', error.stack);
                }
                retryCount++;
                logger.info(`Retry ${retryCount}/${maxRetries}...`);
                await delay(5000);
            }
        }

        // If we've reached this point, we've exceeded the maximum retries
        if (retryCount > maxRetries) {
            throw new Error('Maximum retries exceeded');
        }

    } catch (error: unknown) {
        logger.error('Error in Instagram bot:', error instanceof Error ? error.message : String(error));
        if (error instanceof Error && error.stack) {
            logger.error('Stack trace:', error.stack);
        }
        
        // If we had a connection error related to empty response, toggle proxy setting
        if (error instanceof Error && error.message && error.message.includes('ERR_EMPTY_RESPONSE')) {
            logger.warn('Empty response error detected in main execution loop');
            const currentProxySetting = process.env.INSTAGRAM_USE_PROXY === 'true';
            logger.info(`Current proxy setting: ${currentProxySetting ? 'enabled' : 'disabled'}`);
            process.env.INSTAGRAM_USE_PROXY = currentProxySetting ? 'false' : 'true';
            logger.info(`Updated proxy setting for next attempt: ${!currentProxySetting ? 'enabled' : 'disabled'}`);
        }
        
        throw error;
    } finally {
        logger.info('Closing browser...');
        if (browser) {
            try {
                await browser.close();
            } catch (closeError: unknown) {
                logger.error('Error closing browser:', closeError instanceof Error ? closeError.message : String(closeError));
            }
        }
        
        logger.info('Stopping proxy server...');
        if (proxyServer) {
            try {
                await proxyServer.close(true);
            } catch (proxyError: unknown) {
                logger.error('Error stopping proxy server:', proxyError instanceof Error ? proxyError.message : String(proxyError));
            }
        }
        
        // Ensure that request interception is disabled
        try {
            if (browser && browser.pages) {
                const pages = await browser.pages();
                for (const page of pages) {
                    if (page) {
                        try {
                            await page.setRequestInterception(false);
                        } catch (e: unknown) {
                            // Ignore errors when cleaning up
                        }
                    }
                }
            }
        } catch (e: unknown) {
            // Ignore errors during cleanup
        }
        
        logger.info('Instagram bot cleanup completed');
    }
}

async function loginWithCredentials(page: any, username: string, password: string, cookiesPath: string): Promise<boolean> {
    try {
        logger.info('Starting login process with credentials...');
        
        // Add cookie consent banner handling
        try {
            // Test connection before attempting login - helps identify IP blocking early
            logger.info('Testing connection before login...');
            await page.goto('https://www.instagram.com/robots.txt', { 
                waitUntil: 'domcontentloaded',
                timeout: randomJitter(8000, 0.2)
            });
            await delay(humanLikeDelay(500, 1500));
            
            // Check for normal response
            const connectionStatus = await page.evaluate(() => {
                return document.body && document.body.textContent ? 'connected' : 'empty';
            });
            
            if (connectionStatus === 'empty') {
                logger.warn('Empty response detected during connection test. Possible IP blocking.');
                
                // Try toggling proxy setting if we get an empty response
                const useProxy = process.env.INSTAGRAM_USE_PROXY === 'true';
                if (useProxy) {
                    logger.info('Attempting to retry without proxy...');
                    process.env.INSTAGRAM_USE_PROXY = 'false';
                    return false; // Signal caller to restart the login process
                }
            }
            
            logger.info('Connection test passed, proceeding to login...');
            
            // Navigate to login page with randomized timing
            logger.info('Navigating to login page...');
            await page.goto('https://www.instagram.com/accounts/login/', { 
                waitUntil: 'networkidle0',
                timeout: randomJitter(30000, 0.2)
            });
            
            // Wait for a random period to simulate a human looking at the page
            await delay(humanLikeDelay(1000, 3000));
            
            // Check for and handle cookie consent banner with natural interaction
            const consentSelectors = [
                'button[tabindex="0"]:not([disabled])',
                'button:has-text("Accept")',
                'button:has-text("Accept All")',
                'button:has-text("Allow")'
            ];
            
            for (const selector of consentSelectors) {
                try {
                    const consentButton = await page.$(selector);
                    if (consentButton) {
                        logger.info(`Found cookie consent button: ${selector}`);
                        await naturalMouseMovement(page, selector);
                        await delay(humanLikeDelay(500, 1500));
                        break;
                    }
                } catch (error: unknown) {
                    // Continue to next selector
                }
            }
            
            // Handle age verification if present
            const ageVerificationSelectors = [
                'button:has-text("Continue")', 
                'input[type="number"]'
            ];
            
            for (const selector of ageVerificationSelectors) {
                try {
                    const element = await page.$(selector);
                    if (element) {
                        logger.info('Handling age verification...');
                        
                        if (selector.includes('input')) {
                            // Fill age with natural typing (random 25-40 year old)
                            const randomAge = 25 + Math.floor(Math.random() * 15);
                            await humanTyping(page, selector, randomAge.toString());
                        } else {
                            // Click the continue button
                            await naturalMouseMovement(page, selector);
                        }
                        await delay(humanLikeDelay(800, 2000));
                    }
                } catch (error: unknown) {
                    // Continue to next selector
                }
            }
            
            // Wait for login form with selector flexibility
            const usernameSelectors = [
                'input[name="username"]',
                'input[aria-label="Phone number, username, or email"]',
                'input[placeholder*="Phone"]',
                'input[placeholder*="Username"]',
                'input[autocomplete="username"]'
            ];
            
            const passwordSelectors = [
                'input[name="password"]',
                'input[aria-label="Password"]',
                'input[placeholder="Password"]',
                'input[autocomplete="current-password"]'
            ];
            
            // Try each username selector
            let usernameSelector = '';
            for (const selector of usernameSelectors) {
                try {
                    await page.waitForSelector(selector, { timeout: 5000 });
                    usernameSelector = selector;
                    break;
                } catch (error: unknown) {
                    // Continue to next selector
                }
            }
            
            // Try each password selector
            let passwordSelector = '';
            for (const selector of passwordSelectors) {
                try {
                    await page.waitForSelector(selector, { timeout: 5000 });
                    passwordSelector = selector;
                    break;
                } catch (error: unknown) {
                    // Continue to next selector
                }
            }
            
            if (!usernameSelector || !passwordSelector) {
                logger.error('Could not find login form selectors');
                // Take screenshot for debugging
                await page.screenshot({ path: 'login-form-error.png' });
                return false;
            }
            
            // Check if we are already logged in
            const alreadyLoggedIn = await page.evaluate(() => {
                return window.location.pathname !== '/accounts/login/' && 
                       window.location.pathname !== '/accounts/login';
            });
            
            if (alreadyLoggedIn) {
                logger.info('Already logged in, skipping login form');
                return true;
            }
            
            // Occasionally move mouse randomly before starting to type
            if (Math.random() < 0.7) {
                const randomX = 100 + Math.floor(Math.random() * 400);
                const randomY = 100 + Math.floor(Math.random() * 200);
                await page.mouse.move(randomX, randomY);
                await delay(humanLikeDelay(200, 800));
            }
            
            // Fill credentials with human-like typing
            logger.info('Entering credentials...');
            await humanTyping(page, usernameSelector, username);
            
            // Pause like a human would between username and password
            await delay(humanLikeDelay(500, 2000));
            
            await humanTyping(page, passwordSelector, password);
            
            // Pause before submission like a human would
            await delay(humanLikeDelay(800, 2000));
            
            // Submit form with multiple fallback options and natural mouse movement
            let submitted = false;
            
            // Try clicking the submit button first with natural movement
            try {
                const submitButton = await page.$('button[type="submit"]');
                if (submitButton) {
                    await naturalMouseMovement(page, 'button[type="submit"]');
                    submitted = true;
                    logger.info('Submitted form by clicking submit button');
                }
            } catch (error: unknown) {
                logger.warn('Could not click submit button:', error instanceof Error ? error.message : String(error));
            }
            
            // Try pressing Enter if button click failed
            if (!submitted) {
                try {
                    await page.keyboard.press('Enter');
                    submitted = true;
                    logger.info('Submitted form by pressing Enter');
                } catch (error: unknown) {
                    logger.warn('Could not submit form with Enter key:', error instanceof Error ? error.message : String(error));
                }
            }
            
            // Try evaluating button click as last resort
            if (!submitted) {
                try {
                    await page.evaluate(() => {
                        const buttons = Array.from(document.querySelectorAll('button'));
                        const loginButton = buttons.find(button => 
                            button.textContent?.includes('Log In') || 
                            button.textContent?.includes('Sign In') ||
                            button.type === 'submit'
                        );
                        if (loginButton) {
                            loginButton.click();
                        }
                    });
                    submitted = true;
                    logger.info('Submitted form with DOM evaluation');
                } catch (error: unknown) {
                    logger.error('All form submission methods failed:', error instanceof Error ? error.message : String(error));
                    return false;
                }
            }
            
            // Wait for navigation with random jitter
            await delay(humanLikeDelay(2000, 5000));
            
            // Check for login errors
            const errorSelectors = [
                'p[role="alert"]',
                'div[role="alert"]',
                '#slfErrorAlert',
                'text="Incorrect password"',
                'text="Please wait a few minutes before you try again"'
            ];
            
            for (const selector of errorSelectors) {
                try {
                    const errorElement = await page.$(selector);
                    if (errorElement) {
                        const errorText = await page.evaluate((el: Element) => el.textContent, errorElement);
                        logger.error(`Login error: ${errorText}`);
                        
                        if (errorText?.includes('wait') || errorText?.includes('try again')) {
                            logger.warn('Rate limiting detected, wait period required');
                            // Consider exponential backoff here
                        }
                        
                        return false;
                    }
                } catch (error: unknown) {
                    // Continue checking other selectors
                }
            }
            
            // Check for two-factor authentication
            const twoFactorSelectors = [
                'input[name="verificationCode"]',
                'input[placeholder*="security code"]',
                'input[aria-label*="security code"]',
                'input[aria-label*="Confirmation"]'
            ];
            
            for (const selector of twoFactorSelectors) {
                try {
                    const twoFactorInput = await page.$(selector);
                    if (twoFactorInput) {
                        logger.warn('Two-factor authentication detected, cannot proceed automatically');
                        return false;
                    }
                } catch (error: unknown) {
                    // Continue checking other selectors
                }
            }
            
            // Check for suspicious login screen
            const suspiciousLoginSelectors = [
                'text="Suspicious Login Attempt"',
                'text="Was This You?"',
                'text="We detected an unusual login attempt"'
            ];
            
            for (const selector of suspiciousLoginSelectors) {
                try {
                    const suspiciousElement = await page.$(selector);
                    if (suspiciousElement) {
                        logger.warn('Suspicious login attempt detected, cannot proceed automatically');
                        return false;
                    }
                } catch (error: unknown) {
                    // Continue checking other selectors
                }
            }
            
            // Successful login check - look for elements that indicate successful login
            const successSelectors = [
                'svg[aria-label="Home"]',
                'svg[aria-label="Direct"]',
                'svg[aria-label="Explore"]',
                'a[href="/explore/"]',
                'svg[aria-label="New post"]'
            ];
            
            let loggedIn = false;
            
            for (const selector of successSelectors) {
                try {
                    await page.waitForSelector(selector, { timeout: 5000 });
                    loggedIn = true;
                    break;
                } catch (error: unknown) {
                    // Continue checking other selectors
                }
            }
            
            if (loggedIn) {
                logger.info('Successfully logged in!');
                
                // Sometimes Instagram shows a dialog after login, try to close it
                const closeDialogSelectors = [
                    'button:has-text("Not Now")',
                    'button[tabindex="0"]:not([disabled])'
                ];
                
                for (const selector of closeDialogSelectors) {
                    try {
                        const closeButton = await page.$(selector);
                        if (closeButton) {
                            logger.info('Closing post-login dialog...');
                            await naturalMouseMovement(page, selector);
                            await delay(humanLikeDelay(500, 1500));
                            break;
                        }
                    } catch (error: unknown) {
                        // Continue to next selector
                    }
                }
                
                // Save cookies after successful login
                await saveCookies(cookiesPath, await page.cookies());
                
                // Random human-like behavior after login
                if (Math.random() < 0.5) {
                    logger.info('Performing random post-login browsing to appear more human-like...');
                    await performRandomBrowsing(page);
                }
                
                return true;
            } else {
                logger.error('Login appeared to succeed but could not find post-login elements');
                await page.screenshot({ path: 'login-verification-failed.png' });
                return false;
            }
        } catch (error: unknown) {
            // Special handling for ERR_EMPTY_RESPONSE, which often indicates IP blocking
            const errorMessage = error instanceof Error ? error.message : String(error);
            
            if (errorMessage.includes('ERR_EMPTY_RESPONSE')) {
                logger.error('Empty response error during login (possible IP blocking):', error);
                
                // If using proxy, try toggling it
                const useProxy = process.env.INSTAGRAM_USE_PROXY === 'true';
                if (useProxy) {
                    logger.info('Attempting to retry without proxy...');
                    process.env.INSTAGRAM_USE_PROXY = 'false';
                } else {
                    logger.info('Attempting to retry with proxy...');
                    process.env.INSTAGRAM_USE_PROXY = 'true';
                }
                
                return false; // Signal caller to restart the login process
            }
            
            logger.error('Login failed with error:', error);
            return false;
        }
    } catch (error: unknown) {
        logger.error('Critical error during login process:', error instanceof Error ? error.message : String(error));
        return false;
    }
}

// Add a method for random browsing to appear more human-like
async function performRandomBrowsing(page: any): Promise<void> {
    logger.info('Performing random browsing to appear more human-like');
    
    try {
        // Random actions to perform
        const actions = [
            async () => {
                // Random scroll
                logger.info('Random browsing: Scrolling feed');
                await naturalScroll(page, Math.floor(randomJitter(1000, 0.5)));
                await delay(humanLikeDelay(2000, 5000));
            },
            async () => {
                // Visit explore page
                logger.info('Random browsing: Visiting explore page');
                await naturalMouseMovement(page, 'a[href="/explore/"]');
                await delay(humanLikeDelay(3000, 7000));
                await naturalScroll(page, Math.floor(randomJitter(800, 0.4)));
            },
            async () => {
                // Visit profile page
                logger.info('Random browsing: Visiting own profile');
                await page.evaluate(() => {
                    const profileLinks = Array.from(document.querySelectorAll('a'));
                    const profileLink = profileLinks.find(link => 
                        link.href.includes('/direct/inbox/') || 
                        link.innerText?.includes('Profile')
                    );
                    if (profileLink) profileLink.click();
                });
                await delay(humanLikeDelay(2000, 4000));
            }
        ];
        
        // Perform 1-3 random actions
        const numActions = 1 + Math.floor(Math.random() * 3);
        for (let i = 0; i < numActions; i++) {
            const randomAction = actions[Math.floor(Math.random() * actions.length)];
            await randomAction();
        }
        
        // Navigate back to feed when done
        await page.goto('https://www.instagram.com/', { 
            waitUntil: 'domcontentloaded',
            timeout: randomJitter(20000, 0.3)
        });
        
        logger.info('Random browsing completed');
    } catch (error: unknown) {
        logger.warn('Error during random browsing:', error instanceof Error ? error.message : String(error));
        // Non-critical function, continue execution even if it fails
    }
}

async function hasAlreadyCommented(post: any): Promise<boolean> {
    try {
        // Try to find the username in the comments
        const username = process.env.INSTAGRAM_BOT_USERNAME;
        if (!username) {
            logger.warn('Username not found in environment variables');
            return false;
        }

        logger.info(`Checking if ${username} has already commented on this post`);

        // First try to expand comments if available
        try {
            const viewAllSelectors = [
                'span:has-text("View all")',
                'span:has-text("View all comments")',
                'a:has-text("View all")',
                'span._aacl._aaco._aacw._aacx._aad7._aade:has-text("View")',
                'div.x9f619.xjbqb8w.x78zum5.x168nmei.x13lgxp2.x5pf9jr.xo71vjh.x1uhb9sk:has-text("View")'
            ];

            for (const selector of viewAllSelectors) {
                try {
                    const viewAllButton = await post.$(selector);
                    if (viewAllButton) {
                        logger.info(`Found "View all comments" button with selector: ${selector}`);
                        await viewAllButton.click();
                        await delay(2000);
                        break;
                    }
                } catch (innerError: unknown) {
                    // Continue to next selector
                }
            }
        } catch (expandError: unknown) {
            logger.debug('Error expanding comments:', expandError instanceof Error ? expandError.message : String(expandError));
        }

        // Multiple approaches to look for comments by our username
        
        // Approach 1: Traditional DOM traversal with multiple selectors
        const commentSelectors = [
            'ul div[role="button"]',
            'ul li div',
            'div[class*="comment"]',
            'div.x1lliihq',
            'article ul li',
            'article div[role="button"]'
        ];

        for (const selector of commentSelectors) {
            try {
                const comments = await post.$$(selector);
                logger.info(`Found ${comments.length} potential comments with selector: ${selector}`);
                
                for (const comment of comments) {
                    try {
                        // Try different patterns to find username in comment
                        const usernameSelectors = [
                            'span a',
                            'a',
                            'span[dir="auto"] a',
                            'div[dir="auto"] a',
                            'h3',
                            'span.x1lliihq',
                            'div.x9f619'
                        ];
                        
                        for (const usernameSelector of usernameSelectors) {
                            const commentUsername = await comment.$(usernameSelector);
                            if (commentUsername) {
                                const usernameText = await commentUsername.evaluate((el: HTMLElement) => el.textContent?.trim());
                                if (usernameText === username) {
                                    logger.info(`Found existing comment by ${username}`);
                                    return true;
                                }
                            }
                        }
                        
                        // Also check if the entire comment HTML contains our username
                        const commentHTML = await comment.evaluate((el: HTMLElement) => el.outerHTML);
                        if (commentHTML.includes(username)) {
                            logger.info(`Found existing comment by ${username} in HTML`);
                            return true;
                        }
                    } catch (commentError: unknown) {
                        // Continue to next comment
                    }
                }
            } catch (selectorError: unknown) {
                // Continue to next selector
            }
        }
        
        // Approach 2: Use page.evaluate for a more comprehensive search
        try {
            const foundWithEvaluate = await post.evaluate((searchUsername: string) => {
                // Helper function to search for username in element and its children
                function containsUsername(element: Element, username: string): boolean {
                    if (!element) return false;
                    
                    // Check this element's text content
                    if (element.textContent?.includes(username)) {
                        // Verify it's actually a comment, not just text containing the username
                        const isComment = 
                            element.closest('li') || 
                            element.closest('[role="button"]') || 
                            element.closest('[class*="comment"]');
                        
                        if (isComment) return true;
                    }
                    
                    // Search child elements
                    for (let i = 0; i < element.children.length; i++) {
                        if (containsUsername(element.children[i], username)) {
                            return true;
                        }
                    }
                    
                    return false;
                }
                
                // Start with comment sections
                const commentSections = [
                    document.querySelector('ul'),
                    document.querySelector('article'),
                    document.querySelector('div[class*="comment"]'),
                    document.querySelector('section')
                ];
                
                for (const section of commentSections) {
                    if (section && containsUsername(section, searchUsername)) {
                        return true;
                    }
                }
                
                return false;
            }, username);
            
            if (foundWithEvaluate) {
                logger.info(`Found existing comment by ${username} using evaluate method`);
                return true;
            }
        } catch (evaluateError: unknown) {
            logger.debug('Error in evaluate search:', evaluateError instanceof Error ? evaluateError.message : String(evaluateError));
        }

        logger.info(`No existing comments by ${username} found`);
        return false;
    } catch (error: unknown) {
        logger.warn('Error checking for existing comments:', error instanceof Error ? error.message : String(error));
        return false;
    }
}

async function testLikeButtonMethods(post: any, postIndex: number) {
    const methods = [
        {
            name: 'Method 1: Direct click',
            async execute() {
                const likeButton = await post.$('svg[aria-label="Like"]');
                if (likeButton) {
                    await naturalMouseMovement(post, 'svg[aria-label="Like"]');
                    return true;
                }
                return false;
            }
        },
        {
            name: 'Method 2: Click with coordinates',
            async execute() {
                const likeButton = await post.$('svg[aria-label="Like"]');
                if (likeButton) {
                    await post.evaluate(() => {
                        const button = document.querySelector('svg[aria-label="Like"]');
                        if (button) {
                            button.dispatchEvent(new MouseEvent('click', {
                                bubbles: true,
                                cancelable: true,
                                button: 0
                            }));
                        }
                    });
                    return true;
                }
                return false;
            }
        }
    ];

    for (const method of methods) {
        try {
            logger.info(`Testing ${method.name} on post ${postIndex}...`);
            const success = await method.execute();
            
            // Wait to check if like was successful
            await delay(2000);
            
            // Verify if post is liked
            const isLiked = await post.$('svg[aria-label="Unlike"]');
            
            logger.info(`${method.name} result:`, {
                success: success,
                likeVerified: !!isLiked
            });

            if (isLiked) {
                // Log successful like
                const caption = await getPostCaption(post);
                await logInteraction({
                    postIndex,
                    timestamp: new Date().toISOString(),
                    caption,
                    likeMethod: method.name,
                    commentMethod: null,
                    commentText: null,
                    success: true,
                    details: `Like successful using ${method.name}`
                });
                
                logger.info(`Successfully liked post ${postIndex} using ${method.name}`);
                return true;
            }
            
            // If not liked, try to reset state by clicking Unlike if present
            const unlikeButton = await post.$('svg[aria-label="Unlike"]');
            if (unlikeButton) {
                await unlikeButton.click();
                await delay(1000);
            }
            
        } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger.error(`Error with ${method.name}:`, errorMessage);
        }
    }
    return false;
}

async function findPostButtonRelativeToCommentBox(post: any): Promise<any> {
    try {
        // First get the comment box
        const commentBox = await post.$('textarea[aria-label="Add a comment…"]');
        if (!commentBox) return null;

        // Get the comment box position
        const commentBoxBounds = await commentBox.boundingBox();
        if (!commentBoxBounds) return null;

        // Find all buttons in the post
        const buttons = await post.$$('button');
        
        // Find the button that's to the right of the comment box
        for (const button of buttons) {
            const buttonBounds = await button.boundingBox();
            if (!buttonBounds) continue;

            // Check if button is to the right of the comment box
            const isToTheRight = buttonBounds.x > (commentBoxBounds.x + commentBoxBounds.width);
            const isAtSimilarHeight = Math.abs(buttonBounds.y - commentBoxBounds.y) < 20;

            if (isToTheRight && isAtSimilarHeight) {
                logger.info('Found post button by relative position to comment box');
                return button;
            }
        }
    } catch (error: unknown) {
        logger.warn('Error finding button by relative position');
    }
    return null;
}

async function findPostButton(post: any): Promise<any> {
    // Try all previous methods first
    const button = await findPostButtonRelativeToCommentBox(post);
    if (button) return button;

    // If relative position method failed, try other methods...
    try {
        const ariaButton = await post.$('button[aria-label="Post"]');
        if (ariaButton) {
            logger.info('Found post button by aria-label');
            return ariaButton;
        }
    } catch (error: unknown) {
        logger.warn('Error finding button by aria-label');
    }

    // Try to find by class name patterns
    const classSelectors = [
        'button._acan._acap._acas._aj1-',
        'button._acap._acas',
        'button._acan._acap',
        'button[type="submit"]._acan',
        'button[type="submit"]._acap',
        'button._ab5w._ab5x', // Another possible Instagram class
        'button[type="submit"]'
    ];

    for (const selector of classSelectors) {
        try {
            const button = await post.$(selector);
            if (button) {
                // Verify it's enabled
                const isEnabled = await button.evaluate((el: HTMLButtonElement) => {
                    const style = window.getComputedStyle(el);
                    return !el.disabled && 
                           !el.hasAttribute('disabled') && 
                           style.opacity !== '0.3' &&
                           style.display !== 'none' &&
                           style.visibility !== 'hidden';
                });

                if (isEnabled) {
                    logger.info(`Found enabled post button with selector: ${selector}`);
                    return button;
                }
            }
        } catch (error: unknown) {
            logger.warn(`Error with selector ${selector}`);
        }
    }

    // Try to find by traversing from comment textarea
    try {
        const textarea = await post.$('textarea[aria-label="Add a comment…"]');
        if (textarea) {
            const submitButton = await post.evaluateHandle((el: HTMLElement) => {
                // Try to find button in the same container as textarea
                let current = el;
                while (current && current.tagName !== 'ARTICLE') {
                    const button = current.querySelector('button[type="submit"]');
                    if (button) return button;
                    current = current.parentElement as HTMLElement;
                }
                return null;
            }, textarea);

            if (submitButton) {
                logger.info('Found post button by traversing DOM');
                return submitButton;
            }
        }
    } catch (error: unknown) {
        logger.warn('Error traversing DOM for button');
    }

    return null;
}

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

        // Log the exact coordinates we're clicking
        logger.info(`Clicking at exact center coordinates: (${centerX}, ${centerY})`);

        // Move to center in small steps
        const steps = 5;
        const currentMouse = await post.mouse.position();
        const xStep = (centerX - currentMouse.x) / steps;
        const yStep = (centerY - currentMouse.y) / steps;

        for (let i = 1; i <= steps; i++) {
            await post.mouse.move(
                currentMouse.x + (xStep * i),
                currentMouse.y + (yStep * i),
                { steps: 10 }
            );
            await delay(50);
        }

        // Click sequence
        await post.mouse.down();
        await delay(100);
        await post.mouse.up();
        
        return true;
    } catch (error: unknown) {
        logger.warn('Error in clickExactCenter:', error instanceof Error ? error.message : String(error));
        return false;
    }
}

async function testPostButtonMethods(post: any, commentText: string): Promise<boolean> {
    const postButton = await findPostButton(post);
    if (!postButton) {
        return false;
    }

    interface ClickMethod {
        name: string;
        execute: () => Promise<boolean>;
    }

    const methods: ClickMethod[] = [
        {
            name: 'Method 1: Direct click',
            async execute() {
                const result = await clickExactCenter(post, postButton);
                if (!result) {
                    throw new Error('Failed to click center');
                }
                return true;
            }
        },
        {
            name: 'Method 2: Click with coordinates',
            async execute() {
                const box = await postButton.boundingBox();
                if (!box) return false;

                // Calculate the center point
                const centerX = box.x + (box.width / 2);
                const centerY = box.y + (box.height / 2);

                // Add a small random offset
                const offsetX = Math.random() * 4 - 2; // Random between -2 and 2
                const offsetY = Math.random() * 4 - 2;

                // Click with the offset
                await post.mouse.move(centerX + offsetX, centerY + offsetY);
                await delay(100);
                await post.mouse.down();
                await delay(100);
                await post.mouse.up();

                return true;
            }
        },
        {
            name: 'Method 3: Force click with JavaScript',
            async execute() {
                return await postButton.evaluate((button: HTMLButtonElement) => {
                    // Remove any disabled attributes
                    button.disabled = false;
                    button.removeAttribute('disabled');
                    
                    // Force pointer events
                    const style = window.getComputedStyle(button);
                    if (style.pointerEvents === 'none') {
                        button.style.pointerEvents = 'auto';
                    }

                    // Click the button
                    button.click();
                    
                    return true;
                });
            }
        },
        {
            name: 'Method 4: Form submit simulation',
            async execute() {
                return await postButton.evaluate((button: HTMLButtonElement) => {
                    const form = button.closest('form');
                    if (form) {
                        // Create and dispatch submit event
                        const submitEvent = new Event('submit', {
                            bubbles: true,
                            cancelable: true
                        });
                        form.dispatchEvent(submitEvent);
                    }
                    return true;
                });
            }
        },
        {
            name: 'Method 5: Trigger all possible events',
            async execute() {
                return await postButton.evaluate((button: HTMLButtonElement) => {
                    const events = [
                        'mouseover',
                        'mousedown',
                        'mouseup',
                        'click',
                        'focus',
                        'pointerdown',
                        'pointerup'
                    ];
                    
                    events.forEach(eventType => {
                        const event = new Event(eventType, { bubbles: true });
                        button.dispatchEvent(event);
                    });
                    
                    return true;
                });
            }
        },
        {
            name: 'Method 6: Relative position click',
            async execute() {
                const commentBox = await post.$('textarea[aria-label="Add a comment…"]');
                if (!commentBox) throw new Error('Comment box not found');
                
                const boxBounds = await commentBox.boundingBox();
                if (!boxBounds) throw new Error('Could not get comment box bounds');

                // Click 50 pixels to the right of the comment box
                const clickX = boxBounds.x + boxBounds.width + 50;
                const clickY = boxBounds.y + (boxBounds.height / 2);

                logger.info(`Clicking relative to comment box at: (${clickX}, ${clickY})`);
                
                await post.mouse.move(clickX, clickY, { steps: 10 });
                await delay(100);
                await post.mouse.down();
                await delay(100);
                await post.mouse.up();
                
                return true;
            }
        }
    ];

    for (const method of methods) {
        try {
            logger.info(`Trying ${method.name}...`);
            const success = await method.execute();
            
            if (success) {
                // Verify if comment was posted
                const validation = await validateComment(post, commentText);
                if (validation.success) {
                    logger.info(`SUCCESS: Comment posted using ${method.name} - ${validation.details}`);
                    return true;
                }
                logger.info(`${method.name} clicked but comment not verified - ${validation.details}`);
            }
        } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger.warn(`${method.name} failed:`, errorMessage);
            continue;
        }
    }

    return false;
}

async function postComment(post: any, commentText: string): Promise<boolean> {
    try {
        logger.info(`Attempting to post comment: ${commentText}`);
        
        // Check if already commented first
        const alreadyCommented = await hasAlreadyCommented(post);
        if (alreadyCommented) {
            logger.info('Already commented on this post, skipping...');
            return true; // Consider it successful since comment exists
        }

        // Enhanced comment posting methods
        const commentPostingMethods = [
            {
                name: 'Method 1: Type and Enter',
                action: async () => {
                    const commentBoxSelectors = [
                        'textarea[aria-label="Add a comment…"]',
                        'textarea[placeholder*="comment"]',
                        'form textarea',
                        'div[contenteditable="true"]'
                    ];
                    
                    for (const selector of commentBoxSelectors) {
                        const commentBox = await post.$(selector);
                        if (commentBox) {
                            logger.info(`Found comment box with selector: ${selector}`);
                            await commentBox.click();
                            await delay(humanLikeDelay(500, 1000));
                            await commentBox.focus();
                            await post.keyboard.type(commentText, { delay: humanLikeDelay(50, 150) });
                            await delay(humanLikeDelay(800, 1500));
                            await post.keyboard.press('Enter');
                            await delay(2000);
                            return true;
                        }
                    }
                    return false;
                }
            },
            {
                name: 'Method 2: Click Comment Button',
                action: async () => {
                    // Fill the comment box first
                    const commentBoxSelectors = [
                        'textarea[aria-label="Add a comment…"]',
                        'textarea[placeholder*="comment"]',
                        'form textarea',
                        'div[contenteditable="true"]'
                    ];
                    
                    let commentBoxFound = false;
                    for (const selector of commentBoxSelectors) {
                        const commentBox = await post.$(selector);
                        if (commentBox) {
                            logger.info(`Found comment box with selector: ${selector}`);
                            await commentBox.click();
                            await delay(humanLikeDelay(500, 1000));
                            await commentBox.focus();
                            await post.keyboard.type(commentText, { delay: humanLikeDelay(50, 150) });
                            await delay(humanLikeDelay(800, 1500));
                            commentBoxFound = true;
                            break;
                        }
                    }
                    
                    if (!commentBoxFound) {
                        return false;
                    }
                    
                    // Then try to find and click post button
                    const buttonSelectors = [
                        'button[type="submit"]',
                        'button:has-text("Post")',
                        'form button',
                        'div[role="button"]:has-text("Post")',
                        'button.x1i10hfl',
                        'button._acan'
                    ];
                    
                    for (const selector of buttonSelectors) {
                        try {
                            const postButton = await post.$(selector);
                            if (postButton) {
                                logger.info(`Found post button with selector: ${selector}`);
                                await postButton.click();
                                await delay(2000);
                                return true;
                            }
                        } catch (buttonError: unknown) {
                            // Continue to next selector
                        }
                    }
                    
                    return false;
                }
            },
            {
                name: 'Method 3: Form Submit',
                action: async () => {
                    // Fill the comment box first
                    const commentBoxFound = await post.evaluate((text: string) => {
                        const textareas = Array.from(document.querySelectorAll('textarea'));
                        for (const textarea of textareas) {
                            if (textarea.placeholder?.toLowerCase().includes('comment') || 
                                textarea.getAttribute('aria-label')?.toLowerCase().includes('comment')) {
                                textarea.value = text;
                                // Create input event to trigger React state update
                                const inputEvent = new Event('input', { bubbles: true });
                                textarea.dispatchEvent(inputEvent);
                                return true;
                            }
                        }
                        return false;
                    }, commentText);
                    
                    if (!commentBoxFound) {
                        return false;
                    }
                    
                    // Submit the form
                    const formSubmitted = await post.evaluate(() => {
                        const forms = Array.from(document.querySelectorAll('form'));
                        for (const form of forms) {
                            if (form.querySelector('textarea')) {
                                const submitEvent = new Event('submit', {
                                    bubbles: true,
                                    cancelable: true
                                });
                                form.dispatchEvent(submitEvent);
                            }
                            return true;
                        }
                        return false;
                    });
                    
                    await delay(2000);
                    return formSubmitted;
                }
            }
        ];
        
        // Try each method in sequence
        for (const method of commentPostingMethods) {
            try {
                logger.info(`Trying ${method.name}...`);
                const success = await method.action();
                
                if (success) {
                    // Validate if the comment was actually posted
                    const validation = await validateComment(post, commentText);
                    
                    if (validation.success) {
                        logger.info(`SUCCESS: Comment posted with ${method.name} - ${validation.details}`);
                        await closeCommentBox(post); // Close the comment box to avoid issues
                        return true;
                    }
                    
                    logger.info(`${method.name} executed but comment not verified - ${validation.details}`);
                } else {
                    logger.info(`${method.name} failed to execute completely`);
                }
            } catch (error: unknown) {
                logger.warn(`${method.name} failed with error:`, error instanceof Error ? error.message : String(error));
            }
            
            // Add a delay between methods
            await delay(humanLikeDelay(1000, 2000));
        }
        
        logger.warn('All comment posting methods failed');
        return false;
    } catch (error: unknown) {
        logger.error('Error posting comment:', error instanceof Error ? error.message : String(error));
        return false;
    }
}

async function testCommentMethods(post: any, postIndex: number) {
    // First check if we've already commented
    const alreadyCommented = await hasAlreadyCommented(post);
    if (alreadyCommented) {
        logger.info(`Already commented on post ${postIndex}, skipping...`);
        return false;
    }

    const commentText = (await getInstagramCommentSchema()).comment;
    logger.info(`Testing comment methods with text: ${commentText}`);

    const success = await postComment(post, commentText);
    if (success) {
        const caption = await getPostCaption(post);
        await logInteraction({
            postIndex,
            timestamp: new Date().toISOString(),
            caption,
            likeMethod: null,
            commentMethod: 'postComment',
            commentText: commentText,
            success: true,
            details: `Comment successful using postComment`
        });
        
        logger.info(`Successfully commented on post ${postIndex} using postComment`);
        return true;
    }
    return false;
}

async function validateComment(post: any, commentText: string): Promise<{ success: boolean; details: string }> {
    try {
        logger.info('Starting comment validation...');
        
        // Check 1: Look for success message
        try {
            const successMessageSelectors = [
                'div[role="alert"]',
                'span[data-visualcompletion="css-img"]',
                'div[style*="transform"]',
                'div.x1lliihq'
            ];
            
            for (const selector of successMessageSelectors) {
                const successMessage = await post.$(selector);
                if (successMessage) {
                    const messageText = await successMessage.evaluate((el: HTMLElement) => el.textContent || el.getAttribute('aria-label') || '');
                    logger.info(`Found alert message with selector ${selector}:`, messageText);
                    if (messageText?.includes('Comment') || messageText?.includes('post') || messageText?.includes('success')) {
                        return { success: true, details: `Success message found with selector: ${selector}` };
                    }
                }
            }
        } catch (error: unknown) {
            logger.info('No success message found:', error instanceof Error ? error.message : String(error));
        }

        // Check 2: Verify comment box is empty/closed
        try {
            const commentBoxSelectors = [
                'textarea[aria-label="Add a comment…"]',
                'textarea[placeholder*="comment"]',
                'form textarea',
                'div[contenteditable="true"]'
            ];
            
            for (const selector of commentBoxSelectors) {
                const commentBox = await post.$(selector);
                if (commentBox) {
                    const value = await commentBox.evaluate((el: HTMLTextAreaElement) => el.value);
                    logger.info(`Comment box state (${selector}):`, value ? 'Has text' : 'Empty');
                    if (!value) {
                        // Empty comment box after submission is a good sign
                        logger.info('Comment box is empty, possible success');
                        break;
                    }
                }
            }
        } catch (error: unknown) {
            logger.info('Could not check comment box state:', error instanceof Error ? error.message : String(error));
        }

        // Check 3: Look for our comment in the comments section
        try {
            // Expanded list of selectors for comments
            const selectors = [
                'span._aacl._aaco._aacu._aacx._aad7._aade', // Common comment selector
                'ul div[role="button"] span',                // Alternative selector
                'ul[class*="comment"] span',                 // Another variation
                'div[class*="comment"] span',                // Generic comment class
                'div.xdj266r',                               // New UI class
                'ul li span',                                // Basic list items
                'li div[dir="auto"]',                        // List items with directional text
                'div.xdj266r',                               // Another comment container class
                'div.x11i5rnm',                              // Another comment container class
                'div[role="menuitem"] span',                 // Comment in menu style
                'article div[dir="auto"]'                    // Comments within article
            ];

            logger.info(`Checking for comment text: "${commentText}"`);
            for (const selector of selectors) {
                try {
                    logger.info(`Checking comments with selector: ${selector}`);
                    const comments = await post.$$(selector);
                    logger.info(`Found ${comments.length} potential comments with ${selector}`);
                    
                    for (const comment of comments) {
                        const text = await comment.evaluate((el: HTMLElement) => el.textContent?.trim());
                        if (text) {
                            logger.info('Found comment text:', text);
                            // Check for exact match or if comment text is contained within
                            if (text === commentText || text.includes(commentText)) {
                                return { success: true, details: `Comment found using selector: ${selector}` };
                            }
                        }
                    }
                } catch (innerError: unknown) {
                    logger.debug(`Error with selector ${selector}:`, innerError instanceof Error ? innerError.message : String(innerError));
                    // Continue to next selector
                }
            }
            
            // Additional check: Use page.evaluate to search for comment text in the DOM
            try {
                const foundInDOM = await post.evaluate((commentToFind: string) => {
                    // Helper function to search text nodes
                    function searchTextNodes(element: Element, searchText: string): boolean {
                        if (!element) return false;
                        
                        // Check this element's text content
                        if (element.textContent?.includes(searchText)) {
                            return true;
                        }
                        
                        // Search child elements
                        for (let i = 0; i < element.children.length; i++) {
                            if (searchTextNodes(element.children[i], searchText)) {
                                return true;
                            }
                        }
                        
                        return false;
                    }
                    
                    // Start with article element if available
                    const article = document.querySelector('article');
                    if (article && searchTextNodes(article, commentToFind)) {
                        return true;
                    }
                    
                    // Also search comments section if article check fails
                    const commentsSection = document.querySelector('ul[class*="comment"]') || 
                                           document.querySelector('div[class*="comment"]');
                    
                    return commentsSection ? searchTextNodes(commentsSection, commentToFind) : false;
                }, commentText);
                
                if (foundInDOM) {
                    logger.info('Comment found in DOM using evaluate method');
                    return { success: true, details: 'Comment found in DOM' };
                }
            } catch (evalError: unknown) {
                logger.debug('Error during DOM evaluation:', evalError instanceof Error ? evalError.message : String(evalError));
            }
        } catch (error: unknown) {
            logger.warn('Error checking comments:', error instanceof Error ? error.message : String(error));
        }

        // Check 4: Look for comment indicators and post activity changes
        try {
            const newCommentIndicators = [
                'View all comments',
                'Reply',
                'See translation',
                'See replies',
                'seconds ago',
                'minute ago',
                'View more comments'
            ];

            for (const indicator of newCommentIndicators) {
                try {
                    const elements = await post.$$(`text/${indicator}`);
                    if (elements.length > 0) {
                        logger.info(`Found "${indicator}" indicator - possible sign of success`);
                        // Finding these indicators is a positive sign, but not conclusive
                    }
                } catch (indicatorError: unknown) {
                    // Continue checking other indicators
                }
            }
            
            // Check for "comment posted" text anywhere in the post
            const commentPostedIndicator = await post.evaluate(() => {
                return document.body.innerText.includes('Comment posted') || 
                       document.body.innerText.includes('Your comment was posted');
            });
            
            if (commentPostedIndicator) {
                logger.info('Found "comment posted" indicator in page text');
                return { success: true, details: 'Comment posted indicator found' };
            }
        } catch (error: unknown) {
            logger.info('No new comment indicators found:', error instanceof Error ? error.message : String(error));
        }

        // If we get here, we couldn't definitively validate the comment
        // If we saw some signs of success but no definitive proof, return partial success
        return { success: false, details: 'Could not verify comment was posted' };
    } catch (error: unknown) {
        logger.warn('Error in comment validation:', error instanceof Error ? error.message : String(error));
        return { success: false, details: `Validation error: ${error instanceof Error ? error.message : String(error)}` };
    }
}

async function closeCommentBox(post: any) {
    try {
        const closeButton = await post.$('svg[aria-label="Close"]');
        if (closeButton) {
            await closeButton.click();
        }
    } catch (error: unknown) {
        logger.warn('Error closing comment box:', error instanceof Error ? error.message : String(error));
    }
}

async function interactWithPosts(page: any) {
    try {
        logger.info('Starting post interaction process...');
        
        // Ensure we are on the home feed
        logger.info('Ensuring we are on the home feed...');
        await page.goto('https://www.instagram.com/', { waitUntil: 'networkidle0' });
        
        // Wait for initial page load
        await delay(8000);
        
        // Wait for posts with timeout and retry
        logger.info('Waiting for posts to load...');
        let posts = [];
        let retries = 0;
        const maxRetries = 3;
        
        while (retries < maxRetries && posts.length === 0) {
            // Wait for article elements
            await page.waitForSelector('article', { timeout: 10000 }).catch(() => {
                logger.warn('Timeout waiting for articles, retrying...');
            });
            
            // Get all posts
            posts = await page.$$('article');
            
            if (posts.length === 0) {
                logger.warn(`No posts found, retry ${retries + 1}/${maxRetries}`);
                await delay(5000);
                retries++;
            }
        }
        
        if (posts.length === 0) {
            throw new Error('Failed to find any posts after maximum retries');
        }
        
        logger.info(`Found ${posts.length} posts`);
        
        // Process each post
        for (let i = 0; i < Math.min(posts.length, 5); i++) {
            logger.info(`Processing post ${i + 1}...`);
            
            // Wait for post to be interactive
            try {
                await page.waitForSelector(`article:nth-child(${i + 1})`, { timeout: 5000 });
                await delay(2000); // Additional wait for animations
            } catch (error: unknown) {
                logger.error(`Timeout waiting for post ${i + 1} to be interactive`);
                continue;
            }
            
            // Get caption first
            const caption = await getPostCaption(posts[i]);
            logger.info(`Post ${i + 1} caption:`, caption);

            // Check if post is still valid
            const isValid = await posts[i].evaluate((el: Element) => {
                return el.isConnected && window.getComputedStyle(el).display !== 'none';
            }).catch(() => false);

            if (!isValid) {
                logger.warn(`Post ${i + 1} is no longer valid, skipping...`);
                continue;
            }

            // Check if we've already commented
            const alreadyCommented = await hasAlreadyCommented(posts[i]);
            if (alreadyCommented) {
                logger.info(`Already commented on post ${i + 1}, skipping...`);
                continue;
            }

            // Like the post
            const likeSuccess = await testLikeButtonMethods(posts[i], i + 1);
            if (likeSuccess) {
                logger.info(`Successfully liked post ${i + 1}`);
                
                // Wait after liking
                await delay(3000);
                
                // Post a comment
                const defaultComment = "This is awesome! ✨"; // Default comment
                const commentSuccess = await postComment(posts[i], defaultComment);
                
                if (commentSuccess) {
                    logger.info(`Successfully commented on post ${i + 1}`);
                    // Log the interaction
                    await logInteraction({
                        postIndex: i + 1,
                        timestamp: new Date().toISOString(),
                        caption,
                        likeMethod: 'Method 2: Click with coordinates',
                        commentMethod: 'Direct comment method',
                        commentText: defaultComment,
                        success: true,
                        details: 'Successfully liked and commented on post'
                    });
                } else {
                    logger.warn(`Failed to comment on post ${i + 1}`);
                }
            } else {
                logger.warn(`Failed to like post ${i + 1}`);
            }
            
            await delay(5000); // Increased wait between posts
        }
        
        logger.info('Post interactions completed successfully');
        
    } catch (error: unknown) {
        logger.error('Error in post interactions:', error instanceof Error ? error.message : String(error));
        throw error;
    }
}

// Add a function to delete invalid cookies
async function deleteCookies(cookiesPath: string): Promise<void> {
    try {
        if (existsSync(cookiesPath)) {
            logger.info(`Deleting invalid cookies at: ${cookiesPath}`);
            unlinkSync(cookiesPath);
            logger.info('Invalid cookies deleted successfully');
            return;
        }
        logger.info('No cookies file found to delete');
    } catch (error: unknown) {
        logger.error('Error deleting cookies:', error instanceof Error ? error.message : String(error));
    }
}

export { runInstagram };
