/**
 * Debug: Navigate to IG login page and screenshot what we see
 */
require('dotenv').config();
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

async function debug() {
    const browser = await puppeteer.launch({
        headless: false,
        defaultViewport: null,
        executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled',
            '--window-size=1280,900',
        ],
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');

    try {
        console.log('Navigating to login page...');
        await page.goto('https://www.instagram.com/accounts/login/', { waitUntil: 'networkidle2', timeout: 30000 });
        await new Promise(r => setTimeout(r, 3000));

        await page.screenshot({ path: 'debug-ig-login-page.png', fullPage: false });
        console.log('Screenshot saved: debug-ig-login-page.png');
        console.log('URL:', page.url());

        // Check what elements exist
        const elements = await page.evaluate(() => {
            const inputs = document.querySelectorAll('input');
            const buttons = document.querySelectorAll('button');
            return {
                inputs: Array.from(inputs).map(i => ({ name: i.name, type: i.type, placeholder: i.placeholder })),
                buttons: Array.from(buttons).map(b => ({ type: b.type, text: b.textContent?.trim().slice(0, 40) })),
                title: document.title,
                bodyText: document.body?.innerText?.slice(0, 500),
            };
        });

        console.log('\nPage title:', elements.title);
        console.log('Inputs:', JSON.stringify(elements.inputs, null, 2));
        console.log('Buttons:', JSON.stringify(elements.buttons, null, 2));
        console.log('Body text preview:', elements.bodyText?.slice(0, 300));

        // Try to find cookie consent or any blocking overlay
        const overlays = await page.evaluate(() => {
            const dialogs = document.querySelectorAll('[role="dialog"], [role="alertdialog"], .modal, [class*="cookie"], [class*="consent"]');
            return Array.from(dialogs).map(d => ({
                role: d.getAttribute('role'),
                class: d.className?.toString().slice(0, 60),
                text: d.textContent?.trim().slice(0, 100),
            }));
        });
        console.log('\nOverlays/dialogs:', JSON.stringify(overlays, null, 2));

    } catch (err) {
        console.error('Error:', err.message);
        await page.screenshot({ path: 'debug-ig-error.png', fullPage: false });
    } finally {
        await browser.close();
    }
}

debug().catch(console.error);
