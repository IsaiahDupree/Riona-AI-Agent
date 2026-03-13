import { Page } from 'puppeteer';
import { InstagramDM } from './Instagram-DM';
import { logger } from '../utils/logger';
import { formatError } from '../utils/errors';
import { notifyNewDM } from '../utils/telegram';
import { DMMessage, ConversationPreview } from '../types/dm';
import * as fs from 'fs';
import * as path from 'path';

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

// ── Persistent conversation store ───────────────────────────────────

const CONVERSATIONS_DIR = path.join(process.cwd(), 'logs', 'tracking', 'dm', 'conversations');
const INBOX_FILE = path.join(process.cwd(), 'logs', 'tracking', 'dm', 'inbox.json');
const WATCHER_STATE_FILE = path.join(process.cwd(), 'logs', 'tracking', 'dm', 'watcher_state.json');

function ensureDirs() {
    if (!fs.existsSync(CONVERSATIONS_DIR)) fs.mkdirSync(CONVERSATIONS_DIR, { recursive: true });
}

// ── Conversation persistence ────────────────────────────────────────

export interface StoredConversation {
    username: string;
    fullName?: string;
    lastScrapedAt: string;
    messages: DMMessage[];
    metadata?: Record<string, any>;
}

function loadConversation(username: string): StoredConversation | null {
    try {
        const filePath = path.join(CONVERSATIONS_DIR, `${username.toLowerCase()}.json`);
        if (fs.existsSync(filePath)) {
            return JSON.parse(fs.readFileSync(filePath, 'utf8'));
        }
    } catch (e) { logger.warn('[dm-watcher] Failed to load conversation: ' + formatError(e)); }
    return null;
}

function saveConversation(convo: StoredConversation) {
    try {
        ensureDirs();
        const filePath = path.join(CONVERSATIONS_DIR, `${convo.username.toLowerCase()}.json`);
        fs.writeFileSync(filePath, JSON.stringify(convo, null, 2));
    } catch (e) {
        logger.error('[dm-watcher] Failed to save conversation', e);
    }
}

function saveInboxSnapshot(conversations: ConversationPreview[]) {
    try {
        ensureDirs();
        fs.writeFileSync(INBOX_FILE, JSON.stringify({
            scrapedAt: new Date().toISOString(),
            conversations
        }, null, 2));
    } catch (e) {
        logger.error('[dm-watcher] Failed to save inbox snapshot', e);
    }
}

interface WatcherState {
    lastCheckAt: string;
    knownLastMessages: Record<string, string>; // username -> last message text
}

function loadWatcherState(): WatcherState {
    try {
        if (fs.existsSync(WATCHER_STATE_FILE)) {
            return JSON.parse(fs.readFileSync(WATCHER_STATE_FILE, 'utf8'));
        }
    } catch (e) { logger.warn('[dm-watcher] Failed to load watcher state: ' + formatError(e)); }
    return { lastCheckAt: '', knownLastMessages: {} };
}

function saveWatcherState(state: WatcherState) {
    try {
        ensureDirs();
        fs.writeFileSync(WATCHER_STATE_FILE, JSON.stringify(state, null, 2));
    } catch (e) { logger.warn('[dm-watcher] Failed to save watcher state: ' + formatError(e)); }
}

// ── Full inbox scraper ──────────────────────────────────────────────

