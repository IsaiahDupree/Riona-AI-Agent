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

// Helper function to validate username
function getValidatedUsername(): string | undefined {
    const username = process.env.INSTAGRAM_BOT_USERNAME;
    if (!username) {
        logger.warn('Instagram bot username not found in environment variables');
    }
    return username;
}

// Add stealth plugin to puppeteer
puppeteer.use(StealthPlugin());
puppeteer.use(
    AdblockerPlugin({
        interceptResolutionPriority: DEFAULT_INTERCEPT_RESOLUTION_PRIORITY,
    })
);

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

interface CaptionCandidate {
    text: string;
    isVisible: boolean;
    height: number;
    classes: string;
    parentClasses: string;
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

async function scrollAndWaitForContent(post: any): Promise<void> {
    await post.evaluate((element: HTMLElement) => {
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });

    // Wait for scroll to complete and content to load
    await delay(2000);

    // Ensure we're in the viewport
    const isVisible = await post.evaluate((element: HTMLElement) => {
        const rect = element.getBoundingClientRect();
        return (
            rect.top >= 0 &&
            rect.left >= 0 &&
            rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) &&
            rect.right <= (window.innerWidth || document.documentElement.clientWidth)
        );
    });

    if (!isVisible) {
        // Try a more aggressive scroll if smooth scroll didn't work
        await post.evaluate((element: HTMLElement) => {
            element.scrollIntoView({ block: 'center' });
        });
        await delay(1000);
    }
}

async function waitForPostContent(post: any): Promise<void> {
    try {
        // Wait for post content with increased timeout and multiple selectors
        const selectors = [
            'article',
            'div[role="article"]',
            'div._aagv',  // Instagram's post container class
            'div[data-visualcompletion="media-vc-image"]'
        ];
        
        for (const selector of selectors) {
            try {
                await post.waitForSelector(selector, { timeout: 10000 });
                logger.info(`Post content found with selector: ${selector}`);
                break;
            } catch (error) {
                continue;
            }
        }
        
        // Wait for text content to be loaded
        await post.evaluate(() => {
            return new Promise((resolve) => {
                let attempts = 0;
                const maxAttempts = 20;
                const checkInterval = 500;
                
                const checkContent = () => {
                    const textElements = document.querySelectorAll('span, div[dir="auto"]');
                    const hasText = Array.from(textElements).some(el => {
                        const text = el.textContent?.trim();
                        return text && text.length > 0;
                    });
                    
                    if (hasText || attempts >= maxAttempts) {
                        resolve(true);
                    } else {
                        attempts++;
                        setTimeout(checkContent, checkInterval);
                    }
                };
                
                checkContent();
            });
        });
        
        await delay(1000); // Additional delay to ensure content is fully loaded
    } catch (error) {
        logger.warn('Error waiting for post content:', error);
    }
}

async function expandCaption(post: any): Promise<boolean> {
    try {
        // Modern Instagram "more" button selectors
        const moreButtonSelectors = [
            'div[role="button"]',
            'span._aacl._aaco._aacu._aacx._aad7._aade',
            'button',
            'div._a9zs button',
            'a'
        ];

        // Try each selector
        for (const selector of moreButtonSelectors) {
            const elements = await post.$$(selector);
            
            for (const element of elements) {
                const text = await element.evaluate((el: HTMLElement) => el.textContent?.toLowerCase().trim());
                if (text === 'more') {
                    const isVisible = await element.evaluate((el: HTMLElement) => {
                        const style = window.getComputedStyle(el);
                        const rect = el.getBoundingClientRect();
                        return style.display !== 'none' &&
                               style.visibility !== 'hidden' &&
                               style.opacity !== '0' &&
                               rect.width > 0 &&
                               rect.height > 0;
                    });

                    if (isVisible) {
                        logger.info(`Found visible "more" button using selector: ${selector}`);
                        await element.click();
                        await delay(1000);
                        return true;
                    }
                }
            }
        }

        logger.info('No expandable caption found');
        return false;
    } catch (error) {
        logger.error('Error expanding caption:', error);
        return false;
    }
}

