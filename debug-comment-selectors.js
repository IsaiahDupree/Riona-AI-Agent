/**
 * Debug script to capture Instagram's actual DOM structure for comment boxes.
 * This will help us find the correct selectors.
 */
const puppeteerExtra = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');

puppeteerExtra.use(StealthPlugin());

require('dotenv').config();

async function debugCommentSelectors() {
    console.log('=== Instagram Comment Box Debug ===\n');

    const browser = await puppeteerExtra.launch({
        headless: false,
        defaultViewport: null,
        executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--window-size=1920,1080',
            '--start-maximized',
            '--lang=en-US,en'
        ]
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36');

    // Load cookies - try multiple paths
    const username = process.env.INSTAGRAM_BOT_USERNAME;
    const cookiePaths = [
        path.join(process.cwd(), 'cookies', `Instagram_${username}_cookies.json`),
        path.join(process.cwd(), 'cookies.json'),
    ];

    let cookiesLoaded = false;
    for (const cp of cookiePaths) {
        if (fs.existsSync(cp)) {
            try {
                const cookies = JSON.parse(fs.readFileSync(cp, 'utf8'));
                await page.setCookie(...cookies);
                console.log(`Cookies loaded from ${cp}`);
                cookiesLoaded = true;
                break;
            } catch(e) {
                console.log(`Failed to load cookies from ${cp}: ${e.message}`);
            }
        }
    }
    if (!cookiesLoaded) console.log('No cookies found, will need to login');

    // Navigate to Instagram
    await page.goto('https://www.instagram.com/', { waitUntil: 'networkidle0', timeout: 30000 });
    await new Promise(r => setTimeout(r, 5000));

    // Check if we're on login page and need to login
    const loginInput = await page.$('input[name="username"]') || await page.$('input[autocomplete="username"]');
    if (loginInput) {
        console.log('On login page - logging in with credentials...');
        const password = process.env.INSTAGRAM_BOT_PASSWORD;
        await loginInput.click();
        await page.keyboard.type(username, { delay: 50 });
        const passInput = await page.$('input[name="password"]') || await page.$('input[type="password"]');
        if (passInput) {
            await passInput.click();
            await page.keyboard.type(password, { delay: 50 });
            const loginBtn = await page.$('button[type="submit"]');
            if (loginBtn) {
                await loginBtn.click();
                await page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 30000 }).catch(() => {});
                await new Promise(r => setTimeout(r, 5000));
                console.log('Login attempted, saving cookies...');
                // Save cookies for next time
                const newCookies = await page.cookies();
                const savePath = path.join(process.cwd(), 'cookies', `Instagram_${username}_cookies.json`);
                fs.writeFileSync(savePath, JSON.stringify(newCookies, null, 2));
            }
        }
    }

    // Handle dialogs (notifications, save login)
    try {
        const buttons = await page.$$('button');
        for (const btn of buttons) {
            const text = await btn.evaluate(el => (el.textContent || '').trim());
            if (text === 'Not Now' || text === 'Not now') {
                await btn.click();
                await new Promise(r => setTimeout(r, 1500));
            }
        }
    } catch {}

    await new Promise(r => setTimeout(r, 5000));

    // Scroll down a bit to trigger lazy loading
    await page.evaluate(() => window.scrollBy(0, 300));
    await new Promise(r => setTimeout(r, 3000));

    // Take screenshot of feed
    await page.screenshot({ path: 'debug_feed.png', fullPage: false });
    console.log('Feed screenshot saved to debug_feed.png');

    // Find first article/post
    const posts = await page.$$('article');
    console.log(`Found ${posts.length} posts\n`);

    if (posts.length === 0) {
        console.log('No posts found!');
        await browser.close();
        return;
    }

    const post = posts[0];

    // Scroll to post
    await post.evaluate(el => el.scrollIntoView({ behavior: 'smooth', block: 'center' }));
    await new Promise(r => setTimeout(r, 1500));

    // 1. Dump all interactive elements within the post
    console.log('=== All interactive elements in first post ===');
    const interactiveElements = await post.evaluate(el => {
        const results = [];
        const elements = el.querySelectorAll('textarea, input, [contenteditable], [role="textbox"], [role="button"], button, svg[aria-label], form');
        elements.forEach(e => {
            results.push({
                tag: e.tagName.toLowerCase(),
                role: e.getAttribute('role'),
                ariaLabel: e.getAttribute('aria-label'),
                placeholder: e.getAttribute('placeholder'),
                contenteditable: e.getAttribute('contenteditable'),
                type: e.getAttribute('type'),
                className: e.className?.toString()?.slice(0, 100),
                textContent: (e.textContent || '').trim().slice(0, 50),
                dataAttrs: Array.from(e.attributes).filter(a => a.name.startsWith('data-')).map(a => `${a.name}=${a.value}`).join(', ')
            });
        });
        return results;
    });

    interactiveElements.forEach((el, i) => {
        console.log(`  [${i}] <${el.tag}> role="${el.role}" aria-label="${el.ariaLabel}" placeholder="${el.placeholder}" contenteditable="${el.contenteditable}" text="${el.textContent}" data="${el.dataAttrs}"`);
    });

    // 2. Click the comment icon
    console.log('\n=== Clicking comment icon ===');
    const commentIcon = await post.$('svg[aria-label="Comment"]')
        || await post.$('svg[aria-label*="comment" i]')
        || await post.$('[aria-label*="comment" i] svg');

    if (commentIcon) {
        console.log('Comment icon found, clicking...');
        try {
            await commentIcon.click();
        } catch {
            await commentIcon.evaluate(el => {
                const parent = el.closest('button') || el.closest('[role="button"]') || el.parentElement;
                if (parent) parent.click();
            });
        }
        await new Promise(r => setTimeout(r, 2000));
        console.log('Clicked! Waiting for comment box...');

        // Screenshot after click
        await page.screenshot({ path: 'debug_after_comment_click.png', fullPage: false });
        console.log('Screenshot saved to debug_after_comment_click.png');

        // 3. Dump interactive elements AFTER clicking comment icon
        console.log('\n=== Interactive elements AFTER comment icon click ===');

        // Check within the post
        const afterElements = await post.evaluate(el => {
            const results = [];
            const elements = el.querySelectorAll('textarea, input, [contenteditable], [role="textbox"], form, [data-lexical-editor]');
            elements.forEach(e => {
                results.push({
                    tag: e.tagName.toLowerCase(),
                    role: e.getAttribute('role'),
                    ariaLabel: e.getAttribute('aria-label'),
                    placeholder: e.getAttribute('placeholder'),
                    ariaPlaceholder: e.getAttribute('aria-placeholder'),
                    contenteditable: e.getAttribute('contenteditable'),
                    className: e.className?.toString()?.slice(0, 150),
                    textContent: (e.textContent || '').trim().slice(0, 80),
                    dataAttrs: Array.from(e.attributes).filter(a => a.name.startsWith('data-')).map(a => `${a.name}=${a.value}`).join(', '),
                    visible: e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().height > 0
                });
            });
            return results;
        });

        console.log('  Within post:');
        afterElements.forEach((el, i) => {
            console.log(`    [${i}] <${el.tag}> role="${el.role}" aria-label="${el.ariaLabel}" placeholder="${el.placeholder}" aria-placeholder="${el.ariaPlaceholder}" contenteditable="${el.contenteditable}" visible=${el.visible} text="${el.textContent}" data="${el.dataAttrs}" class="${el.className}"`);
        });

        // Also check page-wide
        const pageElements = await page.evaluate(() => {
            const results = [];
            const elements = document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"], [data-lexical-editor]');
            elements.forEach(e => {
                const rect = e.getBoundingClientRect();
                results.push({
                    tag: e.tagName.toLowerCase(),
                    role: e.getAttribute('role'),
                    ariaLabel: e.getAttribute('aria-label'),
                    placeholder: e.getAttribute('placeholder'),
                    ariaPlaceholder: e.getAttribute('aria-placeholder'),
                    contenteditable: e.getAttribute('contenteditable'),
                    className: e.className?.toString()?.slice(0, 150),
                    textContent: (e.textContent || '').trim().slice(0, 80),
                    dataAttrs: Array.from(e.attributes).filter(a => a.name.startsWith('data-')).map(a => `${a.name}=${a.value}`).join(', '),
                    visible: rect.width > 0 && rect.height > 0,
                    rect: `${Math.round(rect.x)},${Math.round(rect.y)} ${Math.round(rect.width)}x${Math.round(rect.height)}`
                });
            });
            return results;
        });

        console.log('\n  Page-wide textboxes/textareas/contenteditable:');
        pageElements.forEach((el, i) => {
            console.log(`    [${i}] <${el.tag}> role="${el.role}" aria-label="${el.ariaLabel}" placeholder="${el.placeholder}" aria-placeholder="${el.ariaPlaceholder}" contenteditable="${el.contenteditable}" visible=${el.visible} rect=${el.rect} text="${el.textContent}" data="${el.dataAttrs}" class="${el.className}"`);
        });
    } else {
        console.log('Comment icon NOT found!');

        // Dump all SVGs with aria-labels
        const svgs = await post.evaluate(el => {
            return Array.from(el.querySelectorAll('svg[aria-label]')).map(s => ({
                label: s.getAttribute('aria-label'),
                parent: s.parentElement?.tagName
            }));
        });
        console.log('SVGs found:', svgs);
    }

    console.log('\n=== Debug complete ===');
    await new Promise(r => setTimeout(r, 5000));
    await browser.close();
}

debugCommentSelectors().catch(console.error);
