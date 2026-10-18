/**
 * Manual Threads login helper
 * Opens Chrome with the Threads profile, navigates to login.
 * You complete login manually (2FA, captcha, etc.)
 * Saves cookies when done, then exits.
 *
 * Usage: npx ts-node src/threads-login.ts
 *   or:  node build/threads-login.js
 */

import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import * as path from 'path';
import * as fs from 'fs';
import dotenv from 'dotenv';

dotenv.config({ override: true });
puppeteer.use(StealthPlugin());

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const THREADS_PROFILE = path.join(process.cwd(), 'chrome-profile-threads');
const COOKIES_PATH = path.join(process.cwd(), 'cookies', `threads_${process.env.THREADS_BOT_USERNAME || 'default'}_cookies.json`);

async function manualLogin() {
    console.log('=== Threads Manual Login Helper ===');
    console.log(`Chrome profile: ${THREADS_PROFILE}`);
    console.log(`Cookie file: ${COOKIES_PATH}`);
    console.log('');

    if (!fs.existsSync(THREADS_PROFILE)) {
        fs.mkdirSync(THREADS_PROFILE, { recursive: true });
    }

    const browser = await puppeteer.launch({
        headless: false,
        defaultViewport: null,
        executablePath: CHROME_PATH,
        userDataDir: THREADS_PROFILE,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--window-position=100,100',
            '--window-size=1200,900',
            '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
        ]
    });

    const page = await browser.newPage();

    // Load existing cookies if any
    if (fs.existsSync(COOKIES_PATH)) {
        const cookies = JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf8'));
        await page.setCookie(...cookies);
        console.log('Loaded existing cookies');
    }

    // Navigate to Threads login
    console.log('Navigating to threads.net/login ...');
    await page.goto('https://www.threads.net/login', { waitUntil: 'networkidle2', timeout: 30000 });

    console.log('');
    console.log('======================================');
    console.log('  Please complete the login manually  ');
    console.log('  in the Chrome window.               ');
    console.log('                                      ');
    console.log('  Once you see the Threads feed,      ');
    console.log('  come back here and press Enter.     ');
    console.log('======================================');
    console.log('');

    // Wait for user to press Enter
    await new Promise<void>((resolve) => {
        process.stdin.once('data', () => resolve());
    });

    // Save cookies
    const dir = path.dirname(COOKIES_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const cookies = await page.cookies();
    fs.writeFileSync(COOKIES_PATH, JSON.stringify(cookies, null, 2));
    console.log(`Saved ${cookies.length} cookies to ${COOKIES_PATH}`);

    // Verify login
    await page.goto('https://www.threads.net/', { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 3000));

    const isLoggedIn = await page.evaluate(() => {
        const create = document.querySelector('svg[aria-label="Create"]');
        return Boolean(create);
    });

    if (isLoggedIn) {
        console.log('Login VERIFIED — Create button found on feed');
        // Save cookies again from the feed page
        const feedCookies = await page.cookies();
        fs.writeFileSync(COOKIES_PATH, JSON.stringify(feedCookies, null, 2));
        console.log('Cookies saved again from feed page');
    } else {
        console.log('WARNING: Login not verified — Create button not found');
        console.log('The cookies were saved anyway. Try restarting the scheduler.');
    }

    await browser.close();
    console.log('Done! You can now start the Threads scheduler:');
    console.log('  npx pm2 restart riona-threads');
}

manualLogin().catch(console.error);