interface CaptionResult {
    method: string;
    text: string | null;
    success: boolean;
    details: string;
}

async function findMoreButton(post: any): Promise<any | null> {
    const selectors = [
        // Role-based selectors
        'div[role="button"]',
        'button',
        'a',
        // Class-based selectors
        'span._aacl._aaco._aacu._aacx._aad7._aade'
    ];

    for (const selector of selectors) {
        try {
            const elements = await post.$$(selector);
            for (const element of elements) {
                try {
                    // Check if the element contains "more" text
                    const text = await element.evaluate((el: HTMLElement) => el.textContent?.trim().toLowerCase());
                    if (text === 'more') {
                        const isVisible = await element.evaluate((el: HTMLElement) => {
                            const rect = el.getBoundingClientRect();
                            const style = window.getComputedStyle(el);
                            return (
                                rect.top >= 0 &&
                                rect.left >= 0 &&
                                rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) &&
                                rect.right <= (window.innerWidth || document.documentElement.clientWidth) &&
                                style.display !== 'none' &&
                                style.visibility !== 'hidden'
                            );
                        });

                        if (isVisible) {
                            logger.info(`Found visible 'more' button with selector: ${selector}`);
                            return element;
                        }
                    }
                } catch (elementError) {
                    continue;
                }
            }
        } catch (selectorError) {
            continue;
        }
    }
    return null;
}

async function getPostCaption(post: any): Promise<string> {
    try {
        await scrollAndWaitForContent(post);
        await waitForPostContent(post);

        logger.info('Attempting to extract caption...');

        // Try to expand caption first
        await expandCaption(post);

        // Modern Instagram caption selectors
        const captionSelectors = [
            'h1[style*="max-height"]', // Main post caption
            'div[style*="max-height"] > span', // Expanded caption
            'div[style*="max-height"] > div > span', // Nested caption
            'div._a9zs > span', // Class-based caption
            'div._a9zs', // Direct caption container
            'div[data-testid="post-comment-root"] > span', // Test ID based
            'article div > span' // Generic article caption
        ];

        // Use Puppeteer's $$eval to get all potential captions
        const captions: CaptionCandidate[] = await post.$$eval(captionSelectors.join(','), (elements: Element[]) => {
            return elements.map(el => ({
                text: el.textContent?.trim() || '',
                isVisible: (() => {
                    const style = window.getComputedStyle(el);
                    const rect = el.getBoundingClientRect();
                    return style.display !== 'none' &&
                           style.visibility !== 'hidden' &&
                           style.opacity !== '0' &&
                           rect.width > 0 &&
                           rect.height > 0;
                })(),
                height: el.getBoundingClientRect().height,
                classes: el.className,
                parentClasses: el.parentElement?.className || ''
            }));
        });

        // Log what we found for debugging
        logger.info('Found caption candidates:', JSON.stringify(captions, null, 2));

        // Filter and select the best caption
        const validCaptions = captions.filter((c: CaptionCandidate) => c.isVisible && c.text.length > 0);
        
        if (validCaptions.length === 0) {
            logger.warn('No valid captions found using primary selectors');
            
            // Fallback: Try to get caption using aria-label
            const ariaCaption = await post.$eval('article', (article: Element) => {
                const timeElement = article.querySelector('time');
                if (timeElement?.parentElement) {
                    return timeElement.parentElement.getAttribute('aria-label') || null;
                }
                return null;
            }).catch(() => null);

            if (ariaCaption) {
                logger.info('Found caption using aria-label fallback');
                return ariaCaption;
            }

            // Second fallback: Try to find any text content in the post header
            const headerText = await post.$eval('header', (header: Element) => {
                const textContent = header.textContent?.trim() || '';
                return textContent.length > 0 ? textContent : null;
            }).catch(() => null);

            if (headerText) {
                logger.info('Found caption in post header');
                return headerText;
            }

            return 'No caption found';
        }

        // Sort captions by length (usually the longest one is the full caption)
        validCaptions.sort((a: CaptionCandidate, b: CaptionCandidate) => b.text.length - a.text.length);
        
        const selectedCaption = validCaptions[0].text;
        logger.info(`Successfully extracted caption (${selectedCaption.length} chars): ${selectedCaption.substring(0, 100)}${selectedCaption.length > 100 ? '...' : ''}`);
        
        return selectedCaption;
    } catch (error) {
        logger.error('Error extracting caption:', error);
        return 'Error getting caption';
    }
}

