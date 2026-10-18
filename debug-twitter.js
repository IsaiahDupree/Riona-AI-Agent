/**
 * Debug: Check Twitter session, take screenshot, verify login state
 */
require('dotenv').config();

async function debug() {
    const puppeteer = require('puppeteer-extra');
    const StealthPlugin = require('puppeteer-extra-plugin-stealth');
    puppeteer.use(StealthPlugin());

    const browser = await puppeteer.launch({
        headless: false,
        defaultViewport: null,
        executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        userDataDir: './chrome-profile-twitter',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled',
            '--window-size=1280,900',
        ],
    });

    const pages = await browser.pages();
    const page = pages[0] || await browser.newPage();

    try {
        console.log('Navigating to X.com home...');
        await page.goto('https://x.com/home', { waitUntil: 'networkidle2', timeout: 30000 });
        await new Promise(r => setTimeout(r, 3000));

        const url = page.url();
        console.log('URL:', url);

        await page.screenshot({ path: 'debug-twitter-home.png', fullPage: false });
        console.log('Screenshot saved: debug-twitter-home.png');

        // Check login state
        const isLoggedIn = !url.includes('/login') && !url.includes('/i/flow');
        console.log('Logged in:', isLoggedIn);

        if (isLoggedIn) {
            // Check DM inbox
            console.log('\nNavigating to DM inbox...');
            await page.goto('https://x.com/messages', { waitUntil: 'networkidle2', timeout: 30000 });
            await new Promise(r => setTimeout(r, 3000));
            await page.screenshot({ path: 'debug-twitter-dm.png', fullPage: false });
            console.log('DM URL:', page.url());
            console.log('DM screenshot saved: debug-twitter-dm.png');

            // List aria-labels
            const labels = await page.evaluate(() => {
                const els = document.querySelectorAll('[aria-label]');
                return Array.from(els).slice(0, 20).map(el => ({
                    tag: el.tagName.toLowerCase(),
                    label: el.getAttribute('aria-label'),
                    y: Math.round(el.getBoundingClientRect().y),
                }));
            });
            console.log('\nTop aria-labels:');
            for (const l of labels) {
                console.log(`  <${l.tag} aria-label="${l.label}"> y=${l.y}`);
            }
        }
    } catch (err) {
        console.error('Error:', err.message);
        await page.screenshot({ path: 'debug-twitter-error.png', fullPage: false });
    } finally {
        await browser.close();
    }
}

debug().catch(console.error);
