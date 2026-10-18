const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
// Removing the adblocker plugin that's causing timeout issues
// const AdblockerPlugin = require('puppeteer-extra-plugin-adblocker');

// Add stealth plugin only
puppeteer.use(StealthPlugin());
// puppeteer.use(AdblockerPlugin({ blockTrackers: true }));

async function testLaunch() {
    console.log('Starting browser test...');
    
    try {
        // Launch browser
        console.log('Launching browser...');
        const browser = await puppeteer.launch({
            headless: false,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-infobars',
                '--window-position=0,0',
                '--ignore-certificate-errors',
                '--ignore-certificate-errors-spki-list',
                '--user-agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36"'
            ]
        });
        
        console.log('Browser launched successfully!');
        
        // Create a new page
        const page = await browser.newPage();
        console.log('Page created successfully!');
        
        // Configure viewport
        await page.setViewport({ width: 1280, height: 800 });
        
        // Navigate to a test page
        console.log('Navigating to test page...');
        await page.goto('https://www.example.com', { waitUntil: 'networkidle2' });
        console.log('Navigation successful!');
        
        // Get the page title
        const title = await page.title();
        console.log(`Page title: ${title}`);
        
        // Wait a few seconds
        await new Promise(resolve => setTimeout(resolve, 5000));
        
        // Close browser
        console.log('Closing browser...');
        await browser.close();
        console.log('Browser closed successfully!');
        
        return true;
    } catch (error) {
        console.error('Error during test:', error);
        return false;
    }
}

// Run the test
testLaunch()
    .then(success => {
        if (success) {
            console.log('Test completed successfully!');
        } else {
            console.log('Test failed!');
        }
        process.exit(0);
    })
    .catch(error => {
        console.error('Unhandled error:', error);
        process.exit(1);
    });