async function hasAlreadyCommented(post: any, username: string | undefined): Promise<boolean> {
    try {
        if (!username) {
            logger.warn('No username provided to check for existing comments');
            return false;
        }

        // Updated comment selectors
        const commentSelectors = [
            'ul._a9ym',  // Comments container
            'div[role="menuitem"]',  // Individual comments
            'div._a9zr',  // Comment text container
            'span._aacl._aaco._aacu._aacx._aad7._aade'  // Comment text
        ];

        for (const selector of commentSelectors) {
            try {
                const comments = await post.$$(selector);
                logger.info(`Checking ${comments.length} elements with selector: ${selector}`);

                for (const comment of comments) {
                    const commentText = await comment.evaluate((el: HTMLElement) => {
                        const userElement = el.querySelector('a._a9zc');
                        const textElement = el.querySelector('span');
                        return {
                            username: userElement?.textContent?.trim(),
                            text: textElement?.textContent?.trim()
                        };
                    });

                    if (commentText?.username === username) {
                        logger.info(`Found existing comment by ${username}`);
                        return true;
                    }
                }
            } catch (error) {
                logger.debug(`Error checking comments with selector ${selector}:`, error);
                continue;
            }
        }

        logger.info(`No existing comments found from ${username}`);
        return false;
    } catch (error) {
        logger.error('Error checking for existing comments:', error);
        return false;
    }
}

async function logInteraction(interaction: PostInteraction) {
    try {
        postInteractions.push(interaction);
        
        // Enhanced logging
        logger.info('Post Interaction Log:', interaction);

        // Save to file for persistence
        const logPath = path.join(process.cwd(), 'logs', 'interactions.json');
        const existingLogs = fs.existsSync(logPath) 
            ? JSON.parse(fs.readFileSync(logPath, 'utf8')) 
            : [];
        
        existingLogs.push(interaction);
        fs.writeFileSync(logPath, JSON.stringify(existingLogs, null, 2));
        
        logger.info(`Interaction logged and saved to ${logPath}`);
    } catch (error) {
        logger.error('Error logging interaction:', error);
    }
}

