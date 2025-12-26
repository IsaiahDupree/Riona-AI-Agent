// Simplified Instagram bot that focuses on core functionality
require('dotenv').config();
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { delay, randomJitter, humanLikeDelay, humanTyping, naturalMouseMovement } = require('./src/utils/jitter'); 
const winston = require('winston');

// Configure logger
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.printf(info => `[${new Date(info.timestamp).toLocaleString()}] ${info.level.toUpperCase()}: ${info.message}`)
    ),
    transports: [
        new winston.transports.Console(),
        new winston.transports.File({ filename: 'instagram-bot.log' })
    ]
});

// Add stealth plugin
puppeteer.use(StealthPlugin());

class SimplifiedInstagramBot {
    constructor() {
        this.browser = null;
        this.page = null;
        this.loggedIn = false;
        this.username = process.env.INSTAGRAM_BOT_USERNAME;
        this.password = process.env.INSTAGRAM_BOT_PASSWORD;
    }
    
    async init() {
        try {
            logger.info('Initializing SimplifiedInstagramBot...');
            
            // Launch browser
            logger.info('Launching browser...');
            this.browser = await puppeteer.launch({
                headless: false,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-infobars',
                    '--window-position=0,0',
                    '--ignore-certificate-errors',
                    '--ignore-certificate-errors-spki-list'
                ]
            });
            logger.info('Browser launched successfully');
            
            // Create new page
            this.page = await this.browser.newPage();
            logger.info('Page created successfully');
            
            // Set random user agent
            await this.page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36');
            
            // Configure viewport
            await this.page.setViewport({
                width: randomJitter(1280, 0.1),
                height: randomJitter(800, 0.1),
                deviceScaleFactor: 1,
                hasTouch: false,
                isLandscape: true,
                isMobile: false,
            });
            
            logger.info('Browser configuration complete');
            return true;
        } catch (error) {
            logger.error('Error during initialization:', error);
            return false;
        }
    }
    
    async login() {
        try {
            logger.info('Starting login process...');
            
            if (!this.page) {
                logger.error('Page is not initialized');
                return false;
            }
            
            // Test connection
            logger.info('Testing connection...');
            await this.page.goto('https://www.instagram.com/robots.txt', { 
                waitUntil: 'domcontentloaded',
                timeout: randomJitter(8000, 0.2)
            });
            await delay(humanLikeDelay(500, 1500));
            
            // Navigate to login page
            logger.info('Navigating to login page...');
            await this.page.goto('https://www.instagram.com/accounts/login/', { 
                waitUntil: 'networkidle0',
                timeout: randomJitter(30000, 0.2)
            });
            
            // Wait for a random period to simulate a human looking at the page
            await delay(humanLikeDelay(1000, 3000));
            
            // Check for and handle cookie consent banner
            const consentSelectors = [
                'button[tabindex="0"]:not([disabled])',
                'button:has-text("Accept")',
                'button:has-text("Accept All")',
                'button:has-text("Allow")'
            ];
            
            for (const selector of consentSelectors) {
                try {
                    const consentButton = await this.page.$(selector);
                    if (consentButton) {
                        logger.info(`Found cookie consent button: ${selector}`);
                        await naturalMouseMovement(this.page, selector);
                        await delay(humanLikeDelay(500, 1500));
                        break;
                    }
                } catch (error) {
                    // Continue to next selector
                }
            }
            
            // Find username and password fields
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
                    await this.page.waitForSelector(selector, { timeout: 5000 });
                    usernameSelector = selector;
                    break;
                } catch (error) {
                    // Continue to next selector
                }
            }
            
            // Try each password selector
            let passwordSelector = '';
            for (const selector of passwordSelectors) {
                try {
                    await this.page.waitForSelector(selector, { timeout: 5000 });
                    passwordSelector = selector;
                    break;
                } catch (error) {
                    // Continue to next selector
                }
            }
            
            if (!usernameSelector || !passwordSelector) {
                logger.error('Could not find login form selectors');
                return false;
            }
            
            // Enter credentials with human-like typing
            logger.info('Entering credentials...');
            await humanTyping(this.page, usernameSelector, this.username);
            await delay(humanLikeDelay(500, 2000));
            await humanTyping(this.page, passwordSelector, this.password);
            await delay(humanLikeDelay(800, 2000));
            
            // Submit form
            try {
                const submitButton = await this.page.$('button[type="submit"]');
                if (submitButton) {
                    await naturalMouseMovement(this.page, 'button[type="submit"]');
                    logger.info('Submitted form by clicking submit button');
                }
            } catch (error) {
                logger.warn('Could not click submit button, trying Enter key...');
                await this.page.keyboard.press('Enter');
            }
            
            // Wait for navigation
            await delay(humanLikeDelay(2000, 5000));
            
            // Check if successfully logged in
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
                    await this.page.waitForSelector(selector, { timeout: 5000 });
                    loggedIn = true;
                    break;
                } catch (error) {
                    // Continue checking other selectors
                }
            }
            
            if (loggedIn) {
                logger.info('Successfully logged in!');
                this.loggedIn = true;
                
                // Close any dialogs
                const closeDialogSelectors = [
                    'button:has-text("Not Now")',
                    'button[tabindex="0"]:not([disabled])'
                ];
                
                for (const selector of closeDialogSelectors) {
                    try {
                        const closeButton = await this.page.$(selector);
                        if (closeButton) {
                            logger.info('Closing post-login dialog...');
                            await naturalMouseMovement(this.page, selector);
                            await delay(humanLikeDelay(500, 1500));
                            break;
                        }
                    } catch (error) {
                        // Continue to next selector
                    }
                }
                
                // Take a screenshot for verification
                await this.page.screenshot({ path: 'instagram-login-success.png' });
                logger.info('Login screenshot saved to instagram-login-success.png');
                
                return true;
            } else {
                logger.error('Login failed - could not find post-login elements');
                await this.page.screenshot({ path: 'instagram-login-failed.png' });
                return false;
            }
        } catch (error) {
            logger.error('Error during login:', error);
            return false;
        }
    }
    
    async exploreFeed() {
        try {
            if (!this.loggedIn) {
                logger.error('Not logged in, cannot explore feed');
                return false;
            }
            
            logger.info('Exploring Instagram feed...');
            
            // Navigate to homepage
            await this.page.goto('https://www.instagram.com/', { 
                waitUntil: 'networkidle2',
                timeout: randomJitter(30000, 0.2)
            });
            
            // Scroll down to load more content
            logger.info('Scrolling feed...');
            
            // Scroll a few times with random pauses
            const scrollCount = 3 + Math.floor(Math.random() * 3);
            
            for (let i = 0; i < scrollCount; i++) {
                await this.page.evaluate(() => {
                    window.scrollBy(0, 500 + Math.random() * 300);
                });
                
                // Pause like a human would
                await delay(humanLikeDelay(1000, 3000));
                
                // Occasionally stop to look at a post (50% chance)
                if (Math.random() < 0.5) {
                    logger.info('Pausing to view content...');
                    await delay(humanLikeDelay(2000, 6000));
                }
            }
            
            // Try finding and liking a random post
            try {
                // Find all like buttons that aren't already liked
                const likeButtons = await this.page.$$('svg[aria-label="Like"]');
                
                if (likeButtons.length > 0) {
                    // Choose a random post to like
                    const randomIndex = Math.floor(Math.random() * likeButtons.length);
                    const targetButton = likeButtons[randomIndex];
                    
                    logger.info(`Found ${likeButtons.length} potential posts to like, selecting one...`);
                    
                    // Like the post with natural movement
                    await targetButton.click();
                    logger.info('Liked a post');
                    
                    // Pause after liking
                    await delay(humanLikeDelay(1000, 3000));
                } else {
                    logger.info('No posts available to like');
                }
            } catch (error) {
                logger.warn('Error while trying to like a post:', error);
            }
            
            // Take a screenshot of our activity
            await this.page.screenshot({ path: 'instagram-feed-exploration.png' });
            logger.info('Feed exploration screenshot saved to instagram-feed-exploration.png');
            
            return true;
        } catch (error) {
            logger.error('Error during feed exploration:', error);
            return false;
        }
    }
    
    async close() {
        try {
            if (this.browser) {
                logger.info('Closing browser...');
                await this.browser.close();
                logger.info('Browser closed successfully');
            }
        } catch (error) {
            logger.error('Error closing browser:', error);
        }
    }
}

// Run the bot
async function runBot() {
    const bot = new SimplifiedInstagramBot();
    
    try {
        logger.info('Starting simplified Instagram bot...');
        
        // Initialize
        const initSuccess = await bot.init();
        if (!initSuccess) {
            logger.error('Bot initialization failed');
            return;
        }
        
        // Login
        const loginSuccess = await bot.login();
        if (!loginSuccess) {
            logger.error('Login failed');
            await bot.close();
            return;
        }
        
        // Explore feed
        await bot.exploreFeed();
        
        // Run time - keep browser open for examination
        logger.info('Bot run completed successfully');
        logger.info('Keeping browser open for 30 seconds for examination...');
        await delay(30000);
    } catch (error) {
        logger.error('Error running bot:', error);
    } finally {
        await bot.close();
        logger.info('Bot execution finished');
    }
}

// Start the bot
runBot();
