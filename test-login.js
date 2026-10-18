// Test script focusing only on Instagram login with jitter
require('dotenv').config();
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

// Add jitter/randomization functions similar to our TypeScript implementation
function randomJitter(baseValue, jitterPercent = 0.1) {
    const jitterRange = baseValue * jitterPercent;
    return Math.floor(baseValue + (Math.random() * 2 - 1) * jitterRange);
}

function humanLikeDelay(min, max) {
    return min + Math.random() * (max - min);
}

async function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function humanTyping(page, selector, text) {
    await page.focus(selector);
    
    // Clear any existing text
    await page.evaluate(selector => {
        document.querySelector(selector).value = "";
    }, selector);
    
    // Type with variable speed like a human
    for (let i = 0; i < text.length; i++) {
        const char = text.charAt(i);
        await page.type(selector, char, { delay: randomJitter(100, 0.5) });
        
        // Occasionally pause like a human would
        if (Math.random() < 0.1) {
            await delay(humanLikeDelay(200, 600));
        }
    }
}

async function naturalMouseMovement(page, selector) {
    try {
        // Get element position and dimensions
        const elementHandle = await page.$(selector);
        if (!elementHandle) {
            console.log(`Element with selector ${selector} not found for mouse movement`);
            return;
        }
        
        const box = await elementHandle.boundingBox();
        if (!box) {
            console.log(`Could not get bounding box for ${selector}`);
            return;
        }
        
        // Calculate target point with some randomness (not exactly the center)
        const targetX = box.x + box.width * (0.4 + Math.random() * 0.2);
        const targetY = box.y + box.height * (0.4 + Math.random() * 0.2);
        
        // Get current mouse position or assume center of screen
        const currentPosition = await page.evaluate(() => {
            return { x: window.innerWidth / 2, y: window.innerHeight / 2 };
        });
        
        // Generate intermediate points for natural curve movement
        const numSteps = randomJitter(10, 0.3);
        const points = [];
        
        // Create slightly curved path
        for (let i = 0; i <= numSteps; i++) {
            const ratio = i / numSteps;
            
            // Add slight curve using sine function
            const deviation = Math.sin(ratio * Math.PI) * (Math.random() * 20 + 5);
            const deviationX = deviation * (Math.random() > 0.5 ? 1 : -1);
            const deviationY = deviation * (Math.random() > 0.5 ? 1 : -1);
            
            const x = currentPosition.x + (targetX - currentPosition.x) * ratio + deviationX;
            const y = currentPosition.y + (targetY - currentPosition.y) * ratio + deviationY;
            
            points.push({ x, y });
        }
        
        // Ensure final point is exact target
        points[points.length - 1] = { x: targetX, y: targetY };
        
        // Move the mouse along the path with variable speed
        for (let i = 0; i < points.length; i++) {
            const point = points[i];
            const speedFactor = 1 - Math.sin(i / points.length * Math.PI) * 0.5;
            await page.mouse.move(point.x, point.y, { steps: randomJitter(5, 0.3) });
            await delay(humanLikeDelay(10, 20) * speedFactor);
        }
        
        // Slight pause before clicking, like a human
        await delay(humanLikeDelay(100, 300));
        
        // Click with variable delay
        await page.mouse.down();
        await delay(humanLikeDelay(20, 100));
        await page.mouse.up();
        
        console.log(`Successfully clicked on ${selector} with natural movement`);
    } catch (error) {
        console.error('Error during natural mouse movement:', error);
        // Fallback to direct click if movement fails
        await page.click(selector);
    }
}