async function runInstagram() {
    let browser: Browser | null = null;
    let proxyServer: Server | null = null;

    try {
        // Load environment variables with detailed logging
        const username = getValidatedUsername();
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
        logger.info(`Using proxy ${proxyHost}:${proxyPort}`);

        // Ensure cookies directory exists
        const cookiesDir = path.join(process.cwd(), 'cookies');
        if (!fs.existsSync(cookiesDir)) {
            logger.info('Creating cookies directory...');
            fs.mkdirSync(cookiesDir, { recursive: true });
        }
        
        const cookiesPath = path.join(cookiesDir, `Instagram_${username}_cookies.json`);

        // Start proxy server
        logger.info(`Starting proxy server on ${proxyHost}:${proxyPort}...`);
        proxyServer = new Server({ port: parseInt(proxyPort), host: proxyHost });
        await proxyServer.listen();
        logger.info('Proxy server started successfully');

        const proxyUrl = `http://${proxyHost}:${proxyPort}`;

        // Launch browser with improved settings
        logger.info('Launching browser...');
        browser = await puppeteer.launch({
            headless: false,
            args: [
                `--proxy-server=${proxyUrl}`,
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--window-size=1920,1080'
            ]
        });

        const page = await browser.newPage();
        await page.setViewport({ width: 1920, height: 1080 });

        // Set a random user agent
        const userAgent = new UserAgent({ deviceCategory: 'desktop' });
        await page.setUserAgent(userAgent.toString());

        logger.info('Browser launched successfully');

        // Check for existing cookies
        if (await Instagram_cookiesExist(cookiesPath)) {
            logger.info('Found existing cookies, attempting to use them...');
            try {
                const cookies = await loadCookies(cookiesPath);
                await page.setCookie(...cookies);
                logger.info('Cookies loaded successfully');

                // Verify login status
                await page.goto('https://www.instagram.com/', { waitUntil: 'networkidle0' });
                const isLoggedIn = await page.$('input[name="username"]') === null;

                if (isLoggedIn) {
                    logger.info('Successfully logged in with cookies');
                } else {
                    logger.warn('Cookie login failed, proceeding with credentials');
                    await loginWithCredentials(page, username, password, cookiesPath);
                }
            } catch (error) {
                logger.error('Error using cookies:', error);
                logger.info('Proceeding with credential login...');
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

    } catch (error: any) {
        logger.error('Error in Instagram bot:', error.message);
        if (error.stack) {
            logger.error('Stack trace:', error.stack);
        }
        throw error;
    } finally {
        // Cleanup
        if (browser) {
            logger.info('Closing browser...');
            await browser.close();
        }
        if (proxyServer) {
            logger.info('Stopping proxy server...');
            await proxyServer.close(true);
        }
        logger.info('Instagram bot cleanup completed');
    }
}

async function loginWithCredentials(page: any, username: string, password: string, cookiesPath: string) {
    try {
        logger.info('Starting login process...');
        
        // Navigate and wait for form simultaneously
        const [, usernameInput] = await Promise.all([
            page.goto('https://www.instagram.com/accounts/login/', {
                waitUntil: 'domcontentloaded' // Faster than networkidle0
            }),
            page.waitForSelector('input[name="username"]', {
                visible: true,
                timeout: 10000
            })
        ]);

        // Fill credentials in parallel
        logger.info('Entering credentials...');
        await Promise.all([
            page.type('input[name="username"]', username),
            page.type('input[name="password"]', password)
        ]);
        
        // Submit and wait for navigation
        logger.info('Submitting login form...');
        await Promise.all([
            page.click('button[type="submit"]'),
            page.waitForNavigation({
                waitUntil: 'domcontentloaded'
            })
        ]);

        // Quick check for login success
        const loginError = await page.$('p[role="alert"]');
        if (loginError) {
            const errorText = await page.evaluate((el: any) => el.textContent, loginError);
            throw new Error(`Login failed: ${errorText}`);
        }

        // Verify login with inbox link
        const isLoggedIn = await page.$('a[href="/direct/inbox/"]')
            .then((element: any) => !!element)
            .catch(() => false);

        if (!isLoggedIn) {
            throw new Error('Login verification failed - inbox link not found');
        }

        logger.info('Login successful');

        // Save cookies
        logger.info('Saving cookies...');
        const cookies = await page.cookies();
        await saveCookies(cookiesPath, cookies);
        logger.info('Cookies saved successfully');

    } catch (error: any) {
        logger.error('Error during login:', error.message);
        if (error.stack) {
            logger.error('Login error stack trace:', error.stack);
        }
        throw error;
    }
}

async function testLikeButtonMethods(post: any, postIndex: number): Promise<boolean> {
    try {
        logger.info(`Testing like button methods for post ${postIndex}...`);

        // Method 1: Try clicking the like button directly
        const likeButton = await post.$('svg[aria-label="Like"]');
        if (likeButton) {
            await likeButton.click();
            await delay(2000);
            const success = await validateLikeSubmission(post);
            if (success) {
                logger.info('Successfully liked post using direct click');
                return true;
            }
        }

        // Method 2: Try clicking with coordinates
        try {
            const result = await clickLikeButtonWithCoordinates(post);
            if (result) {
                await delay(2000);
                const success = await validateLikeSubmission(post);
                if (success) {
                    logger.info('Successfully liked post using coordinates');
                    return true;
                }
            }
        } catch (error) {
            logger.warn('Error clicking like button with coordinates:', error);
        }

        logger.warn('All like button methods failed');
        return false;
    } catch (error) {
        logger.error('Error in testLikeButtonMethods:', error);
        return false;
    }
}

async function validateLikeSubmission(post: any): Promise<boolean> {
    try {
        const unlikeButton = await post.$('svg[aria-label="Unlike"]');
        return !!unlikeButton;
    } catch (error) {
        logger.warn('Error validating like submission:', error);
        return false;
    }
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
    } catch (error) {
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
    } catch (error) {
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
        } catch (error) {
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
    } catch (error) {
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
    } catch (error) {
        logger.warn('Error in clickExactCenter:', error instanceof Error ? error.message : String(error));
        return false;
    }
}

async function clickLikeButtonWithCoordinates(post: any): Promise<boolean> {
    try {
        const likeButton = await post.$('svg[aria-label="Like"]');
        if (!likeButton) {
            return false;
        }

        const box = await likeButton.boundingBox();
        if (!box) {
            return false;
        }

        // Click in the center of the like button
        await post.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 10 });
        await delay(100);
        await post.mouse.down();
        await delay(100);
        await post.mouse.up();

        return true;
    } catch (error) {
        logger.warn('Error clicking like button with coordinates:', error);
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
                    (button as HTMLElement).click(); // Type assertion to HTMLElement
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
                const validation = await validateCommentSubmission(post);
                if (validation) {
                    logger.info(`SUCCESS: Comment posted using ${method.name} - ${validation}`);
                    return true;
                }
                logger.info(`${method.name} clicked but comment not verified - ${validation}`);
            }
        } catch (error) {
            logger.warn(`${method.name} failed:`, error instanceof Error ? error.message : String(error));
            continue;
        }
    }

    return false;
}

