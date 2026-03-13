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
            // Navigate to inbox first
            await this.navigateToInbox();
            await this.page.screenshot({ path: screenshotPath('twitter-dm-1-inbox.png'), fullPage: false });

            // Click "New message" icon
            const newMsgClicked = await this.clickNewMessage();
            if (!newMsgClicked) {
                return { success: false, error: 'Could not click New Message button', recipientUsername: recipientName, messageText: message, timestamp, verified: false };
            }
            await delay(2000);
            await this.page.screenshot({ path: screenshotPath('twitter-dm-2-new-msg-dialog.png'), fullPage: false });

            // Search for the recipient
            const recipientFound = await this.searchAndSelectRecipient(recipientName);
            if (!recipientFound) {
                await this.page.keyboard.press('Escape');
                return { success: false, error: `Recipient "${recipientName}" not found`, recipientUsername: recipientName, messageText: message, timestamp, verified: false };
            }
            await delay(1000);
            await this.page.screenshot({ path: screenshotPath('twitter-dm-3-recipient-selected.png'), fullPage: false });

            // Click "Next" to open the thread
            const chatOpened = await this.clickNext();
            if (!chatOpened) {
                await this.page.keyboard.press('Escape');
                return { success: false, error: 'Could not open chat', recipientUsername: recipientName, messageText: message, timestamp, verified: false };
            }
            await delay(2000);
            await this.page.screenshot({ path: screenshotPath('twitter-dm-4-thread-open.png'), fullPage: false });

            // Find the message input and type
            const sent = await this.typeAndSendMessage(message);
            await delay(3000);
            await this.page.screenshot({ path: screenshotPath('twitter-dm-5-after-send.png'), fullPage: false });

            // Verify the message appeared
            const verified = await this.verifyMessageSent(message);

            const result: DMSendResult = {
                success: sent,
                recipientUsername: recipientName,
                messageText: message,
                timestamp,
                verified
            };

            logger.info(`[twitter-dm] Send result: success=${sent}, verified=${verified}`);
            return result;

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

        // Fallback: look for a compose/pencil icon button
        const allBtns = await this.page.$$('a, button, div[role="button"]');
        for (const btn of allBtns) {
            const hasSvg = await btn.evaluate(el => {
                const svg = el.querySelector('svg');
                if (!svg) return false;
                const rect = el.getBoundingClientRect();
                // The new message button is typically in the header area
                return rect.y < 200 && rect.width < 80;
            });
            if (hasSvg) {
                await btn.click();
                logger.info('[twitter-dm] Clicked new message button via fallback');
                return true;
            }
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

        // Click the first matching result
        const resultClicked = await this.page.evaluate((name: string) => {
            const nameLower = name.toLowerCase();
            // Look for clickable items in the dialog/modal
            const dialog = document.querySelector('[role="dialog"]') || document.querySelector('[aria-modal="true"]');
            const container = dialog || document;
            const items = container.querySelectorAll('div[role="button"], button, div[role="option"], li[role="listitem"]');
            for (const item of items) {
                const text = (item as HTMLElement).innerText?.toLowerCase() || '';
                if (text.includes(nameLower)) {
                    (item as HTMLElement).click();
                    return true;
                }
            }
            // Also try any list items in search results
            const listItems = container.querySelectorAll('[data-testid="TypeaheadUser"], [data-testid="UserCell"]');
            for (const li of listItems) {
                const text = (li as HTMLElement).innerText?.toLowerCase() || '';
                if (text.includes(nameLower)) {
                    (li as HTMLElement).click();
                    return true;
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

    private async openExistingThread(username: string): Promise<boolean> {
        if (!this.page) return false;

        // Look for the conversation in the sidebar
        const found = await this.page.evaluate((name: string) => {
            const nameLower = name.toLowerCase();
            // Twitter DM sidebar conversations
            const conversations = document.querySelectorAll('div[data-testid="conversation"], a[href*="/messages/"]');
            for (const conv of conversations) {
                const text = (conv as HTMLElement).innerText?.toLowerCase() || '';
                if (text.includes(nameLower)) {
                    (conv as HTMLElement).click();
                    return true;
                }
            }
            // Fallback: search by text in list items
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
        const inputSelectors = [
            'div[data-testid="dmComposerTextInput"]',
            'div[data-testid="dmComposerTextInput"] div[contenteditable="true"]',
            'div[role="textbox"][contenteditable="true"]',
            'textarea[data-testid="dmComposerTextInput"]',
            'div[aria-label*="message" i][contenteditable="true"]',
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
                    logger.info(`[twitter-dm] Found message input: ${sel}`);
                    break;
                }
                msgInput = null;
            }
        }

        if (!msgInput) {
            logger.warn('[twitter-dm] Message input not found');
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
                const inputs = document.querySelectorAll('div[data-testid="dmComposerTextInput"], div[role="textbox"][contenteditable="true"]');
                const allEmpty = Array.from(inputs).every(i => {
                    const content = i.textContent || '';
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
