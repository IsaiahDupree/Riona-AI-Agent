/**
 * Twitter Notifications Checker — Scrape notifications to detect
 * replies to our comments/tweets, feed data back into VR scheduler
 * and relationship health. Sync to Supabase.
 */

import { Page } from 'puppeteer';
import { logger } from '../utils/logger';
import { formatError, safeReadJSON, safeWriteJSON } from '../utils/errors';
import { delay } from '../utils/delay';
import {
    updateHealth, recordBanditReward, loadVRState, CommentStyle,
} from '../nurture/vr-scheduler';
import { loadNurtureProfile, saveNurtureProfile, profileExists } from '../nurture/store';
import * as path from 'path';
import * as fs from 'fs';

// ── Types ────────────────────────────────────────────────────────────

export type NotificationType = 'reply' | 'mention' | 'like' | 'retweet' | 'quote' | 'follow' | 'recommended' | 'unknown';

export interface DetectedNotification {
    type: NotificationType;
    fromUsername: string;
    text: string;            // The notification text content
    ourTweetUrl?: string;    // URL of our tweet they interacted with
    theirTweetUrl?: string;  // URL of their reply/quote
    detectedAt: string;
    actioned: boolean;
    actionedAt?: string;
    actionType?: 'replied' | 'liked' | 'ignored';
    actionText?: string;
}

export interface NotificationCheckResult {
    totalChecked: number;
    replies: number;
    mentions: number;
    likes: number;
    retweets: number;
    quotes: number;
    newNotifications: DetectedNotification[];
    healthUpdates: Array<{ username: string; event: string; newHealth: number }>;
}

// ── File persistence ─────────────────────────────────────────────────

const NOTIF_DIR = path.join(process.cwd(), 'logs', 'tracking', 'twitter', 'notifications');
const NOTIF_FILE = path.join(NOTIF_DIR, 'detected.json');
const LAST_CHECK_FILE = path.join(NOTIF_DIR, 'last_check.json');

function ensureDir() {
    if (!fs.existsSync(NOTIF_DIR)) fs.mkdirSync(NOTIF_DIR, { recursive: true });
}

function loadNotifications(): DetectedNotification[] {
    ensureDir();
    return safeReadJSON<DetectedNotification[]>(NOTIF_FILE, [], 'notifications');
}

function saveNotifications(notifs: DetectedNotification[]) {
    ensureDir();
    safeWriteJSON(NOTIF_FILE, notifs, 'notifications');
}

// ── Scrape notifications page ────────────────────────────────────────

/**
 * Navigate to notifications and scrape recent interactions.
 * Detects: replies to our tweets, likes, retweets, quotes, mentions.
 */