async function postComment(post: any, commentText: string): Promise<boolean> {
    try {
        logger.info('Starting comment posting process...');

        // Find and click the comment input area
        const commentArea = await post.$('textarea[aria-label="Add a comment…"]');
        if (!commentArea) {
            logger.warn('Could not find comment input area');
            return false;
        }

        // Click the comment area and wait for it to be ready
        await commentArea.click();
        await delay(1000);

        // Clear any existing text
        await post.evaluate(() => {
            const textarea = document.querySelector('textarea[aria-label="Add a comment…"]') as HTMLTextAreaElement;
            if (textarea) textarea.value = '';
        });
        await delay(500);

        // Type the comment text character by character
        for (const char of commentText) {
            await commentArea.type(char, { delay: 50 });
        }
        await delay(1000);

        // Try multiple methods to submit the comment
        let success = false;

        // Method 1: Press Enter key
        try {
            await commentArea.press('Enter');
            await delay(2000);
            success = await validateCommentSubmission(post);
            if (success) {
                logger.info('Comment posted successfully using Enter key');
                return true;
            }
        } catch (error) {
            logger.warn('Enter key method failed:', error);
        }

        // Method 2: Find and click the Post button
        if (!success) {
            try {
                const postButton = await findPostButton(post);
                if (postButton) {
                    await postButton.click();
                    await delay(2000);
                    success = await validateCommentSubmission(post);
                    if (success) {
                        logger.info('Comment posted successfully using Post button');
                        return true;
                    }
                }
            } catch (error) {
                logger.warn('Post button method failed:', error);
            }
        }

        // Method 3: Use keyboard shortcut (Ctrl+Enter)
        if (!success) {
            try {
                await commentArea.focus();
                await post.keyboard.down('Control');
                await commentArea.press('Enter');
                await post.keyboard.up('Control');
                await delay(2000);
                success = await validateCommentSubmission(post);
                if (success) {
                    logger.info('Comment posted successfully using Ctrl+Enter');
                    return true;
                }
            } catch (error) {
                logger.warn('Ctrl+Enter method failed:', error);
            }
        }

        // Method 4: Simulate form submission
        if (!success) {
            try {
                await post.evaluate(() => {
                    const form = document.querySelector('form');
                    if (form) {
                        const submitEvent = new Event('submit', { bubbles: true, cancelable: true });
                        form.dispatchEvent(submitEvent);
                    }
                });
                await delay(2000);
                success = await validateCommentSubmission(post);
                if (success) {
                    logger.info('Comment posted successfully using form submission');
                    return true;
                }
            } catch (error) {
                logger.warn('Form submission method failed:', error);
            }
        }

        logger.warn('All comment posting methods failed');
        return false;
    } catch (error) {
        logger.error('Error posting comment:', error);
        return false;
    }
}

