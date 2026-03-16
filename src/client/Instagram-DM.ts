import { Page, ElementHandle } from 'puppeteer';
import { InstagramAI } from './Instagram-AI';
import { logger } from '../utils/logger';
import { screenshotPath, formatError } from '../utils/errors';
import { DMSendResult, DMMessage, ConversationPreview } from '../types/dm';
import { trackDM, hasSentDMTo, createDMSession, saveDMSession } from '../tracking/dmTracker';

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
const TIMEOUT = 60000;

// ── Instagram DM Automation ─────────────────────────────────────────

export class InstagramDM {
    private instagramAI: InstagramAI;
    private page: Page | null = null;

    constructor(instagramAI?: InstagramAI) {
        this.instagramAI = instagramAI || new InstagramAI();
    }

    async initialize(): Promise<void> {
        await this.instagramAI.initialize();
        this.page = this.instagramAI.getPage()!;
        if (!this.page) throw new Error('Failed to get page from InstagramAI');
    }

    async close(): Promise<void> {
        await this.instagramAI.close();
    }

    getPage(): Page | null {
        return this.page;
    }

    /**
     * Ensure the page is still usable. If the frame is detached (stale),
     * re-acquire a valid page reference from the browser.
     */
    async ensurePage(): Promise<Page> {
        // Get browser reference — Page.browser() is the most reliable way
        const browser = this.page?.browser() ?? null;

        // Quick check: try to evaluate on the current page
        if (this.page) {
            try {
                await this.page.evaluate(() => document.readyState);
                return this.page;
            } catch (e) {
                const msg = formatError(e);
                if (msg.includes('detached Frame') || msg.includes('Session closed') || msg.includes('Target closed')) {
                    logger.warn(`[dm] Page frame detached, recovering...`);
                } else {
                    throw e;
                }
            }
        }

        // Recovery: get fresh page from browser
        if (browser) {
            const pages = await browser.pages();
            if (pages.length === 0) {
                this.page = await browser.newPage();
                await this.page!.setViewport({ width: 1280, height: 900 });
                logger.info('[dm] Created new page after recovery');
            } else {
                this.page = pages[pages.length - 1];
                for (let i = 0; i < pages.length - 1; i++) {
                    try { await pages[i].close(); } catch (_) {}
                }
                logger.info(`[dm] Recovered page (closed ${pages.length - 1} stale pages)`);
            }
        } else {
            throw new Error('Cannot recover page — no browser reference available');
        }

        return this.page!;
    }

    // ── Navigate to DM inbox ────────────────────────────────────────

    async navigateToInbox(): Promise<void> {
        this.page = await this.ensurePage();
        logger.info('[dm] Navigating to inbox...');
        await this.page.goto('https://www.instagram.com/direct/inbox/', {
            waitUntil: 'domcontentloaded',
            timeout: TIMEOUT
        });
        await delay(3000);

        // Dismiss any "Turn on notifications" dialogs
        await this.dismissDialogs();
        logger.info('[dm] Inbox loaded');
    }

    // ── Send a DM to a user by searching their name ─────────────────

