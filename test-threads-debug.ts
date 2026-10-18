import { ThreadsAI } from './src/client/Threads-AI';
import { createSession } from './src/tracking/threadsTracker';

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

(async () => {
    const threadsAI = new ThreadsAI();
    const THREADS_TIMEOUT = 60000;

    console.log('[debug] Initializing...');
    await threadsAI.initialize();
    const loggedIn = await threadsAI.ensureLoggedIn();
    if (!loggedIn) { console.error('[debug] Login failed'); process.exit(1); }

    let page = threadsAI.getPage()!;
    console.log('[debug] Logged in, navigating to feed...');

    await page.goto('https://www.threads.net/', { waitUntil: 'domcontentloaded', timeout: THREADS_TIMEOUT });
    await delay(3000);

    // Collect one post
    const postUrls = await page.evaluate(() => {
        const links = document.querySelectorAll('a[href*="/post/"]');
        const urls = new Set<string>();
        for (const link of links) {
            const href = (link as HTMLAnchorElement).href;
            if (href && !href.includes('/media') && !href.includes('/liked_by') && !href.includes('/comments')) {
                urls.add(href);
            }
        }
        return Array.from(urls).slice(0, 1);
    });

    if (!postUrls.length) { console.error('[debug] No posts found'); process.exit(1); }
    const postUrl = postUrls[0];
    console.log('[debug] Target post:', postUrl);

    // Navigate to post
    await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: THREADS_TIMEOUT });
    await delay(3000);

    // Screenshot before clicking reply
    await page.screenshot({ path: '/tmp/threads-1-before-reply.png', fullPage: false });
    console.log('[debug] Screenshot 1: before reply click');

    // Click reply icon
    const clicked = await page.evaluate(() => {
        const replySvg = document.querySelector('svg[aria-label="Reply"]')
            || document.querySelector('svg[aria-label="Comment"]');
        if (replySvg) {
            const clickable = replySvg.closest('div[role="button"], button');
            if (clickable) {
                (clickable as HTMLElement).click();
                return 'clicked';
            }
        }
        return 'not_found';
    });
    console.log('[debug] Reply icon click:', clicked);
    await delay(3000);

    // Screenshot after clicking reply
    await page.screenshot({ path: '/tmp/threads-2-after-reply.png', fullPage: false });
    console.log('[debug] Screenshot 2: after reply click (dialog should be open)');

    // Find and type in textbox
    const replyBox = await page.$('div[role="textbox"][contenteditable="true"]');
    if (!replyBox) { console.error('[debug] No reply textbox found'); process.exit(1); }

    await replyBox.click();
    await delay(500);
    const testComment = 'Testing comment submission - debug run';
    await page.keyboard.type(testComment, { delay: 30 });
    await delay(1000);

    // Screenshot after typing
    await page.screenshot({ path: '/tmp/threads-3-after-typing.png', fullPage: false });
    console.log('[debug] Screenshot 3: after typing');

    // Find all buttons and log them
    const allButtons = await page.$$('div[role="button"], button');
    console.log('[debug] Total buttons found:', allButtons.length);

    for (let i = 0; i < allButtons.length; i++) {
        const btn = allButtons[i];
        try {
            const info = await btn.evaluate((el) => {
                const text = (el.textContent || '').trim();
                const rect = el.getBoundingClientRect();
                const tag = el.tagName;
                const role = el.getAttribute('role');
                const dialog = el.closest('[role="dialog"]');
                return {
                    text: text.slice(0, 40),
                    tag,
                    role,
                    visible: rect.width > 0 && rect.height > 0,
                    x: Math.round(rect.x),
                    y: Math.round(rect.y),
                    w: Math.round(rect.width),
                    h: Math.round(rect.height),
                    inDialog: !!dialog
                };
            });
            if (info.visible && info.text.toLowerCase().includes('post')) {
                console.log(`[debug] >>> CANDIDATE POST BUTTON [${i}]:`, JSON.stringify(info));
            }
        } catch { }
    }

    // Click the Post button
    let submitted = false;
    for (const btn of allButtons) {
        try {
            const info = await btn.evaluate((el) => {
                const text = (el.textContent || '').trim().toLowerCase();
                const rect = el.getBoundingClientRect();
                return { text, visible: rect.width > 0 && rect.height > 0 };
            });
            if (info.text === 'post' && info.visible) {
                console.log('[debug] Clicking "Post" button...');
                await btn.click();
                submitted = true;
                break;
            }
        } catch { }
    }
    console.log('[debug] Submitted:', submitted);

    // Wait and take screenshot
    await delay(5000);
    await page.screenshot({ path: '/tmp/threads-4-after-submit.png', fullPage: false });
    console.log('[debug] Screenshot 4: 5 seconds after clicking Post');

    // Check textbox state
    const textboxState = await page.evaluate(() => {
        const tbs = document.querySelectorAll('div[role="textbox"][contenteditable="true"]');
        const states: any[] = [];
        for (const tb of tbs) {
            states.push({
                text: (tb.textContent || '').trim().slice(0, 50),
                visible: (tb.getBoundingClientRect().width > 0)
            });
        }
        return states;
    });
    console.log('[debug] Textbox state after submit:', JSON.stringify(textboxState));

    // Check for our comment in the page
    const commentFound = await page.evaluate((c: string) => {
        return document.body.innerText.includes(c.slice(0, 20));
    }, testComment);
    console.log('[debug] Comment found in page:', commentFound);

    // Check for errors
    const errors = await page.evaluate(() => {
        const body = document.body.innerText.toLowerCase();
        const checks = ["couldn't post", 'try again', 'action blocked', 'something went wrong'];
        return checks.filter(t => body.includes(t));
    });
    console.log('[debug] Errors found:', errors);

    await delay(2000);
    process.exit(0);
})().catch(e => { console.error('[debug] FATAL:', e.message); process.exit(1); });
