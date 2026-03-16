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
    logger.info('[dm-watcher] Scraping full inbox (with scroll)...');
    const conversations = await dm.scrapeInbox(true);
    saveInboxSnapshot(conversations);
    return conversations;
}

// ── Deep-scrape a single conversation thread ────────────────────────

export async function scrapeConversationThread(
    dm: InstagramDM,
    username: string,
    maxScrolls = 10
): Promise<StoredConversation & { handle?: string }> {
    const page = await dm.ensurePage();
    logger.info(`[dm-watcher] Scraping thread with "${username}"...`);

    // Navigate to inbox and open the thread
    await page.goto('https://www.instagram.com/direct/inbox/', {
        waitUntil: 'domcontentloaded', timeout: 60000
    });
    await delay(3000);

    // Find and click the conversation using span text matching
    const opened = await page.evaluate((name: string) => {
        const nameLower = name.toLowerCase();
        const threadList = document.querySelector('[aria-label="Thread list"]');
        if (threadList) {
            // Match by span text (display name) within the thread list
            const spans = threadList.querySelectorAll('span[dir="auto"]');
            for (const span of spans) {
                const text = (span.textContent || '').trim().toLowerCase();
                if (text === nameLower || text.includes(nameLower)) {
                    // Walk up to find clickable container
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
    }, username);

    if (!opened) {
        logger.warn(`[dm-watcher] Thread with "${username}" not found`);
        return { username, lastScrapedAt: new Date().toISOString(), messages: [] };
    }

    await delay(3000);

    // Extract the actual handle from the thread header
    // Instagram shows <a href="/handle/"> with "View profile" text, or handle in header links
    const handle = await page.evaluate((displayName: string) => {
        const ourHandle = (document.querySelector('h2')?.textContent || '').trim().toLowerCase();

        // Method 1: "View profile" link
        const links = document.querySelectorAll('a');
        for (const a of links) {
            const text = (a.textContent || '').trim().toLowerCase();
            const href = a.getAttribute('href') || '';
            if (text === 'view profile' && href.startsWith('/') && !href.includes('/direct/')) {
                const match = href.match(/^\/([a-zA-Z0-9._]+)\/?$/);
                if (match && match[1] !== ourHandle) return match[1];
            }
        }

        // Method 2: Profile links (href="/handle/" that aren't ours or nav)
        const navPaths = new Set(['/', '/reels/', '/explore/', '/direct/', '/accounts/']);
        for (const a of links) {
            const href = a.getAttribute('href') || '';
            const match = href.match(/^\/([a-zA-Z0-9._]+)\/?$/);
            if (match && !navPaths.has(href) && match[1] !== ourHandle) {
                return match[1];
            }
        }

        // Method 3: H2 elements — the thread header shows the handle in an H2
        const h2s = document.querySelectorAll('h2');
        for (const h2 of h2s) {
            const text = (h2.textContent || '').trim();
            // Skip our own handle and the display name
            if (text.toLowerCase() === ourHandle) continue;
            if (text === displayName) continue;
            // A valid handle is lowercase, has dots/underscores, no spaces
            if (/^[a-zA-Z0-9._]+$/.test(text) && text.length < 40) {
                return text.toLowerCase();
            }
        }

        return null;
    }, username);

    if (handle) {
        logger.info(`[dm-watcher] Resolved handle for "${username}": @${handle}`);
    }

    // Scroll up to load older messages (find scrollable container in thread area)
    for (let i = 0; i < maxScrolls; i++) {
        const scrolledUp = await page.evaluate(() => {
            // Find the message area (right panel, not the thread list)
            const threadList = document.querySelector('[aria-label="Thread list"]');
            const main = document.querySelector('main');
            if (!main) return false;

            // Find scrollable divs NOT inside the thread list
            const divs = main.querySelectorAll('div');
            for (const d of divs) {
                if (threadList && threadList.contains(d)) continue;
                const el = d as HTMLElement;
                if (el.scrollHeight > el.clientHeight + 50 && el.clientHeight > 200) {
                    const prevTop = el.scrollTop;
                    el.scrollTop = 0;
                    return prevTop !== 0;
                }
            }
            return false;
        });
        if (!scrolledUp) break;
        await delay(1500);
    }

    // Extract messages using span[dir="auto"] outside the Thread list
    const botUsername = (process.env.INSTAGRAM_BOT_USERNAME || 'the_isaiah_dupree').toLowerCase();
    const messages = await page.evaluate((ourUser: string) => {
        const results: any[] = [];
        const threadList = document.querySelector('[aria-label="Thread list"]');

        // Helper: check if a span is inside a blue (sent) bubble
        const isInBlueBubble = (span: Element): boolean => {
            let el: HTMLElement | null = span as HTMLElement;
            for (let depth = 0; depth < 10 && el; depth++) {
                const bg = window.getComputedStyle(el).backgroundColor;
                if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') {
                    const match = bg.match(/rgb\((\d+),\s*(\d+),\s*(\d+)/);
                    if (match) {
                        const [, r, g, b] = match.map(Number);
                        // Instagram blue: high blue, lower red and green
                        if (b > 180 && r < 120 && g < 200) return true;
                        // Purple/gradient tones
                        if (b > 150 && r < 150 && g < 150) return true;
                    }
                }
                el = el.parentElement;
            }
            return false;
        };

        // Collect all span[dir="auto"] NOT in the thread list sidebar
        const allSpans = document.querySelectorAll('span[dir="auto"]');
        const msgSpans: Array<{ text: string; y: number; x: number; isOurs: boolean; spanEl: Element }> = [];

        const navTexts = new Set(['home', 'reels', 'messages', 'search', 'explore',
            'notifications', 'create', 'dashboard', 'profile', 'more', 'also from meta',
            'instagram', 'threads', 'settings']);

        for (const span of allSpans) {
            if (threadList && threadList.contains(span)) continue;
            const text = (span.textContent || '').trim();
            if (!text || navTexts.has(text.toLowerCase())) continue;
            const rect = span.getBoundingClientRect();
            if (rect.y < 80 || rect.height === 0) continue;
            if (text === 'Instagram' || text === 'View profile') continue;

            msgSpans.push({
                text, y: rect.y, x: rect.x,
                isOurs: isInBlueBubble(span),
                spanEl: span
            });
        }

        // Filter out header entries (y < 100)
        const filtered = msgSpans.filter(s => s.y > 100);

        // Group messages by Y-band (gap > 20px = different message)
        const groups: Array<Array<{ text: string; x: number; isOurs: boolean }>> = [];
        let currentGroup: Array<{ text: string; x: number; isOurs: boolean }> = [];

        for (let i = 0; i < filtered.length; i++) {
            if (i > 0 && filtered[i].y - filtered[i - 1].y > 20) {
                if (currentGroup.length > 0) groups.push(currentGroup);
                currentGroup = [];
            }
            currentGroup.push({ text: filtered[i].text, x: filtered[i].x, isOurs: filtered[i].isOurs });
        }
        if (currentGroup.length > 0) groups.push(currentGroup);

        for (const group of groups) {
            const fullText = group.map(g => g.text).join(' ');
            if (fullText.includes('messaged you about') || fullText.includes('See Post')) continue;
            if (fullText.length < 2) continue;

            // If ANY span in the group is in a blue bubble, it's our message
            const isOurs = group.some(g => g.isOurs);

            results.push({
                sender: isOurs ? ourUser : 'them',
                text: fullText.slice(0, 500),
                timestamp: '',
                isOurs
            });
        }
        return results;
    }, botUsername);

    // Deduplicate and filter out UI noise
    const filtered = messages.filter((m: any) =>
        m.text.length > 0 &&
        !m.text.startsWith('Seen') &&
        !m.text.startsWith('Active') &&
        m.text !== 'Message...' &&
        !m.text.includes('View profile')
    );

    const convo: StoredConversation & { handle?: string } = {
        username: handle || username,
        lastScrapedAt: new Date().toISOString(),
        messages: filtered,
        handle: handle || undefined
    };

    saveConversation(convo);
    logger.info(`[dm-watcher] Scraped ${filtered.length} messages from "${username}"${handle ? ` (handle: @${handle})` : ''}`);
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

export async function checkForNewDMs(dm: InstagramDM, scrollToLoadAll = false): Promise<{ newMessages: Array<{ from: string; preview: string }> }> {
    const state = loadWatcherState();

    // Use scrapeInbox which handles DOM + text detection (+ optional scroll)
    const mergedInbox = await dm.scrapeInbox(scrollToLoadAll);

    // Compare with known state to find new messages (dual: DOM unread + state change)
    const newMessages: Array<{ from: string; preview: string }> = [];
    const newMsgSeen = new Set<string>();
    for (const convo of mergedInbox) {
        const uKey = convo.username.toLowerCase();

        // Signal 1: DOM says unread
        if (convo.unread && !newMsgSeen.has(uKey)) {
            newMsgSeen.add(uKey);
            newMessages.push({ from: convo.username, preview: convo.lastMessage });
        }

        // Signal 2: State comparison — message text changed since last check
        if (!newMsgSeen.has(uKey) && convo.lastMessage) {
            const knownLast = state.knownLastMessages[uKey];
            if (convo.lastMessage !== knownLast) {
                const isOurs = convo.lastMessage.toLowerCase().startsWith('you:') ||
                    convo.lastMessage.toLowerCase().startsWith('you sent');
                if (!isOurs) {
                    newMsgSeen.add(uKey);
                    newMessages.push({ from: convo.username, preview: convo.lastMessage });
                }
            }
        }

        // Update known state
        if (convo.lastMessage) {
            state.knownLastMessages[uKey] = convo.lastMessage;
        }
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

        // Initial scrape with full scroll to establish baseline
        logger.info('[dm-watcher] Initial inbox scan (full scroll)...');
        await checkForNewDMs(dm, true);

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
