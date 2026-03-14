/**
 * Quick probe: log in to Threads, go to a post, dump all SVG aria-labels
 * and any interactive elements for reply/comment
 */
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import * as path from 'path';
import * as fs from 'fs';
import dotenv from 'dotenv';

dotenv.config();
puppeteer.use(StealthPlugin());

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const THREADS_PROFILE = path.join(process.cwd(), 'chrome-profile-threads');

async function probe() {
    const browser = await puppeteer.launch({
        headless: false,
        defaultViewport: null,
        executablePath: CHROME_PATH,
        userDataDir: THREADS_PROFILE,
        args: ['--no-sandbox', '--window-position=960,0', '--window-size=960,1080',
            '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36']
    });
    const page = await browser.newPage();

    // Load cookies
    const cookiesPath = path.join(process.cwd(), 'cookies', `threads_${process.env.THREADS_BOT_USERNAME}_cookies.json`);
    if (fs.existsSync(cookiesPath)) {
        const cookies = JSON.parse(fs.readFileSync(cookiesPath, 'utf8'));
        await page.setCookie(...cookies);
    }

    // Go to feed, grab a post URL
    await page.goto('https://www.threads.net/', { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 4000));

    const postUrl = await page.evaluate(() => {
        const links = document.querySelectorAll('a[href*="/post/"]');
        for (const link of links) {
            const href = link.getAttribute('href');
            if (href && href.includes('/post/')) {
                return href.startsWith('http') ? href : `https://www.threads.net${href}`;
            }
        }
        return null;
    });

    console.log('Post URL:', postUrl);
    if (!postUrl) { await browser.close(); return; }

    // Go to the post
    await page.goto(postUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 3000));

    // Dump all SVG aria-labels
    const svgLabels = await page.evaluate(() => {
        const svgs = document.querySelectorAll('svg[aria-label]');
        return Array.from(svgs).map(s => ({
            label: s.getAttribute('aria-label'),
            parentTag: s.parentElement?.tagName,
            parentRole: s.parentElement?.getAttribute('role'),
            grandparentRole: s.parentElement?.parentElement?.getAttribute('role'),
            visible: s.getBoundingClientRect().width > 0
        }));
    });
    console.log('\n=== SVG ARIA-LABELS ON POST PAGE ===');
    console.log(JSON.stringify(svgLabels, null, 2));

    // Dump all aria-label elements (not just SVG)
    const ariaLabels = await page.evaluate(() => {
        const els = document.querySelectorAll('[aria-label]');
        return Array.from(els)
            .filter(e => e.getBoundingClientRect().width > 0)
            .map(e => ({
                tag: e.tagName,
                label: e.getAttribute('aria-label'),
                role: e.getAttribute('role'),
                text: (e.textContent || '').trim().slice(0, 40)
            }))
            .filter(e => e.label && e.label.length > 0 && e.label.length < 50);
    });
    console.log('\n=== ALL VISIBLE ARIA-LABELS ===');
    console.log(JSON.stringify(ariaLabels, null, 2));

    // Look for reply/comment related elements
    const replyRelated = await page.evaluate(() => {
        const body = document.body.innerHTML;
        const matches: string[] = [];
        // Find any element containing "reply", "comment", "respond" in attributes
        const allEls = document.querySelectorAll('*');
        for (const el of allEls) {
            const attrs = el.getAttributeNames();
            for (const attr of attrs) {
                const val = (el.getAttribute(attr) || '').toLowerCase();
                if ((val.includes('reply') || val.includes('comment') || val.includes('respond')) && el.getBoundingClientRect().width > 0) {
                    matches.push(`<${el.tagName} ${attr}="${el.getAttribute(attr)}" text="${(el.textContent || '').trim().slice(0, 30)}">`);
                }
            }
        }
        return [...new Set(matches)];
    });
    console.log('\n=== REPLY/COMMENT RELATED ELEMENTS ===');
    console.log(JSON.stringify(replyRelated, null, 2));

    // Also check what textboxes/inputs exist on the post page
    const inputs = await page.evaluate(() => {
        const results: any[] = [];
        const textboxes = document.querySelectorAll('[role="textbox"], textarea, input[type="text"], [contenteditable="true"]');
        for (const el of textboxes) {
            results.push({
                tag: el.tagName,
                role: el.getAttribute('role'),
                ariaLabel: el.getAttribute('aria-label'),
                placeholder: el.getAttribute('placeholder') || el.getAttribute('aria-placeholder'),
                contentEditable: el.getAttribute('contenteditable'),
                visible: el.getBoundingClientRect().width > 0
            });
        }
        return results;
    });
    console.log('\n=== INPUT/TEXTBOX ELEMENTS ===');
    console.log(JSON.stringify(inputs, null, 2));

    await browser.close();
}

probe().catch(console.error);