export async function scrapeFullInbox(dm: InstagramDM): Promise<ConversationPreview[]> {
    const page = dm.getPage()!;
    logger.info('[dm-watcher] Scraping full inbox...');

    await page.goto('https://www.instagram.com/direct/inbox/', {
        waitUntil: 'domcontentloaded', timeout: 60000
    });
    await delay(4000);

    // Scroll the conversation list to load more
    const conversations: ConversationPreview[] = [];
    const seenUsernames = new Set<string>();

    for (let scroll = 0; scroll < 10; scroll++) {
        const batch = await page.evaluate(() => {
            const results: any[] = [];
            // Instagram DM inbox: conversations are clickable div containers
            // with profile pic (img), name (span), last message (span), and timestamp
            // They contain img elements for avatars and multiple span[dir="auto"] for text
            // We find conversation items by looking for img elements (profile pics)
            // that are siblings to text spans
            const mainEl = document.querySelector('main');
            if (!mainEl) return results;

            const mainText = mainEl.innerText || '';
            const lines = mainText.split('\n').map(l => l.trim()).filter(l => l.length > 0);

            // The conversation list follows a pattern:
            // Name\nMessage preview\nTimestamp OR Name\nMessage preview · Timestamp
            // Skip UI elements: Primary, General, Requests, Your note, Search, etc.
            const skipWords = ['primary', 'general', 'requests', 'your note', 'search',
                'start your', 'the_isaiah_dupree', 'send message', 'your messages',
                'send a message', 'active', 'unread', 'pinned', 'muted'];

            let i = 0;
            while (i < lines.length) {
                const line = lines[i];
                const lineLower = line.toLowerCase();

                // Skip known UI elements
                if (skipWords.some(s => lineLower.startsWith(s)) || line.length < 2) {
                    i++;
                    continue;
                }

                // A conversation entry: name, then message preview, then possibly timestamp
                // Names don't typically contain "·" or time indicators
                const isTimestamp = /^\d+[mhwd]$/.test(line) || /·/.test(line);
                if (isTimestamp) { i++; continue; }

                // Check if next lines are message preview + timestamp
                const name = line;
                let lastMsg = '';
                let timeStr = '';

                if (i + 1 < lines.length) {
                    const next = lines[i + 1];
                    // Could be a message preview or timestamp
                    if (/^\d+[mhwd]$/.test(next) || next === '·') {
                        timeStr = next;
                    } else {
                        lastMsg = next;
                        if (i + 2 < lines.length) {
                            const timeCandidate = lines[i + 2];
                            if (/^\d+[mhwd]$/.test(timeCandidate) || /·/.test(timeCandidate)) {
                                timeStr = timeCandidate;
                            }
                        }
                    }
                }

                // Only add if the name looks like a username/display name (not too long, not UI text)
                const looksLikeMessage = name.toLowerCase().includes('sent a') || name.toLowerCase().includes('you:') || name.toLowerCase().includes('attachment');
                if (name.length < 60 && !looksLikeMessage && !skipWords.some(s => name.toLowerCase().includes(s))) {
                    results.push({
                        username: name,
                        lastMessage: lastMsg.slice(0, 100),
                        lastMessageTime: timeStr,
                        unread: false
                    });
                }

                // Skip past this conversation entry
                i += (lastMsg ? 2 : 1) + (timeStr ? 1 : 0);
            }
            return results;
        });

        for (const c of batch) {
            const key = c.username.toLowerCase();
            if (!seenUsernames.has(key)) {
                seenUsernames.add(key);
                conversations.push(c);
            }
        }

        // Scroll the sidebar down to load more conversations
        await page.evaluate(() => {
            const main = document.querySelector('main');
            if (main) {
                // Find the scrollable container within main
                const divs = main.querySelectorAll('div');
                for (const div of divs) {
                    if (div.scrollHeight > div.clientHeight && div.clientHeight > 200) {
                        div.scrollTop += 500;
                        break;
                    }
                }
            }
        });
        await delay(1500);

        // Stop if we got a batch (the text-based approach gets all at once)
        if (batch.length > 0) break;
    }

    logger.info(`[dm-watcher] Scraped ${conversations.length} conversations from inbox`);
    saveInboxSnapshot(conversations);
    return conversations;
}

// ── Deep-scrape a single conversation thread ────────────────────────