// Main login function with our jitter enhancements
async function loginWithCredentials(page, username, password) {
    try {
        console.log('Starting login process with credentials...');
        
        console.log('Testing connection before login...');
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
            console.log('Empty response detected during connection test. Possible IP blocking.');
            return false;
        }
        
        console.log('Connection test passed, proceeding to login...');
        
        // Navigate to login page with randomized timing
        console.log('Navigating to login page...');
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
                    console.log(`Found cookie consent button: ${selector}`);
                    await naturalMouseMovement(page, selector);
                    await delay(humanLikeDelay(500, 1500));
                    break;
                }
            } catch (error) {
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
            } catch (error) {
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
            } catch (error) {
                // Continue to next selector
            }
        }
        
        if (!usernameSelector || !passwordSelector) {
            console.error('Could not find login form selectors');
            return false;
        }
        
        // Occasionally move mouse randomly before starting to type
        if (Math.random() < 0.7) {
            const randomX = 100 + Math.floor(Math.random() * 400);
            const randomY = 100 + Math.floor(Math.random() * 200);
            await page.mouse.move(randomX, randomY);
            await delay(humanLikeDelay(200, 800));
        }
        
        // Fill credentials with human-like typing
        console.log('Entering credentials...');
        await humanTyping(page, usernameSelector, username);
        
        // Pause like a human would between username and password
        await delay(humanLikeDelay(500, 2000));
        
        await humanTyping(page, passwordSelector, password);
        
        // Pause before submission like a human would
        await delay(humanLikeDelay(800, 2000));
        
        // Submit form with natural mouse movement
        try {
            const submitButton = await page.$('button[type="submit"]');
            if (submitButton) {
                await naturalMouseMovement(page, 'button[type="submit"]');
                console.log('Submitted form by clicking submit button');
            }
        } catch (error) {
            console.warn('Could not click submit button, trying alternate methods...');
            
            // Try pressing Enter
            try {
                await page.keyboard.press('Enter');
                console.log('Submitted form by pressing Enter');
            } catch (enterError) {
                console.error('All form submission methods failed');
                return false;
            }
        }
        
        // Wait for navigation with random jitter
        await delay(humanLikeDelay(2000, 5000));
        
        // Check if we are successfully logged in
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
            } catch (error) {
                // Continue checking other selectors
            }
        }
        
        if (loggedIn) {
            console.log('Successfully logged in!');
            
            // Sometimes Instagram shows a dialog after login, try to close it
            const closeDialogSelectors = [
                'button:has-text("Not Now")',
                'button[tabindex="0"]:not([disabled])'
            ];
            
            for (const selector of closeDialogSelectors) {
                try {
                    const closeButton = await page.$(selector);
                    if (closeButton) {
                        console.log('Closing post-login dialog...');
                        await naturalMouseMovement(page, selector);
                        await delay(humanLikeDelay(500, 1500));
                        break;
                    }
                } catch (error) {
                    // Continue to next selector
                }
            }
            
            return true;
        } else {
            console.error('Login appeared to succeed but could not find post-login elements');
            return false;
        }
    } catch (error) {
        console.error('Login failed with error:', error);
        return false;
    }
}

// Main test function
async function testInstagramLogin() {
    console.log('Starting Instagram login test');
    
    // Add stealth plugin
    puppeteer.use(StealthPlugin());
    console.log('Stealth plugin added');
    
    let browser = null;
    
    try {
        // Launch browser
        console.log('Launching browser...');
        browser = await puppeteer.launch({
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
        console.log('Browser launched successfully!');
        
        // Create a new page
        const page = await browser.newPage();
        console.log('Page created successfully!');
        
        // Set user agent
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36');
        
        // Configure viewport
        await page.setViewport({ width: 1280, height: 800 });
        
        // Get credentials from environment
        const username = process.env.INSTAGRAM_BOT_USERNAME;
        const password = process.env.INSTAGRAM_BOT_PASSWORD;
        
        if (!username || !password) {
            console.error('Missing Instagram credentials in .env file');
            return false;
        }
        
        console.log(`Using Instagram account: ${username}`);
        
        // Attempt login
        const loginSuccess = await loginWithCredentials(page, username, password);
        
        if (loginSuccess) {
            console.log('Login test completed successfully!');
            
            // Take a screenshot for verification
            await page.screenshot({ path: 'instagram-login-success.png' });
            console.log('Screenshot saved to instagram-login-success.png');
            
            // Wait some time to observe the result
            console.log('Waiting 10 seconds before closing...');
            await delay(10000);
        } else {
            console.error('Login test failed');
            
            // Take a screenshot for debugging
            await page.screenshot({ path: 'instagram-login-failed.png' });
            console.log('Error screenshot saved to instagram-login-failed.png');
        }
        
        return loginSuccess;
    } catch (error) {
        console.error('Error during test:', error);
        return false;
    } finally {
        // Close browser
        if (browser) {
            console.log('Closing browser...');
            await browser.close();
            console.log('Browser closed');
        }
    }
}

// Run the test
console.log('Starting Instagram login test script');
testInstagramLogin()
    .then(success => {
        if (success) {
            console.log('Instagram login test completed successfully!');
        } else {
            console.log('Instagram login test failed!');
        }
        process.exit(0);
    })
    .catch(error => {
        console.error('Unhandled error in test script:', error);
        process.exit(1);
    });