    async sendDM(recipientName: string, message: string): Promise<DMSendResult> {
        if (!this.page) throw new Error('Page not initialized');
        const timestamp = new Date().toISOString();

        try {
            // Navigate to inbox first
            await this.navigateToInbox();
            await this.page.screenshot({ path: screenshotPath('dm-1-inbox.png'), fullPage: false });

            // Click "New message" icon
            const newMsgClicked = await this.clickNewMessage();
            if (!newMsgClicked) {
                return { success: false, error: 'Could not click New Message button', recipientUsername: recipientName, messageText: message, timestamp, verified: false };
            }
            await delay(2000);
            await this.page.screenshot({ path: screenshotPath('dm-2-new-msg-dialog.png'), fullPage: false });

            // Search for the recipient
            const recipientFound = await this.searchAndSelectRecipient(recipientName);
            if (!recipientFound) {
                // Close dialog
                await this.page.keyboard.press('Escape');
                return { success: false, error: `Recipient "${recipientName}" not found`, recipientUsername: recipientName, messageText: message, timestamp, verified: false };
            }
            await delay(1000);
            await this.page.screenshot({ path: screenshotPath('dm-3-recipient-selected.png'), fullPage: false });

            // Click "Chat" / "Next" to open the thread
            const chatOpened = await this.clickChatOrNext();
            if (!chatOpened) {
                await this.page.keyboard.press('Escape');
                return { success: false, error: 'Could not open chat', recipientUsername: recipientName, messageText: message, timestamp, verified: false };
            }
            await delay(2000);
            await this.page.screenshot({ path: screenshotPath('dm-4-thread-open.png'), fullPage: false });

            // Find the message input and type
            const sent = await this.typeAndSendMessage(message);
            await delay(3000);
            await this.page.screenshot({ path: screenshotPath('dm-5-after-send.png'), fullPage: false });

            // Verify the message appeared
            const verified = await this.verifyMessageSent(message);

            const result: DMSendResult = {
                success: sent,
                recipientUsername: recipientName,
                messageText: message,
                timestamp,
                verified
            };

            if (sent) {
                // Track the DM
                trackDM({
                    recipientUsername: recipientName,
                    messageText: message,
                    timestamp,
                    direction: 'outbound',
                    verified,
                    sessionId: 'manual',
                    conversationId: `dm_${recipientName.replace(/\s+/g, '_').toLowerCase()}`
                });
            }

            logger.info(`[dm] Send result: success=${sent}, verified=${verified}`);
            return result;

        } catch (error) {
            const err = error instanceof Error ? error.message : String(error);
            logger.error('[dm] sendDM failed:', err);
            return { success: false, error: err, recipientUsername: recipientName, messageText: message, timestamp, verified: false };
        }
    }

    // ── Send DM to an existing conversation (by username) ───────────

    async sendToExistingThread(username: string, message: string): Promise<DMSendResult> {
        if (!this.page) throw new Error('Page not initialized');
        const timestamp = new Date().toISOString();

        try {
            // Navigate directly to the user's DM thread
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

            if (sent) {
                trackDM({
                    recipientUsername: username,
                    messageText: message,
                    timestamp,
                    direction: 'outbound',
                    verified,
                    sessionId: 'manual',
                    conversationId: `dm_${username.toLowerCase()}`
                });
            }

            return { success: sent, recipientUsername: username, messageText: message, timestamp, verified };
        } catch (error) {
            const err = error instanceof Error ? error.message : String(error);
            logger.error('[dm] sendToExistingThread failed:', err);
            return { success: false, error: err, recipientUsername: username, messageText: message, timestamp, verified: false };
        }
    }

    // ── Scrape conversation list from inbox ─────────────────────────

