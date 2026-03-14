/**
 * Debug script: inspects Threads post page DOM to find reply box selectors
 */
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { Page } from 'puppeteer';
import * as path from 'path';
import * as fs from 'fs';
import dotenv from 'dotenv';

dotenv.config();
puppeteer.use(StealthPlugin());

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const THREADS_PROFILE = path.join(process.cwd(), 'chrome-profile-threads');

async function debug() {
    const browser = await puppeteer.launch({
        headless: false,
        defaultViewport: null,
        executablePath: CHROME_PATH,
        userDataDir: THREADS_PROFILE,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--window-position=960,0',
            '--window-size=960,1080',
            '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
        ]
    });

    const page = await browser.newPage();

    // Load cookies
    const cookiesPath = path.join(process.cwd(), 'cookies', `threads_${process.env.THREADS_BOT_USERNAME}_cookies.json`);
    if (fs.existsSync(cookiesPath)) {
        const cookies = JSON.parse(fs.readFileSync(cookiesPath, 'utf8'));
        await page.setCookie(...cookies);
    }

    // Go to feed first
    await page.goto('https://www.threads.net/', { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 5000));

    // Find first post URL
    const postUrls = await page.evaluate(() => {
        const links = document.querySelectorAll('a[href*="/post/"]');
        const urls: string[] = [];
        for (const link of links) {
            const href = link.getAttribute('href');
            if (href && href.includes('/post/')) {
                const full = href.startsWith('http') ? href : `https://www.threads.net${href}`;
                if (!urls.includes(full)) urls.push(full);
            }
        }
        return urls.slice(0, 3);
    });

    console.log('\n=== FEED POST URLS ===');
    console.log(postUrls);

    if (postUrls.length === 0) {
        console.log('No post URLs found in feed!');
        await browser.close();
        return;
    }

    // Navigate to first post
    await page.goto(postUrls[0], { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 3000));

    // Dump all interactive elements
    const domInfo = await page.evaluate(() => {
        const info: any = {};

        // All role="textbox" elements
        const textboxes = document.querySelectorAll('[role="textbox"]');
        info.textboxes = [];
        for (const tb of textboxes) {
            info.textboxes.push({
                tag: tb.tagName,
                contentEditable: tb.getAttribute('contenteditable'),
                ariaLabel: tb.getAttribute('aria-label'),
                placeholder: tb.getAttribute('aria-placeholder') || tb.getAttribute('placeholder'),
                className: tb.className.slice(0, 100),
                visible: tb.getBoundingClientRect().width > 0,
                text: (tb.textContent || '').slice(0, 50)
            });
        }

        // All textareas
        const textareas = document.querySelectorAll('textarea');
        info.textareas = [];
        for (const ta of textareas) {
            info.textareas.push({
                ariaLabel: ta.getAttribute('aria-label'),
                placeholder: ta.getAttribute('placeholder'),
                visible: ta.getBoundingClientRect().width > 0
            });
        }

        // All contenteditable elements
        const editables = document.querySelectorAll('[contenteditable="true"]');
        info.contentEditables = [];
        for (const el of editables) {
            info.contentEditables.push({
                tag: el.tagName,
                role: el.getAttribute('role'),
                ariaLabel: el.getAttribute('aria-label'),
                ariaPlaceholder: el.getAttribute('aria-placeholder'),
                className: el.className.slice(0, 100),
                visible: el.getBoundingClientRect().width > 0,
                parentTag: el.parentElement?.tagName,
                parentClass: el.parentElement?.className?.slice(0, 80)
            });
        }

        // SVG buttons (Like, Reply, Repost, Share)
        const svgs = document.querySelectorAll('svg[aria-label]');
        info.svgButtons = [];
        for (const svg of svgs) {
            info.svgButtons.push({
                ariaLabel: svg.getAttribute('aria-label'),
                parentTag: svg.parentElement?.tagName,
                parentRole: svg.parentElement?.getAttribute('role')
            });
        }

        // All buttons with text
        const buttons = document.querySelectorAll('button, div[role="button"]');
        info.buttons = [];
        for (const btn of buttons) {
            const text = (btn.textContent || '').trim();
            if (text.length > 0 && text.length < 30) {
                info.buttons.push({
                    tag: btn.tagName,
                    text,
                    ariaLabel: btn.getAttribute('aria-label'),
                    type: btn.getAttribute('type')
                });
            }
        }

        // Input elements
        const inputs = document.querySelectorAll('input, textarea');
        info.inputs = [];
        for (const inp of inputs) {
            info.inputs.push({
                tag: inp.tagName,
                type: inp.getAttribute('type'),
                name: inp.getAttribute('name'),
                placeholder: inp.getAttribute('placeholder'),
                ariaLabel: inp.getAttribute('aria-label'),
                visible: inp.getBoundingClientRect().width > 0
            });
        }

        return info;
    });

    console.log('\n=== DOM INSPECTION ON POST PAGE ===');
    console.log(JSON.stringify(domInfo, null, 2));

    // Also try clicking the Reply SVG and see what appears
    console.log('\n=== TRYING TO CLICK REPLY ICON ===');
    const clickResult = await page.evaluate(() => {
        const replySvg = document.querySelector('svg[aria-label="Reply"]');
        if (replySvg) {
            const btn = replySvg.closest('button') || replySvg.closest('div[role="button"]') || replySvg.parentElement;
            if (btn) {
                (btn as HTMLElement).click();
                return 'Clicked Reply icon';
            }
            return 'Reply SVG found but no clickable parent';
        }
        // Try "Comment" label
        const commentSvg = document.querySelector('svg[aria-label="Comment"]');
        if (commentSvg) {
            const btn = commentSvg.closest('button') || commentSvg.closest('div[role="button"]') || commentSvg.parentElement;
            if (btn) {
                (btn as HTMLElement).click();
                return 'Clicked Comment icon';
            }
            return 'Comment SVG found but no clickable parent';
        }
        return 'No Reply or Comment SVG found';
    });
    console.log(clickResult);

    // Wait longer for dialog to fully render
    console.log('\nWaiting 5s for dialog to render...');
    await new Promise(r => setTimeout(r, 5000));

    // Deep inspection of dialog
    const afterClick = await page.evaluate(() => {
        const info: any = {};

        // Check for dialogs/modals
        const dialogs = document.querySelectorAll('[role="dialog"]');
        info.dialogCount = dialogs.length;

        // Dump EVERYTHING inside the dialog
        if (dialogs.length > 0) {
            const dialog = dialogs[dialogs.length - 1]; // get last one
            info.dialogInnerHTML = dialog.innerHTML.slice(0, 3000);

            // All elements with role, aria-label, contenteditable in dialog
            const allEls = dialog.querySelectorAll('*');
            info.dialogElements = [];
            for (const el of allEls) {
                const role = el.getAttribute('role');
                const ariaLabel = el.getAttribute('aria-label');
                const ariaPlaceholder = el.getAttribute('aria-placeholder');
                const contentEditable = el.getAttribute('contenteditable');
                const dataLexical = el.getAttribute('data-lexical-editor');
                const placeholder = el.getAttribute('placeholder');

                if (role || ariaLabel || contentEditable || dataLexical || placeholder || ariaPlaceholder) {
                    info.dialogElements.push({
                        tag: el.tagName,
                        role,
                        ariaLabel,
                        ariaPlaceholder,
                        contentEditable,
                        dataLexical,
                        placeholder,
                        className: el.className?.toString().slice(0, 80),
                        visible: el.getBoundingClientRect().width > 0,
                        text: (el.textContent || '').slice(0, 50)
                    });
                }
            }
        }

        // Also check page-level textboxes
        const textboxes = document.querySelectorAll('[role="textbox"]');
        info.textboxes = [];
        for (const tb of textboxes) {
            info.textboxes.push({
                tag: tb.tagName,
                contentEditable: tb.getAttribute('contenteditable'),
                ariaLabel: tb.getAttribute('aria-label'),
                ariaPlaceholder: tb.getAttribute('aria-placeholder'),
                dataLexical: tb.getAttribute('data-lexical-editor'),
                visible: tb.getBoundingClientRect().width > 0
            });
        }

        // All contenteditable elements on page
        const editables = document.querySelectorAll('[contenteditable="true"]');
        info.contentEditables = [];
        for (const el of editables) {
            info.contentEditables.push({
                tag: el.tagName,
                role: el.getAttribute('role'),
                ariaLabel: el.getAttribute('aria-label'),
                ariaPlaceholder: el.getAttribute('aria-placeholder'),
                dataLexical: el.getAttribute('data-lexical-editor'),
                visible: el.getBoundingClientRect().width > 0
            });
        }

        // All p elements with data-lexical-* attributes
        const lexicals = document.querySelectorAll('[class*="lexical"], [data-lexical-editor]');
        info.lexicals = [];
        for (const el of lexicals) {
            info.lexicals.push({
                tag: el.tagName,
                dataLexical: el.getAttribute('data-lexical-editor'),
                contentEditable: el.getAttribute('contenteditable'),
                role: el.getAttribute('role'),
                className: el.className?.toString().slice(0, 80)
            });
        }

        return info;
    });

    console.log('\n=== AFTER CLICKING COMMENT ICON (5s wait) ===');
    console.log(JSON.stringify(afterClick, null, 2));

    // Keep browser open for manual inspection
    console.log('\n=== Browser staying open for 30s for manual inspection ===');
    await new Promise(r => setTimeout(r, 30000));

    await browser.close();
}

debug().catch(console.error);