export async function scrapeConversationThread(
    dm: InstagramDM,
    username: string,
    maxScrolls = 10
): Promise<StoredConversation> {
    const page = dm.getPage()!;
    logger.info(`[dm-watcher] Scraping thread with "${username}"...`);

    // Navigate to inbox and open the thread
    await page.goto('https://www.instagram.com/direct/inbox/', {
        waitUntil: 'domcontentloaded', timeout: 60000
    });
    await delay(3000);

    // Find and click the conversation
    const opened = await page.evaluate((name: string) => {
        const nameLower = name.toLowerCase();
        const items = document.querySelectorAll('a[href*="/direct/t/"]');
        for (const item of items) {
            const text = (item as HTMLElement).innerText?.toLowerCase() || '';
            if (text.includes(nameLower)) {
                (item as HTMLElement).click();
                return true;
            }
        }
        return false;
    }, username);

    if (!opened) {
        logger.warn(`[dm-watcher] Thread with "${username}" not found`);
        return { username, lastScrapedAt: new Date().toISOString(), messages: [] };
    }

    await delay(3000);

    // Scroll up to load older messages
    for (let i = 0; i < maxScrolls; i++) {
        const scrolledUp = await page.evaluate(() => {
            const msgContainer = document.querySelector('div[role="grid"]')
                || document.querySelector('div[role="list"]')
                || document.querySelector('main div[style*="overflow"]');
            if (msgContainer) {
                const prevTop = msgContainer.scrollTop;
                msgContainer.scrollTop = 0;
                return prevTop !== 0;
            }
            return false;
        });
        if (!scrolledUp) break;
        await delay(1500);
    }

    // Extract all messages
    const botUsername = (process.env.INSTAGRAM_BOT_USERNAME || 'the_isaiah_dupree').toLowerCase();
    const messages = await page.evaluate((ourUser: string) => {
        const results: any[] = [];
        // Messages in Instagram DMs are typically in div[role="row"] or similar
        const rows = document.querySelectorAll('div[role="row"]');
        for (const row of rows) {
            const text = (row as HTMLElement).innerText?.trim();
            if (!text || text.length < 1) continue;

            // Instagram aligns sent messages to the right (blue bubbles)
            // Check for blue background or flex-end alignment
            const style = window.getComputedStyle(row as HTMLElement);
            const childDivs = row.querySelectorAll('div');
            let isOurs = false;
            for (const div of childDivs) {
                const bg = window.getComputedStyle(div).backgroundColor;
                // Instagram blue is approximately rgb(0, 149, 246) or similar
                if (bg.includes('0, 149') || bg.includes('3, 133') || bg.includes('0, 100')) {
                    isOurs = true;
                    break;
                }
            }

            // Also check for text alignment
            if (!isOurs) {
                const justify = style.justifyContent || '';
                if (justify.includes('flex-end') || justify.includes('end')) isOurs = true;
            }

            results.push({
                sender: isOurs ? ourUser : 'them',
                text: text.slice(0, 500),
                timestamp: '',
                isOurs
            });
        }
        return results;
    }, botUsername);

    // Deduplicate and filter out UI noise
    const filtered = messages.filter(m =>
        m.text.length > 0 &&
        !m.text.startsWith('Seen') &&
        !m.text.startsWith('Active') &&
        m.text !== 'Message...'
    );

    const convo: StoredConversation = {
        username,
        lastScrapedAt: new Date().toISOString(),
        messages: filtered
    };

    saveConversation(convo);
    logger.info(`[dm-watcher] Scraped ${filtered.length} messages from "${username}"`);
    return convo;
}

// ── Scrape ALL conversations (full deep scrape) ─────────────────────

export async function scrapeAllConversations(
    dm: InstagramDM,
    maxConversations = 20,
    maxScrollsPerThread = 5
): Promise<StoredConversation[]> {
    logger.info(`[dm-watcher] Deep-scraping up to ${maxConversations} conversations...`);
    const inbox = await scrapeFullInbox(dm);
    const results: StoredConversation[] = [];

    for (let i = 0; i < Math.min(inbox.length, maxConversations); i++) {
        const c = inbox[i];
        logger.info(`[dm-watcher] Scraping thread ${i + 1}/${Math.min(inbox.length, maxConversations)}: ${c.username}`);
        try {
            const convo = await scrapeConversationThread(dm, c.username, maxScrollsPerThread);
            results.push(convo);
            await delay(2000); // Pause between threads
        } catch (e) {
            logger.error(`[dm-watcher] Failed to scrape "${c.username}":`, e);
        }
    }

    logger.info(`[dm-watcher] Deep-scrape complete: ${results.length} conversations`);
    return results;
}

