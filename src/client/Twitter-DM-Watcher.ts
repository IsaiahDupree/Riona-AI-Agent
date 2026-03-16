/**
 * Twitter DM Watcher — State-based new message detection
 *
 * Mirrors Instagram-DM-Watcher's approach: compares current inbox against
 * last known state to detect new messages. Works as a reliable fallback
 * when DOM-based unread detection (bold text, dots) is unreliable.
 */

import { TwitterDM } from './Twitter-DM';
import { logger } from '../utils/logger';
import { formatError } from '../utils/errors';
import { safeReadJSON, safeWriteJSON } from '../utils/errors';
import { ConversationPreview } from '../types/dm';
import * as path from 'path';

// ── State persistence ────────────────────────────────────────────────

const STATE_DIR = path.join(process.cwd(), 'logs', 'tracking', 'twitter-dm');
const WATCHER_STATE_FILE = path.join(STATE_DIR, 'watcher_state.json');

interface TwitterWatcherState {
    lastCheckAt: string;
    knownLastMessages: Record<string, string>; // username → last message text
}

function loadWatcherState(): TwitterWatcherState {
    return safeReadJSON<TwitterWatcherState>(
        WATCHER_STATE_FILE,
        { lastCheckAt: '', knownLastMessages: {} },
        'twitter_watcher_state'
    );
}

function saveWatcherState(state: TwitterWatcherState): void {
    safeWriteJSON(WATCHER_STATE_FILE, state, 'twitter_watcher_state');
}

// ── New message detection ────────────────────────────────────────────

export interface TwitterNewDMResult {
    newMessages: Array<{ from: string; preview: string }>;
    unreadFromDOM: number;
    detectedByState: number;
}

/**
 * Check for new Twitter DMs using dual detection:
 * 1. DOM-based: conversations marked unread by scrapeInbox()
 * 2. State-based: compare lastMessage text against known state
 *
 * Returns the union of both detection methods (deduplicated).
 */
export async function checkForNewTwitterDMs(dm: TwitterDM): Promise<TwitterNewDMResult> {
    const state = loadWatcherState();
    const ourUsername = (process.env.TWITTER_BOT_USERNAME || '').toLowerCase();

    // Scrape current inbox (this already tries DOM-based unread detection)
    let conversations: ConversationPreview[];
    try {
        conversations = await dm.scrapeInbox();
    } catch (e) {
        logger.error(`[twitter-dm-watcher] Failed to scrape inbox: ${formatError(e)}`);
        return { newMessages: [], unreadFromDOM: 0, detectedByState: 0 };
    }

    const newMessages: Array<{ from: string; preview: string }> = [];
    const seen = new Set<string>();
    let unreadFromDOM = 0;
    let detectedByState = 0;

    for (const convo of conversations) {
        const username = convo.username.toLowerCase().replace('@', '');
        if (!username || username === ourUsername) continue;

        // Detection 1: DOM says unread
        if (convo.unread && !seen.has(username)) {
            seen.add(username);
            newMessages.push({ from: convo.username, preview: convo.lastMessage });
            unreadFromDOM++;
        }

        // Detection 2: State comparison — message text changed since last check
        if (!seen.has(username) && convo.lastMessage) {
            const knownLast = state.knownLastMessages[username];
            if (convo.lastMessage !== knownLast) {
                // Only count as new if it doesn't look like our own message
                // Twitter previews for sent messages often start with "You:" or show "You sent..."
                const previewLower = convo.lastMessage.toLowerCase();
                const looksLikeOurs = previewLower.startsWith('you:') ||
                    previewLower.startsWith('you sent') ||
                    previewLower.startsWith('you reacted');
                if (!looksLikeOurs) {
                    seen.add(username);
                    newMessages.push({ from: convo.username, preview: convo.lastMessage });
                    detectedByState++;
                }
            }
        }

        // Update known state for this conversation
        if (convo.lastMessage) {
            state.knownLastMessages[username] = convo.lastMessage;
        }
    }

    // Prune stale entries (conversations no longer in inbox) — keep max 200
    const currentUsernames = new Set(conversations.map(c => c.username.toLowerCase().replace('@', '')));
    const staleKeys = Object.keys(state.knownLastMessages).filter(k => !currentUsernames.has(k));
    if (staleKeys.length > 50) {
        // Only prune if there are many stale entries
        for (const key of staleKeys) {
            delete state.knownLastMessages[key];
        }
    }

    state.lastCheckAt = new Date().toISOString();
    saveWatcherState(state);

    if (newMessages.length > 0) {
        logger.info(`[twitter-dm-watcher] Found ${newMessages.length} new message(s) (DOM: ${unreadFromDOM}, state: ${detectedByState})`);
    }

    return { newMessages, unreadFromDOM, detectedByState };
}

/**
 * Reset watcher state — useful for first run or after manual intervention.
 * Scrapes inbox and records current state without flagging anything as new.
 */
export async function initializeTwitterWatcherState(dm: TwitterDM): Promise<number> {
    const ourUsername = (process.env.TWITTER_BOT_USERNAME || '').toLowerCase();
    const conversations = await dm.scrapeInbox(true); // Scroll to load all conversations
    const state: TwitterWatcherState = {
        lastCheckAt: new Date().toISOString(),
        knownLastMessages: {}
    };

    for (const convo of conversations) {
        const username = convo.username.toLowerCase().replace('@', '');
        if (username && username !== ourUsername && convo.lastMessage) {
            state.knownLastMessages[username] = convo.lastMessage;
        }
    }

    saveWatcherState(state);
    logger.info(`[twitter-dm-watcher] Initialized state with ${Object.keys(state.knownLastMessages).length} conversations`);
    return Object.keys(state.knownLastMessages).length;
}
