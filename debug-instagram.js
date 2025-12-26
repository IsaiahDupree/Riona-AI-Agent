// Simple debug script to troubleshoot Instagram bot initialization
require('dotenv').config();
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

console.log('[DEBUG] Starting Instagram debug script');
console.log('[DEBUG] Environment loaded');

// Add stealth plugin only
puppeteer.use(StealthPlugin());
console.log('[DEBUG] StealthPlugin added');

async function debugInstagram() {
    let browser = null;
    
    try {
        console.log('[DEBUG] Preparing to launch browser');
        
        // Print proxy settings
        console.log('[DEBUG] Proxy settings:', {
            enabled: process.env.INSTAGRAM_USE_PROXY === 'true',
            host: process.env.PROXY_HOST || 'not set',
            port: process.env.PROXY_PORT || 'not set'
        });

        // Launch options
        const launchOptions = {
            headless: false,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-infobars',
                '--window-position=0,0',
                '--ignore-certificate-errors',
                '--ignore-certificate-errors-spki-list'
            ]
        };
        
        console.log('[DEBUG] Launch options configured:', JSON.stringify(launchOptions));
        
        // Launch browser
        console.log('[DEBUG] Launching browser...');
        browser = await puppeteer.launch(launchOptions);
        console.log('[DEBUG] Browser launched successfully!');
        
        // Create a new page
        console.log('[DEBUG] Creating new page...');
        const page = await browser.newPage();
        console.log('[DEBUG] Page created successfully!');
        
        // Set user agent
        console.log('[DEBUG] Setting user agent...');
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36');
        
        // Configure viewport
        console.log('[DEBUG] Setting viewport...');
        await page.setViewport({ width: 1280, height: 800 });
        
        // Navigate to Instagram
        console.log('[DEBUG] Navigating to Instagram...');
        await page.goto('https://www.instagram.com', { 
            waitUntil: 'networkidle2',
            timeout: 60000 
        });
        console.log('[DEBUG] Navigation to Instagram successful!');
        
        // Get current URL
        const currentUrl = await page.url();
        console.log(`[DEBUG] Current URL: ${currentUrl}`);
        
        // Check page title
        const title = await page.title();
        console.log(`[DEBUG] Page title: ${title}`);
        
        // Wait a few seconds
        console.log('[DEBUG] Waiting 5 seconds...');
        await new Promise(resolve => setTimeout(resolve, 5000));
        
        // Take a screenshot for debugging
        console.log('[DEBUG] Taking screenshot...');
        await page.screenshot({ path: 'instagram-debug.png' });
        console.log('[DEBUG] Screenshot saved to instagram-debug.png');
        
        console.log('[DEBUG] Debug test completed successfully');
        
        // Close browser
        console.log('[DEBUG] Closing browser...');
        await browser.close();
        console.log('[DEBUG] Browser closed');
        
        return true;
    } catch (error) {
        console.error('[DEBUG] Error during test:', error);
        
        // Try to close browser if it was created
        if (browser) {
            try {
                await browser.close();
                console.log('[DEBUG] Browser closed after error');
            } catch (closeError) {
                console.error('[DEBUG] Error closing browser:', closeError);
            }
        }
        
        return false;
    }
}

// Run the debug function
console.log('[DEBUG] Starting Instagram debug process');
debugInstagram()
    .then(success => {
        if (success) {
            console.log('[DEBUG] Debug process completed successfully!');
        } else {
            console.log('[DEBUG] Debug process failed!');
        }
        process.exit(0);
    })
    .catch(error => {
        console.error('[DEBUG] Unhandled error in debug process:', error);
        process.exit(1);
    });