// ── DM Watcher — polls for new messages ─────────────────────────────

export async function checkForNewDMs(dm: InstagramDM): Promise<{ newMessages: Array<{ from: string; preview: string }> }> {
    const page = dm.getPage()!;
    const state = loadWatcherState();

    await page.goto('https://www.instagram.com/direct/inbox/', {
        waitUntil: 'domcontentloaded', timeout: 60000
    });
    await delay(4000);

    // Scrape current inbox state using text-based parsing (same as scrapeFullInbox)
    const currentInbox = await page.evaluate(() => {
        const results: Array<{ username: string; lastMessage: string; unread: boolean }> = [];
        const mainEl = document.querySelector('main');
        if (!mainEl) return results;

        const mainText = mainEl.innerText || '';
        const lines = mainText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        const skipWords = ['primary', 'general', 'requests', 'your note', 'search',
            'start your', 'the_isaiah_dupree', 'send message', 'your messages'];

        let i = 0;
        while (i < lines.length) {
            const line = lines[i];
            const lineLower = line.toLowerCase();
            if (skipWords.some(s => lineLower.startsWith(s)) || line.length < 2) { i++; continue; }
            const isTimestamp = /^\d+[mhwd]$/.test(line) || /^·/.test(line);
            if (isTimestamp) { i++; continue; }

            const name = line;
            let lastMsg = '';
            if (i + 1 < lines.length) {
                const next = lines[i + 1];
                if (!/^\d+[mhwd]$/.test(next)) {
                    lastMsg = next;
                }
            }

            if (name.length < 60 && !skipWords.some(s => name.toLowerCase().includes(s))) {
                results.push({ username: name, lastMessage: lastMsg.slice(0, 100), unread: false });
            }
            i += lastMsg ? 3 : 2;
        }
        return results;
    });

    // Compare with known state to find new messages
    const newMessages: Array<{ from: string; preview: string }> = [];
    for (const convo of currentInbox) {
        const knownLast = state.knownLastMessages[convo.username.toLowerCase()];
        if (convo.lastMessage && convo.lastMessage !== knownLast) {
            // Check if this message is FROM them (not our own sent message)
            const isOurs = convo.lastMessage.toLowerCase().startsWith('you:');
            if (!isOurs) {
                newMessages.push({ from: convo.username, preview: convo.lastMessage });
            }
        }
        // Update known state
        state.knownLastMessages[convo.username.toLowerCase()] = convo.lastMessage;
    }

    state.lastCheckAt = new Date().toISOString();
    saveWatcherState(state);

    // Send Telegram notifications for new messages
    for (const msg of newMessages) {
        logger.info(`[dm-watcher] New DM from @${msg.from}: ${msg.preview.slice(0, 50)}`);
        await notifyNewDM(msg.from, msg.preview);
    }

    if (newMessages.length > 0) {
        logger.info(`[dm-watcher] Found ${newMessages.length} new messages`);
    }

    return { newMessages };
}

// ── Watcher loop (run as PM2 process or interval) ──────────────────

export async function startDMWatcher(
    checkIntervalMs = 5 * 60 * 1000 // 5 minutes default
): Promise<void> {
    logger.info(`[dm-watcher] Starting DM watcher (interval: ${checkIntervalMs / 1000}s)`);
    const dm = new InstagramDM();

    try {
        await dm.initialize();

        // Initial scrape to establish baseline
        logger.info('[dm-watcher] Initial inbox scan...');
        await checkForNewDMs(dm);

        // Poll loop
        const interval = setInterval(async () => {
            try {
                await checkForNewDMs(dm);
            } catch (e) {
                logger.error('[dm-watcher] Check failed:', e);
            }
        }, checkIntervalMs);

        // Keep alive
        process.on('SIGINT', async () => {
            clearInterval(interval);
            await dm.close();
            process.exit(0);
        });

    } catch (e) {
        logger.error('[dm-watcher] Watcher init failed:', e);
        await dm.close();
        throw e;
    }
}