    async scrapeInbox(scrollToLoadAll: boolean = false): Promise<ConversationPreview[]> {
        if (!this.page) throw new Error('Page not initialized');
        await this.navigateToInbox();
        await delay(3000);

        // Instagram virtualizes the list — only visible items exist in DOM.
        // Strategy: use span[dir="auto"] + Y-position grouping to read visible
        // conversations, then scroll and repeat to accumulate all.

        // ── DOM span scraper (runs at each scroll position) ──────────
        const scrapeVisibleSpans = async (): Promise<ConversationPreview[]> => {
            return await this.page!.evaluate(() => {
                const results: any[] = [];
                const threadList = document.querySelector('[aria-label="Thread list"]');
                if (!threadList) return results;

                const skipTexts = new Set([
                    'primary', 'general', 'your note', 'start your first note',
                    'search', 'messages', 'edit', 'new message'
                ]);
                const isTimestamp = (s: string): boolean => {
                    const t = s.trim().toLowerCase();
                    return /^\d+[mhwds]$/.test(t) ||
                        /^\d+\s*(hour|min|day|week|month|sec)/i.test(t) ||
                        /^(yesterday|today|just now|now)$/i.test(t) ||
                        /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s+\d+/i.test(t) ||
                        /^\d{1,2}\/\d{1,2}/i.test(t) ||
                        /^·/.test(s);
                };

                const spans = threadList.querySelectorAll('span[dir="auto"]');
                const entries: Array<{ text: string; bold: boolean; y: number }> = [];
                for (const span of spans) {
                    const text = (span.textContent || '').trim();
                    if (!text) continue;
                    const lower = text.toLowerCase();
                    if (skipTexts.has(lower) || lower.startsWith('requests')) continue;
                    const weight = parseInt(window.getComputedStyle(span).fontWeight) || 400;
                    const rect = span.getBoundingClientRect();
                    if (rect.height === 0) continue; // hidden/offscreen
                    entries.push({ text, bold: weight >= 600, y: rect.y });
                }

                if (entries.length === 0) return results;

                // Group by Y-position: gap > 28px = new conversation
                const groups: Array<Array<{ text: string; bold: boolean }>> = [];
                let currentGroup: Array<{ text: string; bold: boolean }> = [entries[0]];
                for (let i = 1; i < entries.length; i++) {
                    if (entries[i].y - entries[i - 1].y > 28) {
                        groups.push(currentGroup);
                        currentGroup = [];
                    }
                    currentGroup.push(entries[i]);
                }
                if (currentGroup.length > 0) groups.push(currentGroup);

                for (const group of groups) {
                    let name = '', message = '', timestamp = '', unread = false;
                    for (const entry of group) {
                        if (!name && !isTimestamp(entry.text)) {
                            name = entry.text;
                            if (entry.bold) unread = true;
                        } else if (name && !message && !isTimestamp(entry.text)) {
                            message = entry.text;
                            if (entry.bold) unread = true;
                        } else if (isTimestamp(entry.text)) {
                            timestamp = entry.text;
                        }
                    }
                    if (!name || name.length > 50) continue;
                    if (!message && !timestamp) continue; // notes section
                    results.push({
                        username: name,
                        lastMessage: message.slice(0, 200),
                        lastMessageTime: timestamp,
                        unread,
                        profilePicUrl: ''
                    });
                }
                return results;
            });
        };

        // ── Scroll helper ────────────────────────────────────────────
        const scrollDown = async () => {
            await this.page!.evaluate(() => {
                const threadList = document.querySelector('[aria-label="Thread list"]');
                if (threadList) {
                    let el: HTMLElement | null = threadList as HTMLElement;
                    for (let depth = 0; depth < 8 && el; depth++) {
                        if (el.scrollHeight > el.clientHeight + 10) {
                            el.scrollBy(0, el.clientHeight * 0.8);
                            return;
                        }
                        el = el.parentElement;
                    }
                }
                const main = document.querySelector('main');
                if (main) {
                    const divs = main.querySelectorAll('div');
                    for (const d of divs) {
                        const el = d as HTMLElement;
                        if (el.scrollHeight > el.clientHeight + 50 && el.clientHeight > 200) {
                            el.scrollBy(0, el.clientHeight * 0.8);
                            return;
                        }
                    }
                }
            });
        };

        const scrollToTop = async () => {
            await this.page!.evaluate(() => {
                const threadList = document.querySelector('[aria-label="Thread list"]');
                if (threadList) {
                    let el: HTMLElement | null = threadList as HTMLElement;
                    for (let depth = 0; depth < 8 && el; depth++) {
                        if (el.scrollHeight > el.clientHeight + 10) {
                            el.scrollTop = 0;
                            return;
                        }
                        el = el.parentElement;
                    }
                }
            });
        };

        // ── Accumulate conversations across scroll positions ─────────
        const allConversations = new Map<string, ConversationPreview>();

        const mergeResults = (batch: ConversationPreview[]) => {
            for (const c of batch) {
                const key = c.username.toLowerCase();
                if (!allConversations.has(key)) {
                    allConversations.set(key, c);
                } else if (c.unread) {
                    // Update unread status if we see it
                    const existing = allConversations.get(key)!;
                    existing.unread = true;
                }
            }
        };

        // Initial scrape (visible conversations)
        const initialBatch = await scrapeVisibleSpans();
        mergeResults(initialBatch);

        if (scrollToLoadAll) {
            const MAX_SCROLL_ATTEMPTS = 25;
            let sameCountStreak = 0;
            let lastCount = allConversations.size;

            for (let attempt = 0; attempt < MAX_SCROLL_ATTEMPTS; attempt++) {
                await scrollDown();
                await delay(1200);

                const batch = await scrapeVisibleSpans();
                mergeResults(batch);

                if (allConversations.size === lastCount) {
                    sameCountStreak++;
                    if (sameCountStreak >= 3) break;
                } else {
                    sameCountStreak = 0;
                    lastCount = allConversations.size;
                }
            }

            logger.info(`[dm] Scroll found ${allConversations.size} conversations`);

            // Scroll back to top
            await scrollToTop();
            await delay(1000);
        }

        const conversations = Array.from(allConversations.values());
        const unreadCount = conversations.filter(c => c.unread).length;
        logger.info(`[dm] Scraped ${conversations.length} conversations from inbox (${unreadCount} unread)`);
        return conversations;
    }