async function validateCommentSubmission(post: any): Promise<boolean> {
    try {
        // Check if comment box is empty (indicating successful post)
        const commentBox = await post.$('textarea[aria-label="Add a comment…"]');
        if (commentBox) {
            const value = await commentBox.evaluate((el: HTMLTextAreaElement) => el.value);
            if (!value) {
                // Also check if the post button is disabled (another indicator of success)
                const postButton = await post.$('button[type="submit"]');
                if (postButton) {
                    const isDisabled = await postButton.evaluate((el: HTMLButtonElement) => el.disabled);
                    if (isDisabled) {
                        return true;
                    }
                }
            }
        }
        return false;
    } catch (error) {
        logger.warn('Error validating comment submission:', error);
        return false;
    }
}

async function testCommentMethods(post: any, postIndex: number): Promise<boolean> {
    const username = getValidatedUsername();
    
    // First check if we've already commented
    const alreadyCommented = await hasAlreadyCommented(post, username);
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

async function interactWithPosts(page: any) {
    try {
        logger.info('Starting post interaction process...');
        
        // Ensure we're on the home feed
        logger.info('Ensuring we are on the home feed...');
        await page.goto('https://www.instagram.com', { waitUntil: 'networkidle0' });
        await delay(3000);

        // Wait for posts to load with increased timeout
        logger.info('Waiting for posts to load...');
        await page.waitForSelector('article', { timeout: 15000 });
        
        // Get all posts
        const posts = await page.$$('article');
        logger.info(`Found ${posts.length} posts`);

        // Process each post
        for (let i = 0; i < posts.length; i++) {
            const post = posts[i];
            logger.info(`Processing post ${i + 1}...`);

            try {
                // Scroll post into view and wait for content
                await scrollAndWaitForContent(post);
                await delay(2000);

                // Get caption
                logger.info('Attempting to extract caption...');
                const caption = await getPostCaption(post);
                logger.info(`Post ${i + 1} caption: ${caption}`);

                // Check if we've already commented
                const username = getValidatedUsername();
                const hasCommented = await hasAlreadyCommented(post, username);
                
                if (hasCommented) {
                    logger.info(`Already commented on post ${i + 1}, skipping...`);
                    continue;
                }

                // Try to like the post
                const likeResult = await testLikeButtonMethods(post, i + 1);
                
                if (likeResult) {
                    // Verify like status
                    await delay(2000);
                    const isLiked = await validateLikeSubmission(post);
                    if (isLiked) {
                        logger.info(`Successfully verified like on post ${i + 1}`);
                    }
                }

                // Generate and post comment
                const commentText = await generateComment(caption);
                if (commentText) {
                    const commentSuccess = await postComment(post, commentText);
                    
                    if (commentSuccess) {
                        // Verify comment
                        const validation = await validateCommentSubmission(post);
                        if (validation) {
                            logger.info(`Successfully verified comment on post ${i + 1}`);
                        } else {
                            logger.warn(`Could not verify comment on post ${i + 1}`);
                        }
                    }
                }

                // Log interaction
                const interaction: PostInteraction = {
                    postIndex: i + 1,
                    timestamp: new Date().toISOString(),
                    caption: caption || 'Error getting caption',
                    likeMethod: likeResult ? 'Success' : null,
                    commentMethod: commentText ? 'Success' : null,
                    commentText: commentText,
                    success: true,
                    details: `Interaction completed with ${likeResult ? 'like' : 'no like'} and ${commentText ? 'comment' : 'no comment'}`
                };

                logInteraction(interaction);
                
                // Wait before processing next post
                await delay(3000);

            } catch (error) {
                logger.error(`Error processing post ${i + 1}:`, error);
                continue;
            }
        }

        logger.info('Post interactions completed successfully');
    } catch (error) {
        logger.error('Error during post interactions:', error);
        throw error;
    }
}

async function generateComment(caption: string): Promise<string | null> {
    try {
        // TODO: Implement AI-based comment generation
        return "Great post! 👍";
    } catch (error) {
        logger.error('Error generating comment:', error);
        return null;
    }
}

export { runInstagram };
