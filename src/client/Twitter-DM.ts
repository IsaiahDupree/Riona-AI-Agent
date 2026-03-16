import { Page, ElementHandle } from 'puppeteer';
import { logger } from '../utils/logger';
import { screenshotPath, formatError } from '../utils/errors';
import { DMSendResult, DMMessage, ConversationPreview } from '../types/dm';
import * as path from 'path';
import * as fs from 'fs';

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
const TIMEOUT = 60000;
const TWITTER_DM_PROFILE = path.join(process.cwd(), process.env.TWITTER_DM_CHROME_PROFILE || 'chrome-profile-twitter-dm');

// ── Twitter/X DM Automation ─────────────────────────────────────────

export class TwitterDM {
    private page: Page | null = null;
    private browser: any = null;
    private shared: boolean = false;

    constructor() {}

    /**
     * Create a TwitterDM instance that wraps an existing Puppeteer Page.
     * Used when sharing a browser session with the main Twitter scheduler.
     */
    static fromPage(page: Page): TwitterDM {
        const dm = new TwitterDM();
        dm.page = page;
        dm.browser = page.browser();
        dm.shared = true;
        return dm;
    }

    async initialize(): Promise<void> {
        if (!fs.existsSync(TWITTER_DM_PROFILE)) {
            fs.mkdirSync(TWITTER_DM_PROFILE, { recursive: true });
        }
        const puppeteer = await import('puppeteer');
        this.browser = await puppeteer.default.launch({
            headless: false,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-blink-features=AutomationControlled',
                '--window-size=1280,900'
            ],
            userDataDir: TWITTER_DM_PROFILE
        });
        const pages = await this.browser.pages();
        this.page = pages[0] || await this.browser.newPage();
        await this.page!.setViewport({ width: 1280, height: 900 });