    /**
     * Parse Instagram conversation text lines into ConversationPreview objects.
     * Instagram inbox text pattern: Name\nTimestamp\nMessage preview
     */
    private parseIGConversationText(lines: string[]): ConversationPreview[] {
        const skipWords = new Set(['primary', 'general', 'requests', 'your note', 'search',
            'start your', 'send message', 'your messages', 'unread', 'pinned',
            'muted', 'active', 'online', 'typing', 'messages', 'direct', 'inbox',
            'start your first note', 'edit', 'new message']);
        const botUser = (process.env.INSTAGRAM_BOT_USERNAME || '').toLowerCase();
        const results: ConversationPreview[] = [];

        const isTimestamp = (t: string): boolean => {
            const s = t.trim().toLowerCase();
            return /^\d+[mhwds]$/.test(s) ||
                /^\d+\s*(hour|min|day|week|month|sec)/i.test(s) ||
                /^(yesterday|today|just now|now)$/i.test(s) ||
                /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s+\d+/i.test(s) ||
                /^·/.test(s) ||
                /^\d{1,2}\/\d{1,2}/i.test(s);
        };

        const allLines = lines.filter(l => {
            const t = l.trim().toLowerCase();
            return t.length > 0 &&
                !skipWords.has(t) &&
                t !== botUser &&
                !t.startsWith('requests') &&
                !t.startsWith('start your first');
        });

        let i = 0;
        while (i < allLines.length) {
            const candidateName = allLines[i].trim();
            const clean = candidateName.replace(/[\u200B-\u200D\uFEFF]/g, '').trim();

            // Valid name: reasonable length, not a timestamp, not a message-like line
            if (clean.length > 1 && candidateName.length < 40 &&
                !isTimestamp(candidateName) &&
                !candidateName.startsWith('You:') &&
                !candidateName.startsWith('You sent') &&
                !candidateName.includes('. ') &&
                !/^[a-z]/.test(candidateName) &&
                candidateName.split(' ').length <= 5) {

                let message = '';

                // Next line might be timestamp, then message
                if (i + 1 < allLines.length && isTimestamp(allLines[i + 1].trim())) {
                    if (i + 2 < allLines.length && !isTimestamp(allLines[i + 2].trim())) {
                        message = allLines[i + 2].trim().slice(0, 100);
                        i += 3;
                    } else {
                        i += 2;
                    }
                } else if (i + 1 < allLines.length) {
                    message = allLines[i + 1].trim().slice(0, 100);
                    i += 2;
                } else {
                    i += 1;
                }

                results.push({
                    username: candidateName,
                    lastMessage: message,
                    lastMessageTime: '',
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
            logger.warn(`[dm] Thread with "${username}" not found`);
            return [];
        }
        await delay(3000);

        // Scroll up to load older messages
        for (let i = 0; i < maxScroll; i++) {
            await this.page.evaluate(() => {
                const msgContainer = document.querySelector('div[role="grid"]')
                    || document.querySelector('div[style*="overflow"]');
                if (msgContainer) msgContainer.scrollTop = 0;
            });
            await delay(1500);
        }

        // Extract messages
        const messages = await this.page.evaluate((ourUsername: string) => {
            const results: any[] = [];
            // Message rows in the thread
            const rows = document.querySelectorAll('div[role="row"], div[role="listitem"]');
            for (const row of rows) {
                const text = (row as HTMLElement).innerText?.trim();
                if (!text) continue;
                // Determine sender by alignment or by checking if our username appears
                const isOurs = (row as HTMLElement).querySelector('div[style*="flex-end"]') !== null;
                results.push({
                    sender: isOurs ? ourUsername : 'them',
                    text,
                    timestamp: '',
                    isOurs
                });
            }
            return results;
        }, process.env.INSTAGRAM_BOT_USERNAME || 'the_isaiah_dupree');

        logger.info(`[dm] Scraped ${messages.length} messages from thread with "${username}"`);
        return messages;
    }

    // ── Private helper methods ───────────────────────────────────────

    private async dismissDialogs(): Promise<void> {
        if (!this.page) return;
        try {
            const notNowBtns = await this.page.$$('button');
            for (const btn of notNowBtns) {
                const text = await btn.evaluate(el => (el.textContent || '').trim().toLowerCase());
                if (text === 'not now' || text === 'cancel') {
                    await btn.click();
                    await delay(500);
                    break;
                }
            }
        } catch (e) {
            logger.debug(`[dm] Dialog dismiss failed: ${formatError(e)}`);
        }
    }

    private async clickNewMessage(): Promise<boolean> {
        if (!this.page) return false;

        // Try multiple selectors for the "New message" / compose button
        const selectors = [
            'svg[aria-label="New message"]',
            'svg[aria-label="New Message"]',
            'svg[aria-label="Compose"]',
            '[aria-label="New message"]',
            '[aria-label="New Message"]',
        ];

        for (const sel of selectors) {
            const el = await this.page.$(sel);
            if (el) {
                // Click the parent button/clickable
                const clicked = await el.evaluate((svg) => {
                    const btn = svg.closest('div[role="button"], button, a') || svg.parentElement;
                    if (btn) { (btn as HTMLElement).click(); return true; }
                    return false;
                });
                if (clicked) {
                    logger.info(`[dm] Clicked new message button via ${sel}`);
                    return true;
                }
            }
        }

        // Fallback: look for a button/div with pencil-like icon near top of inbox
        const allBtns = await this.page.$$('div[role="button"], button');
        for (const btn of allBtns) {
            const hasSvg = await btn.evaluate(el => {
                const svg = el.querySelector('svg');
                if (!svg) return false;
                const rect = el.getBoundingClientRect();
                // The new message button is typically in the top area
                return rect.y < 200 && rect.width < 80;
            });
            if (hasSvg) {
                await btn.click();
                logger.info('[dm] Clicked new message button via fallback');
                return true;
            }
        }

        logger.warn('[dm] New message button not found');
        return false;
    }

    private async searchAndSelectRecipient(recipientName: string): Promise<boolean> {
        if (!this.page) return false;

        // Find the search input in the "New Message" dialog
        const searchSelectors = [
            'input[name="queryBox"]',
            'input[placeholder*="Search"]',
            'input[placeholder*="search"]',
            'input[type="text"]',
        ];

        let searchInput: ElementHandle<Element> | null = null;
        for (const sel of searchSelectors) {
            searchInput = await this.page.$(sel);
            if (searchInput) {
                logger.info(`[dm] Found search input: ${sel}`);
                break;
            }
        }

        if (!searchInput) {
            logger.warn('[dm] Search input not found in new message dialog');
            return false;
        }

        // Type the recipient name
        await searchInput.click();
        await delay(300);
        await this.page.keyboard.type(recipientName, { delay: 50 });
        await delay(2000); // Wait for search results

        // Click the first matching result
        // Instagram shows search results as clickable items with username/name text
        const resultClicked = await this.page.evaluate((name: string) => {
            const nameLower = name.toLowerCase();
            // Look for clickable items in the dialog
            const dialog = document.querySelector('[role="dialog"]');
            const container = dialog || document;
            const items = container.querySelectorAll('div[role="button"], button, label');
            for (const item of items) {
                const text = (item as HTMLElement).innerText?.toLowerCase() || '';
                if (text.includes(nameLower)) {
                    (item as HTMLElement).click();
                    return true;
                }
            }
            // Also try checkbox/radio inputs in the results
            const checkboxes = container.querySelectorAll('input[type="checkbox"]');
            for (const cb of checkboxes) {
                const parent = cb.closest('div[role="button"], label, div');
                if (parent) {
                    const text = (parent as HTMLElement).innerText?.toLowerCase() || '';
                    if (text.includes(nameLower)) {
                        (cb as HTMLInputElement).click();
                        return true;
                    }
                }
            }
            return false;
        }, recipientName);

        if (resultClicked) {
            logger.info(`[dm] Selected recipient: "${recipientName}"`);
        } else {
            logger.warn(`[dm] Recipient "${recipientName}" not found in search results`);
        }
        return resultClicked;
    }

    private async clickChatOrNext(): Promise<boolean> {
        if (!this.page) return false;

        // Look for "Chat" or "Next" button in the dialog
        const allBtns = await this.page.$$('div[role="button"], button');
        for (const btn of allBtns) {
            try {
                const info = await btn.evaluate(el => {
                    const text = (el.textContent || '').trim().toLowerCase();
                    const rect = el.getBoundingClientRect();
                    return { text, visible: rect.width > 0 && rect.height > 0 };
                });
                if ((info.text === 'chat' || info.text === 'next') && info.visible) {
                    logger.info(`[dm] Clicking "${info.text}" button`);
                    await btn.click();
                    return true;
                }
            } catch (e) {
                logger.debug(`[dm] Button eval failed: ${formatError(e)}`);
            }
        }

        logger.warn('[dm] Chat/Next button not found');
        return false;
    }

    private async openExistingThread(username: string): Promise<boolean> {
        if (!this.page) return false;

        const MAX_SCROLL_ATTEMPTS = 10;
        const page = this.page;

        // Search function that looks for the thread in the currently visible sidebar
        const searchSidebar = async (name: string): Promise<boolean> => {
            return page.evaluate((nameLower: string) => {
                const threadList = document.querySelector('[aria-label="Thread list"]');
                if (threadList) {
                    const spans = threadList.querySelectorAll('span[dir="auto"]');
                    for (const span of spans) {
                        const text = (span.textContent || '').trim().toLowerCase();
                        if (text === nameLower || text.includes(nameLower)) {
                            let el: HTMLElement | null = span as HTMLElement;
                            for (let i = 0; i < 10 && el; i++) {
                                el = el.parentElement;
                                if (!el) break;
                                const rect = el.getBoundingClientRect();
                                if (rect.height > 40 && rect.width > 200) {
                                    el.click();
                                    return true;
                                }
                            }
                        }
                    }
                }
                // Fallback: links
                const links = document.querySelectorAll('a[href*="/direct/"]');
                for (const link of links) {
                    const text = (link as HTMLElement).innerText?.toLowerCase() || '';
                    if (text.includes(nameLower)) {
                        (link as HTMLElement).click();
                        return true;
                    }
                }
                return false;
            }, name.toLowerCase());
        };

        // First attempt: search without scrolling
        if (await searchSidebar(username)) {
            logger.info(`[dm] Opened existing thread with "${username}"`);
            return true;
        }

        // Scroll sidebar and search at each position
        for (let attempt = 0; attempt < MAX_SCROLL_ATTEMPTS; attempt++) {
            const scrolled = await page.evaluate(() => {
                const threadList = document.querySelector('[aria-label="Thread list"]');
                if (!threadList) return false;
                const before = threadList.scrollTop;
                threadList.scrollBy(0, threadList.clientHeight * 0.8);
                return threadList.scrollTop !== before;
            });

            if (!scrolled) break; // Hit bottom
            await new Promise(r => setTimeout(r, 1500));

            if (await searchSidebar(username)) {
                logger.info(`[dm] Opened existing thread with "${username}" (after ${attempt + 1} scroll(s))`);
                return true;
            }
        }

        // Reset scroll to top for clean state
        await page.evaluate(() => {
            const threadList = document.querySelector('[aria-label="Thread list"]');
            if (threadList) threadList.scrollTop = 0;
        });

        logger.warn(`[dm] Thread not found for "${username}" after scrolling`);
        return false;
    }

    private async typeAndSendMessage(message: string): Promise<boolean> {
        if (!this.page) return false;

        // Find the message input
        const inputSelectors = [
            'textarea[placeholder*="Message"]',
            'textarea[placeholder*="message"]',
            'div[role="textbox"][contenteditable="true"]',
            'p[data-lexical-text="true"]',
        ];

        let msgInput: ElementHandle<Element> | null = null;
        for (const sel of inputSelectors) {
            msgInput = await this.page.$(sel);
            if (msgInput) {
                const visible = await msgInput.evaluate(el => {
                    const rect = el.getBoundingClientRect();
                    return rect.width > 0 && rect.height > 0;
                });
                if (visible) {
                    logger.info(`[dm] Found message input: ${sel}`);
                    break;
                }
                msgInput = null;
            }
        }

        if (!msgInput) {
            logger.warn('[dm] Message input not found');
            return false;
        }

        // Click to focus and type
        await msgInput.click();
        await delay(500);
        await this.page.keyboard.type(message, { delay: 40 });
        await delay(1000);

        // Find and click the Send button
        let sent = false;

        // Method 1: Look for Send button (Puppeteer click for React compatibility)
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
                    logger.info('[dm] Clicking Send button');
                    await btn.click();
                    sent = true;
                    break;
                }
            } catch (e) {
                logger.debug(`[dm] Send button eval failed: ${formatError(e)}`);
            }
        }

        // Method 2: Look for SVG send icon
        if (!sent) {
            const sendSvg = await this.page.$('svg[aria-label="Send"]') || await this.page.$('svg[aria-label="send"]');
            if (sendSvg) {
                const clicked = await sendSvg.evaluate(svg => {
                    const btn = svg.closest('div[role="button"], button');
                    if (btn) { (btn as HTMLElement).click(); return true; }
                    return false;
                });
                if (clicked) {
                    logger.info('[dm] Clicked Send via SVG icon');
                    sent = true;
                }
            }
        }

        // Method 3: Press Enter (Instagram DMs send on Enter)
        if (!sent) {
            logger.info('[dm] Trying Enter key to send');
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
                const errors = ["couldn't send", 'try again', 'action blocked', 'failed to send'];
                const hasError = errors.some(e => bodyLower.includes(e));
                if (hasError) return { verified: false, reason: 'error_banner' };

                // Check if our message text appears in the thread
                if (body.includes(text)) return { verified: true, reason: 'message_visible' };

                // Check if input is empty (message was consumed)
                const inputs = document.querySelectorAll('textarea, div[role="textbox"][contenteditable="true"]');
                const allEmpty = Array.from(inputs).every(i => {
                    const ta = i as HTMLTextAreaElement;
                    const text = ta.value || i.textContent || '';
                    return text.trim() === '' || text.trim() === 'Message...';
                });
                if (allEmpty) return { verified: true, reason: 'input_cleared' };

                return { verified: false, reason: 'unknown' };
            }, snippet);

            logger.info(`[dm] verify: ${result.verified ? '✅' : '❌'} (${result.reason})`);
            return result.verified;
        } catch (e) {
            logger.warn('[dm] verify error:', e);
            return false;
        }
    }
}

// ── Standalone export for quick usage ────────────────────────────────

export async function sendDMTo(recipientName: string, message: string): Promise<DMSendResult> {
    const dm = new InstagramDM();
    try {
        await dm.initialize();
        return await dm.sendDM(recipientName, message);
    } finally {
        await dm.close();
    }
}
