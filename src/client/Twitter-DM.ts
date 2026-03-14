import { Page, ElementHandle } from 'puppeteer';
import { logger } from '../utils/logger';
import { screenshotPath, formatError } from '../utils/errors';
import { DMSendResult, DMMessage, ConversationPreview } from '../types/dm';

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
const TIMEOUT = 60000;

// ── Twitter/X DM Automation ─────────────────────────────────────────

export class TwitterDM {
    private page: Page | null = null;
    private browser: any = null;

    constructor() {}

    async initialize(): Promise<void> {
        const puppeteer = await import('puppeteer');
        this.browser = await puppeteer.default.launch({
            headless: false,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-blink-features=AutomationControlled',
                '--window-size=1280,900'
            ],
            userDataDir: './chrome-profile'
        });
        const pages = await this.browser.pages();
        this.page = pages[0] || await this.browser.newPage();
        await this.page!.setViewport({ width: 1280, height: 900 });
        logger.info('[twitter-dm] Browser initialized');
    }

    async close(): Promise<void> {
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

    // ── Navigate to DM inbox ────────────────────────────────────────

    async navigateToInbox(): Promise<void> {
        if (!this.page) throw new Error('Page not initialized');
        logger.info('[twitter-dm] Navigating to inbox...');
        await this.page.goto('https://x.com/messages', {
            waitUntil: 'domcontentloaded',
            timeout: TIMEOUT
        });
        await delay(3000);

        // Dismiss any pop-up dialogs
        await this.dismissDialogs();
        logger.info('[twitter-dm] Inbox loaded');
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

    async scrapeInbox(): Promise<ConversationPreview[]> {
        if (!this.page) throw new Error('Page not initialized');
        await this.navigateToInbox();
        await delay(3000);

        const conversations = await this.page.evaluate(() => {
            const results: any[] = [];
            // Twitter/X DM sidebar has conversation items
            const items = document.querySelectorAll('div[data-testid="conversation"], div[role="listitem"], div[role="row"]');
            for (const item of items) {
                const nameEl = item.querySelector('span[dir="ltr"]') || item.querySelector('span[dir="auto"]');
                const text = (item as HTMLElement).innerText || '';
                const lines = text.split('\n').filter((l: string) => l.trim());

                if (nameEl || lines.length > 0) {
                    results.push({
                        username: nameEl?.textContent?.trim() || lines[0] || '',
                        lastMessage: lines.length > 1 ? lines[lines.length - 1] : '',
                        lastMessageTime: '',
                        unread: false,
                        profilePicUrl: ''
                    });
                }
            }
            return results;
        });

        logger.info(`[twitter-dm] Scraped ${conversations.length} conversations from inbox`);
        return conversations;
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
                // Find any element with "Search" text in the DM sidebar area
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
                await delay(500);
                // Now look for the input that appeared
                for (const sel of searchSelectors) {
                    searchBar = await this.page.$(sel);
                    if (searchBar) {
                        logger.info(`[twitter-dm] Found search bar after click activation: ${sel}`);
                        break;
                    }
                }
                // Try generic input
                if (!searchBar) {
                    searchBar = await this.page.$('input[type="text"]');
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

        // Second try: visually scan sidebar conversations
        const found = await this.page.evaluate((name: string) => {
            const nameLower = name.toLowerCase();
            const conversations = document.querySelectorAll('div[data-testid="conversation"], a[href*="/messages/"]');
            for (const conv of conversations) {
                const text = (conv as HTMLElement).innerText?.toLowerCase() || '';
                if (text.includes(nameLower)) {
                    (conv as HTMLElement).click();
                    return true;
                }
            }
            const items = document.querySelectorAll('div[role="listitem"], div[role="row"]');
            for (const item of items) {
                const text = (item as HTMLElement).innerText?.toLowerCase() || '';
                if (text.includes(nameLower)) {
                    (item as HTMLElement).click();
                    return true;
                }
            }
            return false;
        }, username);

        if (found) {
            logger.info(`[twitter-dm] Opened existing thread with "${username}"`);
        }
        return found;
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