        // Ensure we're logged in to Twitter
        await this.ensureLoggedIn();
        logger.info('[twitter-dm] Browser initialized');
    }

    /**
     * Check if we're logged in, and if not, perform auto-login using env credentials.
     */
    private async ensureLoggedIn(): Promise<void> {
        if (!this.page) return;

        await this.page.goto('https://x.com/home', { waitUntil: 'networkidle2', timeout: TIMEOUT });
        await delay(2000);

        const currentUrl = this.page.url();
        if (!currentUrl.includes('/login') && !currentUrl.includes('/i/flow/login')) {
            logger.info('[twitter-dm] Session valid (via browser profile)');
            return;
        }

        // Need to log in
        const username = process.env.TWITTER_BOT_USERNAME;
        const password = process.env.TWITTER_BOT_PASSWORD;
        if (!username || !password) {
            throw new Error('[twitter-dm] Not logged in and no TWITTER_BOT_USERNAME/PASSWORD set');
        }

        logger.info('[twitter-dm] Session expired, logging in...');
        await this.page.goto('https://x.com/i/flow/login', { waitUntil: 'networkidle2', timeout: TIMEOUT });

        // Username
        await this.page.waitForSelector('input[autocomplete="username"], input[name="text"]', { timeout: TIMEOUT });
        await delay(1000);
        const usernameInput = await this.page.$('input[autocomplete="username"]') || await this.page.$('input[name="text"]');
        if (!usernameInput) throw new Error('[twitter-dm] Username input not found');
        await usernameInput.type(username, { delay: 50 });

        // Click Next
        const nextBtn = await this.page.evaluateHandle(() => {
            const buttons = document.querySelectorAll('button, [role="button"]');
            for (const btn of buttons) {
                if ((btn.textContent || '').trim().toLowerCase() === 'next') return btn;
            }
            return null;
        });
        if (nextBtn) {
            await (nextBtn as ElementHandle<Element>).click();
            await delay(2000);
        }

        // Handle verification step (unusual login)
        const verificationInput = await this.page.$('input[data-testid="ocfEnterTextTextInput"]');
        if (verificationInput) {
            const verificationValue = process.env.TWITTER_BOT_EMAIL || process.env.TWITTER_BOT_PHONE || '';
            if (verificationValue) {
                await verificationInput.type(verificationValue, { delay: 50 });
                const verifyNext = await this.page.$('[data-testid="ocfEnterTextNextButton"]');
                if (verifyNext) { await verifyNext.click(); await delay(2000); }
            } else {
                logger.warn('[twitter-dm] Verification step but no TWITTER_BOT_EMAIL/PHONE set');
            }
        }

        // Password
        await this.page.waitForSelector('input[name="password"], input[type="password"]', { timeout: TIMEOUT });
        const passwordInput = await this.page.$('input[name="password"]') || await this.page.$('input[type="password"]');
        if (!passwordInput) throw new Error('[twitter-dm] Password input not found');
        await passwordInput.type(password, { delay: 50 });

        // Click Log in
        const loginBtn = await this.page.$('[data-testid="LoginForm_Login_Button"]');
        if (loginBtn) {
            await loginBtn.click();
        } else {
            await this.page.evaluate(() => {
                const buttons = document.querySelectorAll('button, [role="button"]');
                for (const btn of buttons) {
                    if ((btn.textContent || '').trim().toLowerCase() === 'log in') {
                        (btn as HTMLElement).click(); return;
                    }
                }
            });
        }

        await this.page.waitForNavigation({ waitUntil: 'networkidle2', timeout: TIMEOUT }).catch(() => {});
        await delay(3000);

        const finalUrl = this.page.url();
        if (finalUrl.includes('/login') || finalUrl.includes('/i/flow/login')) {
            throw new Error('[twitter-dm] Login failed — still on login page');
        }

        logger.info('[twitter-dm] Login successful');
    }

    async close(): Promise<void> {
        if (this.shared) {
            // Don't close shared browser — owned by the main scheduler
            this.page = null;
            this.browser = null;
            return;
        }
        try {
            if (this.browser) {
                await this.browser.close();
                this.browser = null;
                this.page = null;
            }
        } catch (e) {
            logger.error(`[twitter-dm] Error closing browser: ${formatError(e)}`);
        }
    }

    getPage(): Page | null {
        return this.page;
    }

    /**
     * Ensure the page is still usable. If the frame is detached (stale),
     * close extra pages/tabs and re-acquire a valid page reference.
     */
    async ensurePage(): Promise<Page> {
        if (!this.browser) throw new Error('Browser not initialized');

        // Quick check: try to evaluate on the current page
        if (this.page) {
            try {
                await this.page.evaluate(() => document.readyState);
                return this.page;
            } catch (e) {
                const msg = formatError(e);
                if (msg.includes('detached Frame') || msg.includes('Session closed') || msg.includes('Target closed')) {
                    logger.warn(`[twitter-dm] Page frame detached, recovering...`);
                } else {
                    throw e;
                }
            }
        }

        // Recovery: get all open pages, close extras, keep one
        const pages = await this.browser.pages();
        if (pages.length === 0) {
            this.page = await this.browser.newPage();
            await this.page!.setViewport({ width: 1280, height: 900 });
            logger.info('[twitter-dm] Created new page after recovery');
        } else {
            // Use the last page (most recently active), close the rest
            this.page = pages[pages.length - 1];
            for (let i = 0; i < pages.length - 1; i++) {
                try { await pages[i].close(); } catch (_) {}
            }
            logger.info(`[twitter-dm] Recovered page (closed ${pages.length - 1} stale pages)`);
        }

        return this.page!;
    }

    // ── Navigate to DM inbox ────────────────────────────────────────

    async navigateToInbox(): Promise<void> {
        this.page = await this.ensurePage();
        logger.info('[twitter-dm] Navigating to inbox...');
        await this.page.goto('https://x.com/messages', {
            waitUntil: 'domcontentloaded',
            timeout: TIMEOUT
        });
        await delay(3000);

        // Handle DM PIN lock (Twitter security feature)
        await this.handlePinPrompt();

        // Dismiss any pop-up dialogs
        await this.dismissDialogs();
        logger.info('[twitter-dm] Inbox loaded');
    }

    /**
     * If Twitter shows a PIN prompt to unlock DMs, enter the PIN automatically.
     */
    private async handlePinPrompt(): Promise<void> {
        if (!this.page) return;

        const currentUrl = this.page.url();
        if (!currentUrl.includes('/pin/recovery') && !currentUrl.includes('/pin')) return;

        const pin = process.env.TWITTER_DM_PIN || '7911';
        logger.info('[twitter-dm] PIN prompt detected, entering PIN...');

        try {
            // Wait for PIN input container
            const pinInput = await this.page.$('[data-testid="pin-code-input-container"] input, input[inputmode="numeric"]');
            if (pinInput) {
                await pinInput.type(pin, { delay: 100 });
                await delay(500);

                // Submit PIN via Enter key (most reliable across Twitter UI variants)
                await this.page.keyboard.press('Enter');
                await delay(3000);
            } else {
                // Try typing into any visible input on the pin page
                await this.page.keyboard.type(pin, { delay: 100 });
                await delay(500);
                await this.page.keyboard.press('Enter');
                await delay(3000);
            }

            // Check if we got past the PIN
            const afterUrl = this.page.url();
            if (afterUrl.includes('/pin')) {
                logger.warn('[twitter-dm] Still on PIN page after entry — PIN may be incorrect');
            } else {
                logger.info('[twitter-dm] PIN accepted, DMs unlocked');
            }
        } catch (e) {
            logger.warn(`[twitter-dm] PIN entry failed: ${formatError(e)}`);
        }
    }

    // ── Send a DM to a user by searching their name ─────────────────

    async sendDM(recipientName: string, message: string): Promise<DMSendResult> {
        if (!this.page) throw new Error('Page not initialized');
        const timestamp = new Date().toISOString();

        try {
            // Strategy 1: Try to open existing thread via inbox search (most reliable)
            await this.navigateToInbox();
            await this.page.screenshot({ path: screenshotPath('twitter-dm-1-inbox.png'), fullPage: false });

            const existingFound = await this.openExistingThread(recipientName);
            if (existingFound) {
                logger.info(`[twitter-dm] Found existing thread with @${recipientName}`);
                await delay(2000);
                await this.page.screenshot({ path: screenshotPath('twitter-dm-2-thread-open.png'), fullPage: false });
                const sent = await this.typeAndSendMessage(message);
                await delay(3000);
                const verified = await this.verifyMessageSent(message);
                logger.info(`[twitter-dm] Send result: success=${sent}, verified=${verified}`);
                return { success: sent, recipientUsername: recipientName, messageText: message, timestamp, verified };
            }

            // Strategy 2: Navigate to user's profile and click the Message/DM button
            logger.info(`[twitter-dm] No existing thread, trying profile message button...`);
            const profileOpened = await this.openDMFromProfile(recipientName);
            if (profileOpened) {
                logger.info(`[twitter-dm] Opened DM thread from @${recipientName}'s profile`);
                await delay(2000);
                await this.page.screenshot({ path: screenshotPath('twitter-dm-3-profile-dm.png'), fullPage: false });
                const sent = await this.typeAndSendMessage(message);
                await delay(3000);
                const verified = await this.verifyMessageSent(message);
                logger.info(`[twitter-dm] Send result: success=${sent}, verified=${verified}`);
                return { success: sent, recipientUsername: recipientName, messageText: message, timestamp, verified };
            }

            // Strategy 3: Compose dialog as last resort
            logger.info(`[twitter-dm] Profile DM button not found, trying compose dialog...`);
            try {
                await this.page.goto(`https://x.com/messages/compose`, {
                    waitUntil: 'domcontentloaded', timeout: 15000
                });
                await delay(2000);
            } catch (e) {
                logger.debug(`[twitter-dm] Direct compose navigation failed: ${formatError(e)}`);
            }
            await this.page.screenshot({ path: screenshotPath('twitter-dm-4-compose-dialog.png'), fullPage: false });

            const recipientFound = await this.searchAndSelectRecipient(recipientName);
            if (!recipientFound) {
                await this.page.keyboard.press('Escape');
                return { success: false, error: `Recipient "${recipientName}" not found via any strategy`, recipientUsername: recipientName, messageText: message, timestamp, verified: false };
            }
            await delay(1000);

            const chatOpened = await this.clickNext();
            if (!chatOpened) {
                await this.page.keyboard.press('Escape');
                return { success: false, error: 'Could not open chat after compose', recipientUsername: recipientName, messageText: message, timestamp, verified: false };
            }
            await delay(2000);

            const sent = await this.typeAndSendMessage(message);
            await delay(3000);
            const verified = await this.verifyMessageSent(message);

            logger.info(`[twitter-dm] Send result: success=${sent}, verified=${verified}`);
            return { success: sent, recipientUsername: recipientName, messageText: message, timestamp, verified };

        } catch (error) {
            const err = error instanceof Error ? error.message : String(error);
            logger.error('[twitter-dm] sendDM failed:', err);
            return { success: false, error: err, recipientUsername: recipientName, messageText: message, timestamp, verified: false };
        }
    }

    // ── Send DM to an existing conversation (by username) ───────────

    async sendToExistingThread(username: string, message: string): Promise<DMSendResult> {
        if (!this.page) throw new Error('Page not initialized');
        const timestamp = new Date().toISOString();

        try {
            await this.navigateToInbox();
            await delay(2000);

            // Search for existing conversation in sidebar
            const found = await this.openExistingThread(username);
            if (!found) {
                return { success: false, error: `No existing thread with "${username}"`, recipientUsername: username, messageText: message, timestamp, verified: false };
            }
            await delay(2000);

            const sent = await this.typeAndSendMessage(message);
            await delay(3000);
            const verified = await this.verifyMessageSent(message);

            return { success: sent, recipientUsername: username, messageText: message, timestamp, verified };
        } catch (error) {
            const err = error instanceof Error ? error.message : String(error);
            logger.error('[twitter-dm] sendToExistingThread failed:', err);
            return { success: false, error: err, recipientUsername: username, messageText: message, timestamp, verified: false };
        }
    }

    // ── Scrape conversation list from inbox ─────────────────────────

    async scrapeInbox(scrollToLoadAll: boolean = false): Promise<ConversationPreview[]> {
        if (!this.page) throw new Error('Page not initialized');
        await this.navigateToInbox();
        await delay(3000);

        // If scrollToLoadAll, scroll the inbox panel collecting text at each position
        // Twitter virtualizes the list — only visible items exist in DOM at any time
        const collectedTexts = new Set<string>();
        if (scrollToLoadAll) {
            const MAX_SCROLL_ATTEMPTS = 25;
            let sameCountStreak = 0;
            let lastCollectedSize = 0;

            // Collect text at initial position first
            const collectVisibleText = async () => {
                return await this.page!.evaluate(() => {
                    const panel = document.querySelector('[data-testid="dm-inbox-panel"]');
                    if (!panel) return '';
                    return (panel as HTMLElement).innerText || '';
                });
            };

            const initialText = await collectVisibleText();
            initialText.split('\n').filter((l: string) => l.trim()).forEach(l => collectedTexts.add(l.trim()));

            for (let attempt = 0; attempt < MAX_SCROLL_ATTEMPTS; attempt++) {
                // Scroll down incrementally
                await this.page.evaluate(() => {
                    const panel = document.querySelector('[data-testid="dm-inbox-panel"]');
                    if (!panel) return;
                    const containers = panel.querySelectorAll('div');
                    for (const c of containers) {
                        const el = c as HTMLElement;
                        if (el.scrollHeight > el.clientHeight + 10) {
                            el.scrollBy(0, el.clientHeight * 0.8); // Scroll ~80% of viewport
                            return;
                        }
                    }
                });
                await delay(1200);

                // Collect text at new scroll position
                const newText = await collectVisibleText();
                const newLines = newText.split('\n').filter((l: string) => l.trim());
                newLines.forEach(l => collectedTexts.add(l.trim()));

                // Check if we found new content
                if (collectedTexts.size === lastCollectedSize) {
                    sameCountStreak++;
                    if (sameCountStreak >= 3) break; // No more content
                } else {
                    sameCountStreak = 0;
                    lastCollectedSize = collectedTexts.size;
                }
            }

            logger.info(`[twitter-dm] Scroll collected ${collectedTexts.size} unique text lines`);

            // Scroll back to top for clean state
            await this.page.evaluate(() => {
                const panel = document.querySelector('[data-testid="dm-inbox-panel"]');
                if (!panel) return;
                const containers = panel.querySelectorAll('div');
                for (const c of containers) {
                    const el = c as HTMLElement;
                    if (el.scrollHeight > el.clientHeight + 10) {
                        el.scrollTop = 0;
                        return;
                    }
                }
            });
            await delay(1000);
        }

        const conversations = await this.page.evaluate(() => {
            const results: any[] = [];

            // Strategy 1: Try data-testid selectors (older Twitter UI)
            let items = document.querySelectorAll(
                'div[data-testid="conversation"], div[data-testid="cellInnerDiv"], div[role="listitem"], div[role="row"]'
            );

            // Strategy 2: New Twitter Chat UI — conversations are clickable divs
            // inside the dm-inbox-panel with profile images and text
            if (items.length === 0) {
                // Find the inbox panel and look for conversation rows with images
                const inboxPanel = document.querySelector('[data-testid="dm-inbox-panel"]')
                    || document.querySelector('[data-testid="DmScrollerContainer"]');
                if (inboxPanel) {
                    // Each conversation has an <a> tag or clickable div with an img (avatar)
                    const links = inboxPanel.querySelectorAll('a[href*="/messages/"], a[href*="/i/chat/"]');
                    if (links.length > 0) {
                        items = links;
                    } else {
                        // Fallback: look for divs that contain both an image and text
                        // Only use if we find multiple (>= 2) candidates with profile images
                        // to avoid picking up UI chrome buttons (settings, new chat, etc.)
                        const candidates = inboxPanel.querySelectorAll('div[role="button"], div[tabindex="0"]');
                        const validCandidates = Array.from(candidates).filter(c => {
                            const hasImg = c.querySelector('img') !== null;
                            const text = (c as HTMLElement).innerText || '';
                            const lines = text.split('\n').filter((l: string) => l.trim());
                            return hasImg && lines.length >= 2 && text.length > 5 && text.length < 400;
                        });
                        if (validCandidates.length >= 2) items = validCandidates as any;
                    }
                }
            }

            // Strategy 3: Parse dm-inbox-panel's scrollable conversation list directly
            // Structure: dm-inbox-panel > div(3 children) > [header, conversation-list, ?]
            // The conversation list child contains direct children that are conversation rows
            if (items.length === 0) {
                const inboxPanel = document.querySelector('[data-testid="dm-inbox-panel"]')
                    || document.querySelector('[data-testid="DmScrollerContainer"]');
                if (inboxPanel) {
                    // Find the scrollable child that contains conversation items.
                    // The panel typically has one wrapper div with 2-4 children:
                    // a header (tabs like "All", "Requests"), the conversation list, etc.
                    // The conversation list is the child with the most sub-children OR
                    // the one containing profile images.
                    const wrapperDiv = inboxPanel.children[0];
                    if (wrapperDiv && wrapperDiv.children.length >= 2) {
                        let convListEl: Element | null = null;
                        let maxChildren = 0;

                        // Find the child that contains profile images — that's the conversation list
                        for (let i = 0; i < wrapperDiv.children.length; i++) {
                            const child = wrapperDiv.children[i];
                            const imgs = child.querySelectorAll('img');
                            const hasProfileImg = Array.from(imgs).some(img => {
                                const src = img.src || '';
                                return src.includes('twimg') || src.includes('profile');
                            });
                            if (hasProfileImg && child.children.length > maxChildren) {
                                maxChildren = child.children.length;
                                convListEl = child;
                            }
                        }

                        // If no child has profile images, pick the one with most children
                        if (!convListEl) {
                            for (let i = 0; i < wrapperDiv.children.length; i++) {
                                const child = wrapperDiv.children[i];
                                if (child.children.length > maxChildren) {
                                    maxChildren = child.children.length;
                                    convListEl = child;
                                }
                            }
                        }

                        if (convListEl) {
                            // Unwrap single-child wrappers to find the actual list container
                            let listContainer = convListEl;
                            for (let depth = 0; depth < 3; depth++) {
                                if (listContainer.children.length === 1 && listContainer.children[0].children.length > 1) {
                                    listContainer = listContainer.children[0];
                                } else {
                                    break;
                                }
                            }

                            // If listContainer has mixed children (tabs + list wrapper),
                            // find the child with the most sub-children or profile images
                            if (listContainer.children.length >= 2 && listContainer.children.length <= 4) {
                                let bestChild: Element | null = null;
                                let bestScore = 0;
                                for (let ci = 0; ci < listContainer.children.length; ci++) {
                                    const child = listContainer.children[ci];
                                    const childText = (child as HTMLElement).innerText || '';
                                    const childImgs = child.querySelectorAll('img');
                                    // Score: number of sub-children + number of images
                                    const score = child.children.length + childImgs.length;
                                    if (score > bestScore && childText.length > 50) {
                                        bestScore = score;
                                        bestChild = child;
                                    }
                                }
                                // If the best child has significantly more children than others, dive in
                                if (bestChild && bestChild.children.length >= 2) {
                                    listContainer = bestChild;
                                    // Unwrap again if needed
                                    for (let depth = 0; depth < 2; depth++) {
                                        if (listContainer.children.length === 1 && listContainer.children[0].children.length > 1) {
                                            listContainer = listContainer.children[0];
                                        } else {
                                            break;
                                        }
                                    }
                                }
                            }

                            // Each direct child of the list container is a conversation row
                            const candidates: Element[] = [];
                            for (let i = 0; i < listContainer.children.length; i++) {
                                const row = listContainer.children[i] as HTMLElement;
                                const text = row.innerText || '';
                                const lines = text.split('\n').filter((l: string) => l.trim());
                                // Skip header-like items (tabs: "All", "Requests", "Search", "Chat")
                                if (lines.length <= 2 && /^(All|Requests|Search|Chat|Messages)$/i.test(lines[0]?.trim() || '')) continue;
                                // A conversation row: has a name + some text, not too long (< 300 per row)
                                if (lines.length >= 2 && text.length > 5 && text.length < 300) {
                                    candidates.push(row);
                                }
                            }
                            if (candidates.length >= 2) items = candidates as any;
                        }
                    }
                }
            }

            // Strategy 4 (old Strategy 3): Use profile images as anchors to find conversation rows
            if (items.length === 0) {
                // Find all profile images in the inbox panel
                const inboxEl = document.querySelector('[data-testid="dm-inbox-panel"]') || document.body;
                const allImgs = inboxEl.querySelectorAll('img');
                const profileImgs = Array.from(allImgs).filter(img => {
                    const src = img.src || '';
                    return src.includes('twimg') || src.includes('profile');
                });

                const seen = new Set<Element>();
                for (const img of profileImgs) {
                    // Walk up to find the clickable conversation row
                    // Looking for an element that contains: 1 img + text with name + message preview
                    let el: Element | null = img;
                    for (let i = 0; i < 10 && el; i++) {
                        el = el.parentElement;
                        if (!el || seen.has(el)) continue;
                        // Skip if this is the main inbox panel itself or the wrapper
                        if (el.getAttribute?.('data-testid') === 'dm-inbox-panel') break;
                        if (el.getAttribute?.('data-testid') === 'DmScrollerContainer') break;

                        const innerText = (el as HTMLElement).innerText || '';
                        const lines = innerText.split('\n').filter((l: string) => l.trim());
                        // A conversation row typically has 2-5 lines (name, time, message)
                        if (lines.length >= 2 && lines.length <= 8 && innerText.length < 400) {
                            // Verify this looks like a conversation (has name-like text)
                            const firstLine = lines[0].trim();
                            if (firstLine.length > 0 && firstLine.length < 50) {
                                // Also check this element has a profile image inside
                                const hasImg = el.querySelector('img') !== null;
                                if (hasImg) {
                                    seen.add(el);
                                    break;
                                }
                            }
                        }
                    }
                }
                if (seen.size > 0) items = Array.from(seen) as any;
            }

            for (const item of items) {
                const text = (item as HTMLElement).innerText || '';
                const lines = text.split('\n').filter((l: string) => l.trim());
                if (lines.length === 0) continue;

                // Extract username: look for spans, or use first line of text
                const nameEl = item.querySelector('span[dir="ltr"]') || item.querySelector('span[dir="auto"]');
                let username = nameEl?.textContent?.trim() || '';

                // If no name found via span, use the first non-empty line
                // that doesn't look like a time indicator
                if (!username) {
                    for (const line of lines) {
                        if (!/^\d+[hmd]$|^(All|Requests|Search)$/i.test(line.trim())) {
                            username = line.trim();
                            break;
                        }
                    }
                }
                if (!username) continue;

                // Extract last message: usually the last line, or line containing "You:"
                let lastMessage = '';
                for (let i = lines.length - 1; i >= 0; i--) {
                    const line = lines[i].trim();
                    // Skip time indicators and tab labels
                    if (/^\d+[hmd]$|^(All|Requests|Search)$/i.test(line)) continue;
                    if (line === username) continue;
                    lastMessage = line;
                    break;
                }

                // ── Unread detection ──────────────────────────────
                let unread = false;

                // Method 1: Bold text detection (more than just name being bold)
                const spans = item.querySelectorAll('span');
                let boldCount = 0;
                for (const span of spans) {
                    const weight = parseInt(window.getComputedStyle(span).fontWeight) || 400;
                    if (weight >= 700) boldCount++;
                }
                if (boldCount > 1) unread = true;

                // Method 2: Small circular unread indicator dot
                if (!unread) {
                    const children = item.querySelectorAll('div, span');
                    for (const child of children) {
                        const rect = (child as HTMLElement).getBoundingClientRect();
                        if (rect.width >= 4 && rect.width <= 12 && rect.height >= 4 && rect.height <= 12) {
                            const cStyle = window.getComputedStyle(child as HTMLElement);
                            const br = parseFloat(cStyle.borderRadius) || 0;
                            if (br >= rect.width / 2 - 1) {
                                const bg = cStyle.backgroundColor;
                                if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent' && bg !== 'rgb(255, 255, 255)') {
                                    unread = true;
                                    break;
                                }
                            }
                        }
                    }
                }

                // Method 3: aria-label containing "unread"
                if (!unread) {
                    const ariaLabel = (item as HTMLElement).getAttribute('aria-label') || '';
                    if (/unread/i.test(ariaLabel)) unread = true;
                }

                results.push({
                    username,
                    lastMessage,
                    lastMessageTime: '',
                    unread,
                    profilePicUrl: ''
                });
            }

            // Strategy 5 (final text fallback): Parse panel innerText into conversation chunks
            // Runs when DOM-based strategies produced 0 results — most resilient to UI changes
            if (results.length === 0) {
                const inboxPanel = document.querySelector('[data-testid="dm-inbox-panel"]')
                    || document.querySelector('[data-testid="DmScrollerContainer"]');
                if (inboxPanel) {
                    const fullText = (inboxPanel as HTMLElement).innerText || '';
                    const allLines = fullText.split('\n').filter((l: string) => l.trim());

                    const headerLabels = new Set(['chat', 'search', 'all', 'requests', 'messages', 'compose', 'new message']);
                    let startIdx = 0;
                    while (startIdx < allLines.length && headerLabels.has(allLines[startIdx].trim().toLowerCase())) {
                        startIdx++;
                    }

                    const isTimeIndicator = (line: string): boolean => {
                        const t = line.trim();
                        return /^\d+[hmdw]$/i.test(t) ||
                            /^\d+\s*(hour|min|day|week|month|sec)/i.test(t) ||
                            /^(yesterday|today|just now)$/i.test(t) ||
                            /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s+\d+/i.test(t) ||
                            /^\d{1,2}\/\d{1,2}/i.test(t);
                    };

                    const textConversations: Array<{name: string; time: string; message: string}> = [];
                    let i = startIdx;
                    while (i < allLines.length) {
                        const candidateName = allLines[i].trim();
                        const visibleName5 = candidateName.replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
                        const isLikelyName5 = visibleName5.length > 1 && candidateName.length < 35 &&
                            !isTimeIndicator(candidateName) &&
                            !candidateName.startsWith('You:') &&
                            !candidateName.startsWith('Hey') &&
                            !candidateName.startsWith('Hi ') &&
                            !candidateName.startsWith('We ') &&
                            !candidateName.startsWith('I ') &&
                            !candidateName.startsWith('```') &&
                            !candidateName.includes('. ') &&
                            !candidateName.includes('! ') &&
                            !candidateName.includes('? ') &&
                            !/^[a-z]/.test(candidateName) &&
                            candidateName.split(' ').length <= 5 &&
                            !headerLabels.has(candidateName.toLowerCase());

                        if (isLikelyName5) {
                            let time = '';
                            let message = '';

                            if (i + 1 < allLines.length && isTimeIndicator(allLines[i + 1].trim())) {
                                time = allLines[i + 1].trim();
                                if (i + 2 < allLines.length && !isTimeIndicator(allLines[i + 2].trim())) {
                                    const nextLine = allLines[i + 2].trim();
                                    if (i + 3 >= allLines.length || !isTimeIndicator(allLines[i + 3].trim()) || nextLine.startsWith('You:') || nextLine.length > 40) {
                                        message = nextLine;
                                        i += 3;
                                    } else {
                                        i += 2;
                                    }
                                } else {
                                    i += 2;
                                }
                            } else if (i + 1 < allLines.length) {
                                message = allLines[i + 1].trim();
                                i += 2;
                            } else {
                                i += 1;
                            }

                            textConversations.push({ name: candidateName, time, message });
                        } else {
                            i++;
                        }
                    }

                    for (const conv of textConversations) {
                        results.push({
                            username: conv.name,
                            lastMessage: conv.message,
                            lastMessageTime: conv.time,
                            unread: false,
                            profilePicUrl: ''
                        });
                    }
                }
            }

            return results;
        });

        // If scrollToLoadAll collected extra text, parse it and merge with DOM results
        if (scrollToLoadAll && collectedTexts.size > 0) {
            const scrollConversations = this.parseConversationText(Array.from(collectedTexts));
            // Merge: add any conversations not already found by DOM scraping
            const existingNames = new Set(conversations.map((c: any) => c.username.toLowerCase()));
            for (const conv of scrollConversations) {
                if (!existingNames.has(conv.username.toLowerCase())) {
                    conversations.push(conv);
                    existingNames.add(conv.username.toLowerCase());
                }
            }
        }

        // Debug: capture screenshot when no conversations found
        if (conversations.length === 0) {
            try {
                await this.page.screenshot({ path: screenshotPath('twitter-dm-empty-inbox.png'), fullPage: false });
                // Also log the page URL and any visible text for debugging
                const debugInfo = await this.page.evaluate(() => {
                    const inboxPanel = document.querySelector('[data-testid="dm-inbox-panel"]');
                    const panelChildren = inboxPanel ? Array.from(inboxPanel.children).map(c => ({
                        tag: c.tagName,
                        testId: c.getAttribute?.('data-testid') || '',
                        childCount: c.children?.length || 0,
                        text: (c as HTMLElement).innerText?.slice(0, 60) || ''
                    })).slice(0, 10) : [];
                    const imgs = document.querySelectorAll('img');
                    const imgSrcs = Array.from(imgs).map(i => i.src || '').filter(s => s.includes('twimg') || s.includes('profile')).slice(0, 5);
                    const links = document.querySelectorAll('a[href*="/messages"], a[href*="/i/chat/"]');
                    const buttons = document.querySelectorAll('[data-testid="dm-inbox-panel"] [role="button"], [data-testid="dm-inbox-panel"] [tabindex="0"]');
                    return {
                        url: window.location.href,
                        testIds: Array.from(document.querySelectorAll('[data-testid]')).map(
                            el => el.getAttribute('data-testid')
                        ).filter((v, i, a) => a.indexOf(v) === i).slice(0, 20),
                        panelChildren,
                        imgSrcs,
                        linkCount: links.length,
                        buttonCount: buttons.length,
                        inboxPanelHTML: inboxPanel?.innerHTML?.slice(0, 500) || 'no panel'
                    };
                });
                logger.warn(`[twitter-dm] Empty inbox scrape — URL: ${debugInfo.url}, testIds: ${debugInfo.testIds.join(', ')}`);
                logger.warn(`[twitter-dm] Debug: ${debugInfo.linkCount} links, ${debugInfo.buttonCount} buttons, ${debugInfo.imgSrcs.length} profile imgs`);
                logger.warn(`[twitter-dm] Panel children: ${JSON.stringify(debugInfo.panelChildren).slice(0, 300)}`);
                logger.debug(`[twitter-dm] Panel HTML: ${debugInfo.inboxPanelHTML}`);
            } catch (_) {}
        }

        const unreadCount = conversations.filter((c: any) => c.unread).length;
        logger.info(`[twitter-dm] Scraped ${conversations.length} conversations from inbox (${unreadCount} unread)`);
        return conversations;
    }

    /**
     * Parse conversation data from raw text lines (used by scroll collection and Strategy 5).
     * Expects lines like: Name, TimeIndicator, Message preview
     */
    private parseConversationText(lines: string[]): ConversationPreview[] {
        const headerLabels = new Set(['chat', 'search', 'all', 'requests', 'messages', 'compose', 'new message']);
        const results: ConversationPreview[] = [];

        // Filter and sort lines (remove headers)
        const allLines = lines.filter(l => l.trim() && !headerLabels.has(l.trim().toLowerCase()));

        const isTimeIndicator = (line: string): boolean => {
            const t = line.trim();
            return /^\d+[hmdw]$/i.test(t) ||
                /^\d+\s*(hour|min|day|week|month|sec)/i.test(t) ||
                /^(yesterday|today|just now)$/i.test(t) ||
                /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s+\d+/i.test(t) ||
                /^\d{1,2}\/\d{1,2}/i.test(t);
        };

        let i = 0;
        while (i < allLines.length) {
            const candidateName = allLines[i].trim();
            // A valid name: short, not a time indicator, not a message preview
            const visibleName = candidateName.replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
            const isLikelyName = visibleName.length > 1 && candidateName.length < 35 &&
                !isTimeIndicator(candidateName) &&
                !candidateName.startsWith('You:') &&
                !candidateName.startsWith('Hey') &&
                !candidateName.startsWith('Hi ') &&
                !candidateName.startsWith('We ') &&
                !candidateName.startsWith('I ') &&
                !candidateName.startsWith('```') &&
                !candidateName.includes('. ') && // Sentences have periods followed by spaces
                !candidateName.includes('! ') && // Exclamations
                !candidateName.includes('? ') && // Questions
                !/^[a-z]/.test(candidateName) && // Names start with uppercase (or emoji/special)
                candidateName.split(' ').length <= 5 && // Names rarely have 5+ words
                !headerLabels.has(candidateName.toLowerCase());

            if (isLikelyName) {
                let time = '';
                let message = '';

                if (i + 1 < allLines.length && isTimeIndicator(allLines[i + 1].trim())) {
                    time = allLines[i + 1].trim();
                    if (i + 2 < allLines.length && !isTimeIndicator(allLines[i + 2].trim())) {
                        const nextLine = allLines[i + 2].trim();
                        if (i + 3 >= allLines.length || !isTimeIndicator(allLines[i + 3].trim()) || nextLine.startsWith('You:') || nextLine.length > 40) {
                            message = nextLine;
                            i += 3;
                        } else {
                            i += 2;
                        }
                    } else {
                        i += 2;
                    }
                } else if (i + 1 < allLines.length) {
                    message = allLines[i + 1].trim();
                    i += 2;
                } else {
                    i += 1;
                }

                results.push({
                    username: candidateName,
                    lastMessage: message,
                    lastMessageTime: time,
                    unread: false,
                    profilePicUrl: ''
                });
            } else {
                i++;
            }
        }
        return results;
    }

    // ── Scrape messages from a specific thread ──────────────────────

    async scrapeThread(username: string, maxScroll = 5): Promise<DMMessage[]> {
        if (!this.page) throw new Error('Page not initialized');

        // Open the thread
        await this.navigateToInbox();
        await delay(2000);
        const found = await this.openExistingThread(username);
        if (!found) {
            logger.warn(`[twitter-dm] Thread with "${username}" not found`);
            return [];
        }
        await delay(3000);

        // Scroll up to load older messages
        for (let i = 0; i < maxScroll; i++) {
            await this.page.evaluate(() => {
                const msgContainer = document.querySelector('div[data-testid="DmScrollerContainer"]')
                    || document.querySelector('section[role="region"]')
                    || document.querySelector('div[style*="overflow"]');
                if (msgContainer) msgContainer.scrollTop = 0;
            });
            await delay(1500);
        }

        // Extract messages
        const messages = await this.page.evaluate((ourUsername: string) => {
            const results: any[] = [];
            const msgElements = document.querySelectorAll('div[data-testid="messageEntry"], div[data-testid="tweetText"], div[role="row"]');
            for (const msg of msgElements) {
                const text = (msg as HTMLElement).innerText?.trim();
                if (!text) continue;
                // On Twitter, our own messages are typically right-aligned with a blue background
                const isOurs = (msg as HTMLElement).querySelector('div[style*="flex-end"]') !== null
                    || (msg as HTMLElement).closest('[data-testid="DMSentMessage"]') !== null;
                results.push({
                    sender: isOurs ? ourUsername : 'them',
                    text,
                    timestamp: '',
                    isOurs
                });
            }
            return results;
        }, process.env.TWITTER_BOT_USERNAME || 'unknown');

        logger.info(`[twitter-dm] Scraped ${messages.length} messages from thread with "${username}"`);
        return messages;
    }

    // ── Private helper methods ───────────────────────────────────────

    private async dismissDialogs(): Promise<void> {
        if (!this.page) return;
        try {
            const allBtns = await this.page.$$('button, div[role="button"]');
            for (const btn of allBtns) {
                const text = await btn.evaluate(el => (el.textContent || '').trim().toLowerCase());
                if (text === 'not now' || text === 'dismiss' || text === 'maybe later') {
                    await btn.click();
                    await delay(500);
                    break;
                }
            }
        } catch (e) {
            logger.debug(`[twitter-dm] Dialog dismiss failed: ${formatError(e)}`);
        }
    }

    private async clickNewMessage(): Promise<boolean> {
        if (!this.page) return false;

        // Try Twitter/X specific selectors
        const selectors = [
            'a[data-testid="NewDM_Button"]',
            'button[data-testid="NewDM_Button"]',
            'a[href="/messages/compose"]',
            '[data-testid="DM_new-conversation-button"]',
            'svg[aria-label="New message"]',
            'svg[aria-label="New Message"]',
            '[aria-label="New message"]',
            '[aria-label="New Message"]',
        ];

        for (const sel of selectors) {
            const el = await this.page.$(sel);
            if (el) {
                const clicked = await el.evaluate((node) => {
                    const clickTarget = node.closest('a, button, div[role="button"]') || node.parentElement || node;
                    if (clickTarget) { (clickTarget as HTMLElement).click(); return true; }
                    return false;
                });
                if (clicked) {
                    logger.info(`[twitter-dm] Clicked new message button via ${sel}`);
                    return true;
                }
            }
        }

        // Fallback 1: Navigate directly to compose URL
        try {
            await this.page.goto('https://x.com/messages/compose', {
                waitUntil: 'domcontentloaded', timeout: 15000
            });
            await delay(2000);
            // Check if compose dialog appeared
            const hasSearchPeople = await this.page.$('input[data-testid="searchPeople"], input[placeholder*="Search"]');
            if (hasSearchPeople) {
                logger.info('[twitter-dm] Opened compose via direct URL /messages/compose');
                return true;
            }
        } catch (e) {
            logger.debug(`[twitter-dm] Direct compose URL failed: ${formatError(e)}`);
        }

        // Fallback 2: Click "New chat" button (visible in inbox center)
        const newChatBtn = await this.page.evaluate(() => {
            const btns = document.querySelectorAll('button, div[role="button"], a');
            for (const btn of btns) {
                const text = (btn as HTMLElement).innerText?.trim().toLowerCase() || '';
                if (text === 'new chat' || text === 'new message') {
                    (btn as HTMLElement).click();
                    return true;
                }
            }
            return false;
        });
        if (newChatBtn) {
            logger.info('[twitter-dm] Clicked "New chat" button via text match');
            return true;
        }

        logger.warn('[twitter-dm] New message button not found');
        return false;
    }

    private async searchAndSelectRecipient(recipientName: string): Promise<boolean> {
        if (!this.page) return false;

        // Find the search input in the "New Message" dialog
        const searchSelectors = [
            'input[data-testid="searchPeople"]',
            'input[placeholder*="Search"]',
            'input[placeholder*="search"]',
            'input[aria-label*="Search"]',
            'input[type="text"]',
        ];

        let searchInput: ElementHandle<Element> | null = null;
        for (const sel of searchSelectors) {
            searchInput = await this.page.$(sel);
            if (searchInput) {
                logger.info(`[twitter-dm] Found search input: ${sel}`);
                break;
            }
        }

        if (!searchInput) {
            logger.warn('[twitter-dm] Search input not found in new message dialog');
            return false;
        }

        // Type the recipient name
        await searchInput.click();
        await delay(300);
        await this.page.keyboard.type(recipientName, { delay: 50 });
        await delay(2000); // Wait for search results

        // Wait a bit longer for search results to populate
        await delay(3000);

        // Click the first matching result
        const resultClicked = await this.page.evaluate((name: string) => {
            const nameLower = name.toLowerCase();
            // Look for clickable items in the dialog/modal
            const dialog = document.querySelector('[role="dialog"]') || document.querySelector('[aria-modal="true"]');
            const container = dialog || document;

            // Try Twitter-specific selectors first
            const specificSelectors = [
                '[data-testid="TypeaheadUser"]',
                '[data-testid="UserCell"]',
                '[data-testid="listTimelineItem"]',
            ];
            for (const sel of specificSelectors) {
                const items = container.querySelectorAll(sel);
                for (const item of items) {
                    const text = (item as HTMLElement).innerText?.toLowerCase() || '';
                    if (text.includes(nameLower)) {
                        (item as HTMLElement).click();
                        return true;
                    }
                }
            }

            // Broader search: any item containing the username in the dialog
            const allItems = container.querySelectorAll('div[role="button"], button, div[role="option"], li[role="listitem"], div[role="row"]');
            for (const item of allItems) {
                const text = (item as HTMLElement).innerText?.toLowerCase() || '';
                if (text.includes(nameLower) && text.length < 200) {
                    (item as HTMLElement).click();
                    return true;
                }
            }

            // Last resort: find any element with the @handle
            const handleSpans = container.querySelectorAll('span');
            for (const span of handleSpans) {
                const text = span.textContent?.toLowerCase().trim() || '';
                if (text === `@${nameLower}` || text === nameLower) {
                    const clickable = span.closest('div[role="button"], button, a, [data-testid="TypeaheadUser"], [data-testid="UserCell"]');
                    if (clickable) {
                        (clickable as HTMLElement).click();
                        return true;
                    }
                    // Click the span's parent row
                    const row = span.closest('div[class]');
                    if (row) {
                        (row as HTMLElement).click();
                        return true;
                    }
                }
            }
            return false;
        }, recipientName);

        if (resultClicked) {
            logger.info(`[twitter-dm] Selected recipient: "${recipientName}"`);
        } else {
            logger.warn(`[twitter-dm] Recipient "${recipientName}" not found in search results`);
        }
        return resultClicked;
    }

    private async clickNext(): Promise<boolean> {
        if (!this.page) return false;

        // Look for "Next" button in the dialog
        const allBtns = await this.page.$$('div[role="button"], button');
        for (const btn of allBtns) {
            try {
                const info = await btn.evaluate(el => {
                    const text = (el.textContent || '').trim().toLowerCase();
                    const testId = el.getAttribute('data-testid') || '';
                    const rect = el.getBoundingClientRect();
                    return { text, testId, visible: rect.width > 0 && rect.height > 0 };
                });
                if ((info.text === 'next' || info.testId === 'nextButton') && info.visible) {
                    logger.info(`[twitter-dm] Clicking "Next" button`);
                    await btn.click();
                    return true;
                }
            } catch (e) {
                logger.debug(`[twitter-dm] Button eval failed: ${formatError(e)}`);
            }
        }

        logger.warn('[twitter-dm] Next button not found');
        return false;
    }

    private async openDMFromProfile(username: string): Promise<boolean> {
        if (!this.page) return false;

        try {
            // Navigate to user's profile
            await this.page.goto(`https://x.com/${username}`, {
                waitUntil: 'domcontentloaded', timeout: 30000
            });
            await delay(3000);

            // Look for the DM/Message button on their profile
            // Twitter uses a mail/envelope icon button on profiles
            const dmClicked = await this.page.evaluate(() => {
                // Method 1: data-testid for the DM button
                const dmBtn = document.querySelector('[data-testid="sendDMFromProfile"]');
                if (dmBtn) {
                    (dmBtn as HTMLElement).click();
                    return 'sendDMFromProfile';
                }

                // Method 2: aria-label "Message" button
                const msgBtns = document.querySelectorAll('button[aria-label="Message"], div[role="button"][aria-label="Message"]');
                for (const btn of msgBtns) {
                    const rect = (btn as HTMLElement).getBoundingClientRect();
                    if (rect.width > 0 && rect.height > 0) {
                        (btn as HTMLElement).click();
                        return 'aria-label-message';
                    }
                }

                // Method 3: Look for envelope/mail SVG icon in action buttons area
                const svgs = document.querySelectorAll('svg');
                for (const svg of svgs) {
                    const label = svg.getAttribute('aria-label')?.toLowerCase() || '';
                    if (label === 'message' || label === 'direct message') {
                        const btn = svg.closest('button, div[role="button"], a');
                        if (btn) {
                            (btn as HTMLElement).click();
                            return 'svg-message-icon';
                        }
                    }
                }

                return null;
            });

            if (dmClicked) {
                logger.info(`[twitter-dm] Clicked DM button on @${username}'s profile via ${dmClicked}`);
                await delay(3000);

                // Check if we landed in a DM thread
                // Twitter uses both /messages/ and /i/chat/ URL patterns
                const currentUrl = this.page.url();
                if (currentUrl.includes('/messages/') || currentUrl.includes('/i/chat/')) {
                    logger.info(`[twitter-dm] Successfully opened DM thread from profile: ${currentUrl}`);
                    return true;
                }

                // Sometimes clicking the button opens a DM compose overlay on the same page
                const hasInput = await this.page.$('div[data-testid="dmComposerTextInput"], div[role="textbox"][contenteditable="true"]');
                if (hasInput) {
                    logger.info(`[twitter-dm] DM compose overlay opened from profile`);
                    return true;
                }

                // Wait a bit more and re-check
                await delay(2000);
                const currentUrl2 = this.page.url();
                if (currentUrl2.includes('/messages/') || currentUrl2.includes('/i/chat/')) {
                    logger.info(`[twitter-dm] Successfully opened DM thread from profile (after wait): ${currentUrl2}`);
                    return true;
                }

                logger.warn(`[twitter-dm] DM button clicked but no thread opened (URL: ${currentUrl2})`);
                await this.page.screenshot({ path: screenshotPath('twitter-dm-profile-dm-fail.png'), fullPage: false });
                return false;
            }

            logger.info(`[twitter-dm] No DM button found on @${username}'s profile (DMs may be closed)`);
            await this.page.screenshot({ path: screenshotPath('twitter-dm-profile-no-button.png'), fullPage: false });
            return false;

        } catch (e) {
            logger.warn(`[twitter-dm] openDMFromProfile failed: ${formatError(e)}`);
            return false;
        }
    }

    private async openExistingThread(username: string): Promise<boolean> {
        if (!this.page) return false;

        // First try: use the inbox search bar (placeholder is just "Search")
        // On /i/chat/ page, the search bar is a styled element, may need to click first
        const searchSelectors = [
            '[data-testid="dm-search-bar"] input',
            'input[placeholder="Search"]',
            'input[placeholder="Search Direct Messages"]',
            'input[aria-label="Search"]',
            'input[aria-label*="Search"]',
            'input[data-testid="SearchBox_Search_Input"]',
            'input[data-testid="DmActivitySearch"]',
        ];

        let searchBar: ElementHandle<Element> | null = null;
        for (const sel of searchSelectors) {
            searchBar = await this.page.$(sel);
            if (searchBar) {
                logger.info(`[twitter-dm] Found inbox search bar: ${sel}`);
                break;
            }
        }

        // If no direct input found, try clicking the search area to activate it
        if (!searchBar) {
            const activated = await this.page.evaluate(() => {
                // First try: click the dm-search-bar testid container
                const dmSearchBar = document.querySelector('[data-testid="dm-search-bar"]');
                if (dmSearchBar) {
                    (dmSearchBar as HTMLElement).click();
                    return true;
                }
                // Second try: find any element with "Search" text in the DM sidebar area
                const allEls = document.querySelectorAll('div, span, label');
                for (const el of allEls) {
                    const text = (el as HTMLElement).innerText?.trim();
                    if (text === 'Search' && (el as HTMLElement).getBoundingClientRect().width > 50) {
                        (el as HTMLElement).click();
                        return true;
                    }
                }
                return false;
            });
            if (activated) {
                await delay(1500); // Twitter needs time to expand the search input
                // Now look for the input that appeared
                for (const sel of searchSelectors) {
                    searchBar = await this.page.$(sel);
                    if (searchBar) {
                        logger.info(`[twitter-dm] Found search bar after click activation: ${sel}`);
                        break;
                    }
                }
                // Try generic input anywhere in dm-inbox-panel or page
                if (!searchBar) {
                    searchBar = await this.page.$('[data-testid="dm-inbox-panel"] input')
                        || await this.page.$('input[type="text"]')
                        || await this.page.$('input[type="search"]');
                    if (searchBar) logger.info('[twitter-dm] Found search bar via generic input after activation');
                }
            }
        }

        if (searchBar) {
            await searchBar.click();
            await delay(500);
            await this.page.keyboard.type(username, { delay: 30 });
            await delay(3000); // Wait for search results to populate

            await this.page.screenshot({ path: screenshotPath('twitter-dm-inbox-search.png'), fullPage: false });

            // Click first matching result in search
            const searchResult = await this.page.evaluate((name: string) => {
                const nameLower = name.toLowerCase();
                // Check all clickable items that might be search results
                const selectors = [
                    'div[data-testid="TypeaheadUser"]',
                    'div[data-testid="conversation"]',
                    'div[role="listitem"]',
                    'div[role="row"]',
                    'div[role="option"]',
                    'a[href*="/messages/"]',
                ];
                for (const sel of selectors) {
                    const items = document.querySelectorAll(sel);
                    for (const item of items) {
                        const text = (item as HTMLElement).innerText?.toLowerCase() || '';
                        if (text.includes(nameLower)) {
                            (item as HTMLElement).click();
                            return sel;
                        }
                    }
                }
                // Broader: any element containing the username
                const allDivs = document.querySelectorAll('div[tabindex], li, a');
                for (const el of allDivs) {
                    const text = (el as HTMLElement).innerText?.toLowerCase() || '';
                    if (text.includes(nameLower) && text.length < 200) {
                        (el as HTMLElement).click();
                        return 'generic-click';
                    }
                }
                return null;
            }, username);

            if (searchResult) {
                logger.info(`[twitter-dm] Opened thread via inbox search for "${username}" (${searchResult})`);
                return true;
            }

            // Clear search and fall through to visual scan
            await this.page.keyboard.down('Control');
            await this.page.keyboard.press('a');
            await this.page.keyboard.up('Control');
            await this.page.keyboard.press('Backspace');
            await delay(500);
        } else {
            logger.warn('[twitter-dm] No inbox search bar found');
        }

        // Second try: visually scan sidebar with scrolling
        const MAX_SCROLL_ATTEMPTS = 10;
        const page = this.page;

        const scanSidebar = async (name: string): Promise<boolean> => {
            return page.evaluate((nameLower: string) => {
                // Legacy selectors
                const legacySelectors = 'div[data-testid="conversation"], a[href*="/messages/"], div[role="listitem"], div[role="row"]';
                for (const conv of document.querySelectorAll(legacySelectors)) {
                    const text = (conv as HTMLElement).innerText?.toLowerCase() || '';
                    if (text.includes(nameLower)) {
                        (conv as HTMLElement).click();
                        return true;
                    }
                }
                // New Chat UI
                const inboxPanel = document.querySelector('[data-testid="dm-inbox-panel"]');
                if (inboxPanel) {
                    const imgs = inboxPanel.querySelectorAll('img');
                    for (const img of imgs) {
                        let el: Element | null = img;
                        for (let depth = 0; depth < 8 && el; depth++) {
                            el = el.parentElement;
                            if (!el) break;
                            if (el.getAttribute?.('data-testid') === 'dm-inbox-panel') break;
                            const innerText = (el as HTMLElement).innerText?.toLowerCase() || '';
                            if (innerText.includes(nameLower) && innerText.length < 300) {
                                (el as HTMLElement).click();
                                return true;
                            }
                        }
                    }
                    const allSpans = inboxPanel.querySelectorAll('span');
                    for (const span of allSpans) {
                        const text = span.textContent?.trim().toLowerCase() || '';
                        if (text === nameLower || text.includes(nameLower)) {
                            let clickTarget: HTMLElement | null = span as HTMLElement;
                            for (let d = 0; d < 5 && clickTarget; d++) {
                                clickTarget = clickTarget.parentElement;
                                if (!clickTarget) break;
                                if (clickTarget.getAttribute?.('data-testid') === 'dm-inbox-panel') break;
                                const style = window.getComputedStyle(clickTarget);
                                if (style.cursor === 'pointer' || clickTarget.getAttribute('role') === 'button' || clickTarget.tabIndex >= 0) {
                                    clickTarget.click();
                                    return true;
                                }
                            }
                            (span.parentElement || span as HTMLElement).click();
                            return true;
                        }
                    }
                }
                return false;
            }, name.toLowerCase());
        };

        // First scan without scrolling
        if (await scanSidebar(username)) {
            logger.info(`[twitter-dm] Opened existing thread with "${username}"`);
            return true;
        }

        // Scroll sidebar and scan at each position
        for (let attempt = 0; attempt < MAX_SCROLL_ATTEMPTS; attempt++) {
            const scrolled = await page.evaluate(() => {
                const panel = document.querySelector('[data-testid="dm-inbox-panel"]');
                if (!panel) return false;
                // Find scrollable child container
                const scrollable = panel.querySelector('[style*="overflow"]') || panel;
                const before = scrollable.scrollTop;
                scrollable.scrollBy(0, scrollable.clientHeight * 0.8);
                return scrollable.scrollTop !== before;
            });

            if (!scrolled) break;
            await delay(1500);

            if (await scanSidebar(username)) {
                logger.info(`[twitter-dm] Opened existing thread with "${username}" (after ${attempt + 1} scroll(s))`);
                return true;
            }
        }

        // Reset scroll
        await page.evaluate(() => {
            const panel = document.querySelector('[data-testid="dm-inbox-panel"]');
            if (panel) {
                const scrollable = panel.querySelector('[style*="overflow"]') || panel;
                scrollable.scrollTop = 0;
            }
        });

        logger.warn(`[twitter-dm] Thread not found for "${username}" after scrolling`);
        return false;
    }

    private async typeAndSendMessage(message: string): Promise<boolean> {
        if (!this.page) return false;

        // Find the message input — Twitter uses data-testid selectors
        // The /i/chat/ page may take longer to render the input
        const inputSelectors = [
            // /i/chat/ page uses a plain textarea
            'textarea[placeholder="Unencrypted message"]',
            'textarea[placeholder*="message" i]',
            // /messages/ page uses contenteditable divs
            'div[data-testid="dmComposerTextInput"]',
            'div[data-testid="dmComposerTextInput"] div[contenteditable="true"]',
            'div[role="textbox"][contenteditable="true"]',
            'textarea[data-testid="dmComposerTextInput"]',
            'div[aria-label*="message" i][contenteditable="true"]',
            'div[contenteditable="true"][data-offset-key]',
            'div[data-testid="tweetTextarea_0"]',
        ];

        let msgInput: ElementHandle<Element> | null = null;

        // Try up to 3 rounds with delays (input may still be loading)
        for (let attempt = 0; attempt < 3 && !msgInput; attempt++) {
            if (attempt > 0) {
                logger.info(`[twitter-dm] Waiting for message input (attempt ${attempt + 1}/3)...`);
                await delay(2000);
            }
            for (const sel of inputSelectors) {
                msgInput = await this.page.$(sel);
                if (msgInput) {
                    const visible = await msgInput.evaluate(el => {
                        const rect = el.getBoundingClientRect();
                        return rect.width > 0 && rect.height > 0;
                    });
                    if (visible) {
                        logger.info(`[twitter-dm] Found message input: ${sel}`);
                        break;
                    }
                    msgInput = null;
                }
            }
        }

        // Last resort: try waitForSelector
        if (!msgInput) {
            try {
                msgInput = await this.page.waitForSelector(
                    'textarea[placeholder="Unencrypted message"], div[data-testid="dmComposerTextInput"], div[role="textbox"][contenteditable="true"]',
                    { timeout: 5000, visible: true }
                );
                if (msgInput) logger.info('[twitter-dm] Found message input via waitForSelector');
            } catch (e) {
                logger.debug(`[twitter-dm] waitForSelector timed out: ${formatError(e)}`);
            }
        }

        if (!msgInput) {
            await this.page.screenshot({ path: screenshotPath('twitter-dm-no-input.png'), fullPage: false });
            logger.warn('[twitter-dm] Message input not found after all attempts');
            return false;
        }

        // Click to focus and type
        await msgInput.click();
        await delay(500);
        await this.page.keyboard.type(message, { delay: 40 });
        await delay(1000);

        // Find and click the Send button
        let sent = false;

        // Method 1: Twitter send button with data-testid
        const sendBtn = await this.page.$('button[data-testid="dmComposerSendButton"]');
        if (sendBtn) {
            const visible = await sendBtn.evaluate(el => {
                const rect = el.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0;
            });
            if (visible) {
                logger.info('[twitter-dm] Clicking Send button via data-testid');
                await sendBtn.click();
                sent = true;
            }
        }

        // Method 2: Look for Send button by text/aria-label
        if (!sent) {
            const allBtns = await this.page.$$('div[role="button"], button');
            for (const btn of allBtns) {
                try {
                    const info = await btn.evaluate(el => {
                        const text = (el.textContent || '').trim().toLowerCase();
                        const rect = el.getBoundingClientRect();
                        const ariaLabel = el.getAttribute('aria-label')?.toLowerCase() || '';
                        return { text, ariaLabel, visible: rect.width > 0 && rect.height > 0 };
                    });
                    if ((info.text === 'send' || info.ariaLabel === 'send') && info.visible) {
                        logger.info('[twitter-dm] Clicking Send button via text/aria');
                        await btn.click();
                        sent = true;
                        break;
                    }
                } catch (e) {
                    logger.debug(`[twitter-dm] Send button eval failed: ${formatError(e)}`);
                }
            }
        }

        // Method 3: Look for SVG send icon
        if (!sent) {
            const sendSvg = await this.page.$('svg[aria-label="Send"]') || await this.page.$('svg[aria-label="send"]');
            if (sendSvg) {
                const clicked = await sendSvg.evaluate(svg => {
                    const btn = svg.closest('div[role="button"], button');
                    if (btn) { (btn as HTMLElement).click(); return true; }
                    return false;
                });
                if (clicked) {
                    logger.info('[twitter-dm] Clicked Send via SVG icon');
                    sent = true;
                }
            }
        }

        // Method 4: Press Enter (Twitter DMs send on Enter by default)
        if (!sent) {
            logger.info('[twitter-dm] Trying Enter key to send');
            await this.page.keyboard.press('Enter');
            sent = true;
        }

        return sent;
    }

    private async verifyMessageSent(message: string): Promise<boolean> {
        if (!this.page) return false;
        try {
            await delay(2000);
            const snippet = message.slice(0, 30);

            const result = await this.page.evaluate((text: string) => {
                const body = document.body.innerText;
                const bodyLower = body.toLowerCase();

                // Check for errors
                const errors = ["couldn't send", 'try again', 'failed to send', 'message not sent'];
                const hasError = errors.some(e => bodyLower.includes(e));
                if (hasError) return { verified: false, reason: 'error_banner' };

                // Check if our message text appears in the thread
                if (body.includes(text)) return { verified: true, reason: 'message_visible' };

                // Check if input is empty (message was consumed)
                const inputs = document.querySelectorAll('textarea[placeholder="Unencrypted message"], div[data-testid="dmComposerTextInput"], div[role="textbox"][contenteditable="true"]');
                const allEmpty = Array.from(inputs).every(i => {
                    const content = (i as HTMLTextAreaElement).value || i.textContent || '';
                    return content.trim() === '' || content.trim() === 'Start a new message';
                });
                if (allEmpty) return { verified: true, reason: 'input_cleared' };

                return { verified: false, reason: 'unknown' };
            }, snippet);

            logger.info(`[twitter-dm] verify: ${result.verified ? 'OK' : 'FAIL'} (${result.reason})`);
            return result.verified;
        } catch (e) {
            logger.warn(`[twitter-dm] verify error: ${formatError(e)}`);
            return false;
        }
    }
}

// ── Standalone export for quick usage ────────────────────────────────

export async function sendTwitterDMTo(recipientName: string, message: string): Promise<DMSendResult> {
    const dm = new TwitterDM();
    try {
        await dm.initialize();
        return await dm.sendDM(recipientName, message);
    } finally {
        await dm.close();
    }
}
