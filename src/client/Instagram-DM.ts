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

    // ── Navigate to DM inbox ────────────────────────────────────────

    async navigateToInbox(): Promise<void> {
        if (!this.page) throw new Error('Page not initialized');
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

    async scrapeInbox(): Promise<ConversationPreview[]> {
        if (!this.page) throw new Error('Page not initialized');
        await this.navigateToInbox();
        await delay(3000);

        const conversations = await this.page.evaluate(() => {
            const results: any[] = [];
            // Instagram DM sidebar has conversation items with links
            const items = document.querySelectorAll('div[role="listitem"], div[role="row"]');
            for (const item of items) {
                const linkEl = item.querySelector('a[href*="/direct/t/"]');
                const nameEl = item.querySelector('span[dir="auto"]');
                const text = (item as HTMLElement).innerText || '';
                const lines = text.split('\n').filter(l => l.trim());

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

        logger.info(`[dm] Scraped ${conversations.length} conversations from inbox`);
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

        // Look for the conversation in the sidebar
        const found = await this.page.evaluate((name: string) => {
            const nameLower = name.toLowerCase();
            const links = document.querySelectorAll('a[href*="/direct/"]');
            for (const link of links) {
                const text = (link as HTMLElement).innerText?.toLowerCase() || '';
                if (text.includes(nameLower)) {
                    (link as HTMLElement).click();
                    return true;
                }
            }
            // Also search by text content in conversation list
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
            logger.info(`[dm] Opened existing thread with "${username}"`);
        }
        return found;
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