export async function checkNotifications(
    page: Page,
    maxToProcess: number = 20,
    scrollPasses: number = 3,
): Promise<NotificationCheckResult> {
    const result: NotificationCheckResult = {
        totalChecked: 0,
        replies: 0,
        mentions: 0,
        likes: 0,
        retweets: 0,
        quotes: 0,
        newNotifications: [],
        healthUpdates: [],
    };

    try {
        // Navigate to notifications
        logger.info('[twitter-notifs] Navigating to notifications...');
        await page.goto('https://x.com/notifications', { waitUntil: 'networkidle2', timeout: 20000 });
        await delay(3000);

        // Dismiss popups
        await page.evaluate(() => {
            const buttons = document.querySelectorAll('button, [role="button"]');
            for (const btn of buttons) {
                const text = (btn.textContent || '').trim().toLowerCase();
                if (['not now', 'maybe later', 'dismiss', 'close'].includes(text)) {
                    (btn as HTMLElement).click();
                    return;
                }
            }
        }).catch(() => {});

        await delay(1500);

        // Switch to "All" tab if we're on "Verified"
        try {
            const tabs = await page.$$('[role="tab"]');
            for (const tab of tabs) {
                const tabText = await page.evaluate(el => el.textContent?.trim() || '', tab);
                if (tabText.toLowerCase() === 'all') {
                    await tab.click();
                    await delay(2000);
                    break;
                }
            }
        } catch (_) { /* tabs might not exist */ }

        // Collect notification items
        const existingNotifs = loadNotifications();
        const existingKeys = new Set(existingNotifs.map(n =>
            `${n.type}_${n.fromUsername}_${n.text.slice(0, 50)}`
        ));

        // Scrape notification cells with scrolling for more results
        const allRawNotifs: Array<{
            text: string;
            links: string[];
            usernames: string[];
            type: string;
        }> = [];
        const seenTexts = new Set<string>();

        for (let pass = 0; pass < scrollPasses; pass++) {
            const rawNotifs = await page.evaluate(() => {
                const items: Array<{
                    text: string;
                    links: string[];
                    usernames: string[];
                    type: string;
                }> = [];

                // Notifications are in article elements or div[data-testid="cellInnerDiv"]
                const cells = document.querySelectorAll(
                    'article[data-testid="tweet"], [data-testid="cellInnerDiv"]'
                );

                for (const cell of cells) {
                    const text = (cell.textContent || '').trim();
                    if (!text) continue;

                    // Extract links
                    const links: string[] = [];
                    const anchors = cell.querySelectorAll('a[href]');
                    for (const a of anchors) {
                        const href = (a as HTMLAnchorElement).getAttribute('href') || '';
                        if (href.match(/\/[^/]+\/status\/\d+/)) {
                            links.push(`https://x.com${href}`);
                        }
                    }

                    // Extract usernames from links
                    const usernames: string[] = [];
                    for (const a of anchors) {
                        const href = (a as HTMLAnchorElement).getAttribute('href') || '';
                        const match = href.match(/^\/([a-zA-Z0-9_]+)$/);
                        if (match && !['home', 'notifications', 'messages', 'explore', 'settings', 'i'].includes(match[1])) {
                            usernames.push(match[1]);
                        }
                    }

                    // Classify notification type
                    const lowerText = text.toLowerCase();
                    let type = 'unknown';
                    if (lowerText.includes('replied') || lowerText.includes('replying to')) type = 'reply';
                    else if (lowerText.includes('mentioned you') || lowerText.includes('mentioned')) type = 'mention';
                    else if (lowerText.includes('liked your') || lowerText.includes('liked a') || /liked \d+ of your/i.test(text)) type = 'like';
                    else if (lowerText.includes('retweeted your') || lowerText.includes('reposted your') || lowerText.includes('reposted')) type = 'retweet';
                    else if (lowerText.includes('quoted your') || lowerText.includes('quote tweeted') || lowerText.includes('quoted')) type = 'quote';
                    else if (lowerText.includes('followed you') || lowerText.includes('followed')) type = 'follow';
                    else if (lowerText.includes('recent post from') || lowerText.includes('there was a login')) type = 'recommended';

                    // Always include — unknowns are logged for discovery
                    items.push({ text: text.slice(0, 500), links, usernames, type });
                }

                return items;
            });

            // Deduplicate across scroll passes
            let newThisPass = 0;
            for (const notif of rawNotifs) {
                const dedupeKey = `${notif.type}_${notif.text.slice(0, 80)}`;
                if (!seenTexts.has(dedupeKey)) {
                    seenTexts.add(dedupeKey);
                    allRawNotifs.push(notif);
                    newThisPass++;
                }
            }

            logger.info(`[twitter-notifs] Scroll pass ${pass + 1}/${scrollPasses}: ${rawNotifs.length} cells, ${newThisPass} new`);

            // Stop scrolling if we have enough or no new items
            if (allRawNotifs.length >= maxToProcess || newThisPass === 0) break;

            // Scroll down for more notifications
            if (pass < scrollPasses - 1) {
                await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
                await delay(2500);
            }
        }

        const rawNotifs = allRawNotifs;
        logger.info(`[twitter-notifs] Found ${rawNotifs.length} total notification items (${scrollPasses} scroll passes)`);

        // Process and deduplicate
        for (const raw of rawNotifs.slice(0, maxToProcess)) {
            const fromUsername = raw.usernames[0] || 'unknown';
            const dedupeKey = `${raw.type}_${fromUsername}_${raw.text.slice(0, 50)}`;

            if (existingKeys.has(dedupeKey)) continue;

            const notif: DetectedNotification = {
                type: raw.type as NotificationType,
                fromUsername,
                text: raw.text,
                ourTweetUrl: raw.links.length > 1 ? raw.links[1] : raw.links[0],
                theirTweetUrl: raw.links[0],
                detectedAt: new Date().toISOString(),
                actioned: false,
            };

            result.newNotifications.push(notif);
            result.totalChecked++;

            // Count by type
            switch (notif.type) {
                case 'reply': result.replies++; break;
                case 'mention': result.mentions++; break;
                case 'like': result.likes++; break;
                case 'retweet': result.retweets++; break;
                case 'quote': result.quotes++; break;
                // follow and unknown are tracked but don't need special counters
            }

            // Update relationship health if the person is in our nurture system
            if (fromUsername !== 'unknown' && profileExists(fromUsername, 'twitter')) {
                let healthEvent: string | null = null;

                switch (notif.type) {
                    case 'reply':
                        healthEvent = 'reply_received';
                        break;
                    case 'like':
                        healthEvent = 'like_received';
                        break;
                    case 'retweet':
                    case 'quote':
                        healthEvent = 'they_engaged_our_content';
                        break;
                }

                if (healthEvent) {
                    const newHealth = updateHealth(
                        fromUsername, 'twitter',
                        healthEvent as any,
                    );
                    result.healthUpdates.push({
                        username: fromUsername,
                        event: healthEvent,
                        newHealth,
                    });

                    // For replies, also reward the bandit
                    if (notif.type === 'reply') {
                        // Try to figure out which comment style was used
                        const vrState = loadVRState(fromUsername, 'twitter');
                        // Reward the most recently pulled arm
                        const lastPulledArm = vrState.commentBandit
                            .filter(a => a.pulls > 0)
                            .sort((a, b) => b.pulls - a.pulls)[0];
                        if (lastPulledArm) {
                            recordBanditReward(fromUsername, 'twitter', lastPulledArm.style, 1.0);
                        }
                    }
                }
            }
        }

        // Save all notifications
        const allNotifs = [...existingNotifs, ...result.newNotifications];
        // Keep last 500
        saveNotifications(allNotifs.slice(-500));

        // Save last check time
        safeWriteJSON(LAST_CHECK_FILE, {
            lastCheck: new Date().toISOString(),
            found: result.totalChecked,
        }, 'notif_last_check');

        logger.info(
            `[twitter-notifs] Check complete: ${result.newNotifications.length} new ` +
            `(${result.replies} replies, ${result.likes} likes, ` +
            `${result.retweets} RTs, ${result.quotes} quotes, ${result.mentions} mentions)`
        );

        if (result.healthUpdates.length > 0) {
            logger.info(
                `[twitter-notifs] Health updates: ${result.healthUpdates.map(h =>
                    `@${h.username} ${h.event}→${h.newHealth.toFixed(2)}`
                ).join(', ')}`
            );
        }

    } catch (e) {
        logger.error(`[twitter-notifs] Notification check failed: ${formatError(e)}`);
    }

    return result;
}

// ── Get unactioned reply notifications ───────────────────────────────

/**
 * Returns reply/mention notifications we haven't responded to yet.
 * Used by the reply-to-reply system.
 */
export function getUnactionedReplies(): DetectedNotification[] {
    const notifs = loadNotifications();
    return notifs.filter(n =>
        !n.actioned &&
        (n.type === 'reply' || n.type === 'mention') &&
        n.fromUsername !== 'unknown'
    );
}

/**
 * Mark a notification as actioned.
 */
export function markNotificationActioned(
    fromUsername: string,
    type: NotificationType,
    actionType: 'replied' | 'liked' | 'ignored',
    actionText?: string,
): void {
    const notifs = loadNotifications();
    const match = notifs.find(n =>
        n.fromUsername === fromUsername &&
        n.type === type &&
        !n.actioned
    );

    if (match) {
        match.actioned = true;
        match.actionedAt = new Date().toISOString();
        match.actionType = actionType;
        match.actionText = actionText;
        saveNotifications(notifs);
    }
}

// ── Process ignored comments (update health for unanswered comments) ──

/**
 * Check which of our nurture comments got no reply after a waiting period.
 * Updates relationship health with 'comment_ignored' delta.
 *
 * Call periodically (e.g., every 6 hours) to detect stale comments.
 */
export function processIgnoredComments(waitHours: number = 24): number {
    const notifs = loadNotifications();
    const now = Date.now();
    const vrStates = fs.readdirSync(
        path.join(process.cwd(), 'logs', 'tracking', 'nurture', 'vr-states')
    ).filter(f => f.startsWith('twitter_') && f.endsWith('.json'));

    let updated = 0;

    for (const file of vrStates) {
        const username = file.replace('twitter_', '').replace('.json', '');
        const state = loadVRState(username, 'twitter');

        if (!state.lastCommentAt) continue;

        const hoursSinceComment = (now - new Date(state.lastCommentAt).getTime()) / (1000 * 60 * 60);
        if (hoursSinceComment < waitHours) continue;

        // Check if we got any notification from them since our comment
        const hasReply = notifs.some(n =>
            n.fromUsername.toLowerCase() === username.toLowerCase() &&
            new Date(n.detectedAt) > new Date(state.lastCommentAt!) &&
            (n.type === 'reply' || n.type === 'like')
        );

        if (!hasReply && state.consecutiveIgnored < 10) {
            // Only penalize once per comment cycle — check if we already penalized
            const lastHealthEntry = state.healthHistory[state.healthHistory.length - 1];
            if (lastHealthEntry && lastHealthEntry.reason === 'comment_ignored') {
                continue; // Already penalized for this cycle
            }

            updateHealth(username, 'twitter', 'comment_ignored');
            updated++;
            logger.info(
                `[twitter-notifs] @${username} — comment ignored after ${waitHours}h, ` +
                `consecutiveIgnored=${state.consecutiveIgnored + 1}`
            );
        }
    }

    if (updated > 0) {
        logger.info(`[twitter-notifs] Updated ${updated} contacts with comment_ignored penalty`);
    }

    return updated;
}

// ── Get notification stats ───────────────────────────────────────────

export function getNotificationStats(): {
    total: number;
    unactioned: number;
    byType: Record<NotificationType, number>;
    lastCheck: string | null;
} {
    const notifs = loadNotifications();
    const lastCheck = safeReadJSON<{ lastCheck: string } | null>(LAST_CHECK_FILE, null, 'notif_last_check');

    const byType: Record<NotificationType, number> = {
        reply: 0, mention: 0, like: 0, retweet: 0, quote: 0, follow: 0, recommended: 0, unknown: 0,
    };
    let unactioned = 0;

    for (const n of notifs) {
        byType[n.type] = (byType[n.type] || 0) + 1;
        if (!n.actioned && (n.type === 'reply' || n.type === 'mention')) {
            unactioned++;
        }
    }

    return {
        total: notifs.length,
        unactioned,
        byType,
        lastCheck: lastCheck?.lastCheck || null,
    };
}
