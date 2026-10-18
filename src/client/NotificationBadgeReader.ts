/**
 * Cross-Platform Notification Badge Reader
 *
 * Reads notification/DM badge counts from Twitter, Instagram, and Threads
 * using known XPath selectors. Uses these counts to decide what needs
 * attention and triggers the appropriate action handlers.
 */

import { Page } from 'puppeteer';
import { logger } from '../utils/logger';
import { formatError, safeReadJSON, safeWriteJSON } from '../utils/errors';
import { delay } from '../utils/delay';
import * as path from 'path';

// ── Types ────────────────────────────────────────────────────────────

export type Platform = 'twitter' | 'instagram' | 'threads';

export interface BadgeCount {
    platform: Platform;
    type: 'dm' | 'notification';
    count: number;          // Parsed integer (0 if no badge / couldn't read)
    rawText: string;        // Raw text from badge (e.g., "9+", "14")
    readAt: string;         // ISO timestamp
}

export interface PlatformBadges {
    platform: Platform;
    dms: number;
    notifications: number;
    rawDms: string;
    rawNotifications: string;
    readAt: string;
}

export interface BadgeSnapshot {
    twitter: PlatformBadges;
    instagram: PlatformBadges;
    threads: PlatformBadges;
    snapshotAt: string;
}

// ── XPath Selectors ──────────────────────────────────────────────────
// These are the known XPaths for notification badges on each platform.
// They may break if the platform updates its DOM — update here if so.

const SELECTORS = {
    twitter: {
        // Left nav bar, 3rd link (Messages) → badge span
        dmBadge: '/html/body/div[1]/div/div/div[2]/header/div/div/div/div[1]/div[2]/nav/a[3]/div/div[2]/span[1]',
        // Notifications tab badge — try aria-label and data-testid first
        notifBadge: null as string | null, // We'll use alternative selectors
        // Fallback CSS selectors for notification count
        notifCssSelectors: [
            'a[href="/notifications"] span[data-testid="annotationCount"]',
            'a[href="/notifications"] div[class*="badge"]',
            'nav a[aria-label*="notification" i] span',
        ],
        dmCssSelectors: [
            'a[href="/messages"] span[data-testid="annotationCount"]',
            'a[href="/messages"] div[class*="badge"]',
        ],
    },
    instagram: {
        // Left nav, notification count
        notifBadge: '/html/body/div[1]/div/div/div[2]/div/div/div[1]/div[1]/div[1]/div/div/div/div/div/div[2]/div/div[6]/div/span',
        // Left nav, DM/Messages badge
        dmBadge: '/html/body/div[1]/div/div/div[2]/div/div/div[1]/div[2]/div[1]/div/div/div/div/div/div[2]/div/div[3]/div/div/span/div/a/div/div[1]/div/div[2]',
        notifCssSelectors: [
            'span[aria-label*="Activity"]',
            'a[href*="/activity"] span',
        ],
        dmCssSelectors: [
            'a[href="/direct/inbox/"] span',
            'span[aria-label*="unread"]',
        ],
    },
    threads: {
        // Left nav container for notifications
        navContainer: '/html/body/div[2]/div/div/div[2]/div[1]/div[2]/',
        notifBadge: null as string | null,
        dmBadge: null as string | null,
        notifCssSelectors: [
            'div[role="navigation"] a[href*="activity"] span',
            'a[href*="activity"] div[class*="badge"]',
        ],
        dmCssSelectors: [] as string[],
    },
};

// ── Persistence ──────────────────────────────────────────────────────

const BADGE_HISTORY_FILE = path.join(process.cwd(), 'logs', 'tracking', 'badge_snapshots.json');

function loadBadgeHistory(): BadgeSnapshot[] {
    return safeReadJSON<BadgeSnapshot[]>(BADGE_HISTORY_FILE, [], 'badge_history');
}

function saveBadgeSnapshot(snapshot: BadgeSnapshot): void {
    const history = loadBadgeHistory();
    history.push(snapshot);
    // Keep last 200 snapshots
    const trimmed = history.slice(-200);
    safeWriteJSON(BADGE_HISTORY_FILE, trimmed, 'badge_history');
}

// ── Parse badge text to number ───────────────────────────────────────

function parseBadgeCount(text: string): number {
    if (!text) return 0;
    const cleaned = text.trim().replace(/[+,]/g, '').replace(/\s/g, '');
    const num = parseInt(cleaned, 10);
    return isNaN(num) ? 0 : num;
}

// ── Read a single badge via XPath ────────────────────────────────────

async function readBadgeByXPath(page: Page, xpath: string): Promise<string> {
    try {
        const elements = await page.$$(`xpath/${xpath}`);
        if (elements.length > 0) {
            const text = await page.evaluate(el => {
                return (el as HTMLElement).textContent?.trim() || '';
            }, elements[0]);
            return text;
        }
    } catch (e) {
        logger.debug(`[badge-reader] XPath read failed: ${formatError(e)}`);
    }
    return '';
}

// ── Read a badge via CSS selectors (fallback) ────────────────────────

async function readBadgeByCss(page: Page, selectors: string[]): Promise<string> {
    for (const selector of selectors) {
        try {
            const el = await page.$(selector);
            if (el) {
                const text = await page.evaluate(e => {
                    return (e as HTMLElement).textContent?.trim() || '';
                }, el);
                if (text) return text;
            }
        } catch (_) { /* try next selector */ }
    }
    return '';
}

// ── Platform-specific readers ────────────────────────────────────────

/**
 * Read Twitter/X notification and DM badge counts.
 * Page should be on x.com (any page — badges are in the nav).
 */
export async function readTwitterBadges(page: Page): Promise<PlatformBadges> {
    const now = new Date().toISOString();

    // Read DM badge
    let rawDms = await readBadgeByXPath(page, SELECTORS.twitter.dmBadge);
    if (!rawDms) {
        rawDms = await readBadgeByCss(page, SELECTORS.twitter.dmCssSelectors);
    }

    // Read notification badge
    let rawNotifs = '';
    if (SELECTORS.twitter.notifBadge) {
        rawNotifs = await readBadgeByXPath(page, SELECTORS.twitter.notifBadge);
    }
    if (!rawNotifs) {
        rawNotifs = await readBadgeByCss(page, SELECTORS.twitter.notifCssSelectors);
    }

    // Also try reading from aria-labels on nav links
    if (!rawDms || !rawNotifs) {
        try {
            const navData = await page.evaluate(() => {
                const links = document.querySelectorAll('nav a[href]');
                let dms = '';
                let notifs = '';
                for (const link of links) {
                    const href = (link as HTMLAnchorElement).getAttribute('href') || '';
                    const ariaLabel = link.getAttribute('aria-label') || '';
                    // DMs: "14 unread items. Messages"
                    if (href === '/messages' && ariaLabel) {
                        const match = ariaLabel.match(/(\d+)\s*unread/i);
                        if (match) dms = match[1];
                    }
                    // Notifications: "3 unread items. Notifications"
                    if (href === '/notifications' && ariaLabel) {
                        const match = ariaLabel.match(/(\d+)\s*unread/i);
                        if (match) notifs = match[1];
                    }
                }
                return { dms, notifs };
            });
            if (!rawDms && navData.dms) rawDms = navData.dms;
            if (!rawNotifs && navData.notifs) rawNotifs = navData.notifs;
        } catch (_) { /* non-fatal */ }
    }

    const result: PlatformBadges = {
        platform: 'twitter',
        dms: parseBadgeCount(rawDms),
        notifications: parseBadgeCount(rawNotifs),
        rawDms,
        rawNotifications: rawNotifs,
        readAt: now,
    };

    logger.info(`[badge-reader] Twitter: ${result.dms} DMs, ${result.notifications} notifications`);
    return result;
}

/**
 * Read Instagram notification and DM badge counts.
 * Page should be on instagram.com (any page — badges are in the nav).
 */
export async function readInstagramBadges(page: Page): Promise<PlatformBadges> {
    const now = new Date().toISOString();

    // Read notification badge
    let rawNotifs = await readBadgeByXPath(page, SELECTORS.instagram.notifBadge);
    if (!rawNotifs) {
        rawNotifs = await readBadgeByCss(page, SELECTORS.instagram.notifCssSelectors);
    }

    // Read DM badge
    let rawDms = await readBadgeByXPath(page, SELECTORS.instagram.dmBadge);
    if (!rawDms) {
        rawDms = await readBadgeByCss(page, SELECTORS.instagram.dmCssSelectors);
    }

    const result: PlatformBadges = {
        platform: 'instagram',
        dms: parseBadgeCount(rawDms),
        notifications: parseBadgeCount(rawNotifs),
        rawDms,
        rawNotifications: rawNotifs,
        readAt: now,
    };

    logger.info(`[badge-reader] Instagram: ${result.dms} DMs, ${result.notifications} notifications`);
    return result;
}

/**
 * Read Threads notification badge count.
 * Page should be on threads.net.
 */
export async function readThreadsBadges(page: Page): Promise<PlatformBadges> {
    const now = new Date().toISOString();

    let rawNotifs = '';
    if (SELECTORS.threads.notifBadge) {
        rawNotifs = await readBadgeByXPath(page, SELECTORS.threads.notifBadge);
    }
    if (!rawNotifs) {
        rawNotifs = await readBadgeByCss(page, SELECTORS.threads.notifCssSelectors);
    }

    // Also scan the nav container for any badge-like elements
    if (!rawNotifs) {
        try {
            rawNotifs = await page.evaluate(() => {
                const nav = document.querySelector('div[role="navigation"]');
                if (!nav) return '';
                const spans = nav.querySelectorAll('span');
                for (const span of spans) {
                    const text = span.textContent?.trim() || '';
                    if (/^\d+\+?$/.test(text)) return text;
                }
                // Check for badge dots (no count, just presence)
                const badges = nav.querySelectorAll('[class*="badge"], [class*="Badge"], [class*="dot"]');
                if (badges.length > 0) return '1'; // At least 1 notification
                return '';
            });
        } catch (_) { /* non-fatal */ }
    }

    const result: PlatformBadges = {
        platform: 'threads',
        dms: 0, // Threads DMs go through Instagram
        notifications: parseBadgeCount(rawNotifs),
        rawDms: '',
        rawNotifications: rawNotifs,
        readAt: now,
    };

    logger.info(`[badge-reader] Threads: ${result.notifications} notifications`);
    return result;
}

// ── Full snapshot across all platforms ────────────────────────────────

/**
 * Read badge counts from a page that's currently on the given platform.
 * Call this when the browser is already on x.com, instagram.com, or threads.net.
 */
export async function readCurrentPageBadges(page: Page): Promise<PlatformBadges | null> {
    try {
        const url = page.url();

        if (url.includes('x.com') || url.includes('twitter.com')) {
            return await readTwitterBadges(page);
        }
        if (url.includes('instagram.com')) {
            return await readInstagramBadges(page);
        }
        if (url.includes('threads.net')) {
            return await readThreadsBadges(page);
        }

        logger.debug(`[badge-reader] Unknown platform for URL: ${url}`);
        return null;
    } catch (e) {
        logger.warn(`[badge-reader] Failed to read badges: ${formatError(e)}`);
        return null;
    }
}

/**
 * Navigate to each platform and collect all badge counts.
 * Only use this if you have a dedicated page for badge checking.
 */
export async function readAllPlatformBadges(page: Page): Promise<BadgeSnapshot> {
    const now = new Date().toISOString();
    const emptyBadges = (p: Platform): PlatformBadges => ({
        platform: p, dms: 0, notifications: 0,
        rawDms: '', rawNotifications: '', readAt: now,
    });

    let twitter = emptyBadges('twitter');
    let instagram = emptyBadges('instagram');
    let threads = emptyBadges('threads');

    // Twitter
    try {
        await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 15000 });
        await delay(3000);
        twitter = await readTwitterBadges(page);
    } catch (e) {
        logger.warn(`[badge-reader] Twitter badge read failed: ${formatError(e)}`);
    }

    // Instagram
    try {
        await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 15000 });
        await delay(3000);
        instagram = await readInstagramBadges(page);
    } catch (e) {
        logger.warn(`[badge-reader] Instagram badge read failed: ${formatError(e)}`);
    }

    // Threads
    try {
        await page.goto('https://www.threads.net/', { waitUntil: 'domcontentloaded', timeout: 15000 });
        await delay(3000);
        threads = await readThreadsBadges(page);
    } catch (e) {
        logger.warn(`[badge-reader] Threads badge read failed: ${formatError(e)}`);
    }

    const snapshot: BadgeSnapshot = { twitter, instagram, threads, snapshotAt: now };
    saveBadgeSnapshot(snapshot);

    logger.info(
        `[badge-reader] Snapshot: Twitter(${twitter.dms}DM/${twitter.notifications}notif) ` +
        `Instagram(${instagram.dms}DM/${instagram.notifications}notif) ` +
        `Threads(${threads.notifications}notif)`
    );

    return snapshot;
}

// ── Action triggers based on badge counts ────────────────────────────

export interface BadgeAction {
    platform: Platform;
    type: 'dm' | 'notification';
    count: number;
    action: string;
    priority: 'high' | 'medium' | 'low';
}

/**
 * Analyze badge counts and return prioritized actions to take.
 */
export function getActionsFromBadges(snapshot: BadgeSnapshot): BadgeAction[] {
    const actions: BadgeAction[] = [];

    // Twitter DMs — high priority (someone replied)
    if (snapshot.twitter.dms > 0) {
        actions.push({
            platform: 'twitter',
            type: 'dm',
            count: snapshot.twitter.dms,
            action: 'scrape_inbox_and_reply',
            priority: 'high',
        });
    }

    // Twitter notifications — medium priority
    if (snapshot.twitter.notifications > 0) {
        actions.push({
            platform: 'twitter',
            type: 'notification',
            count: snapshot.twitter.notifications,
            action: 'check_notifications',
            priority: 'medium',
        });
    }

    // Instagram DMs — high priority
    if (snapshot.instagram.dms > 0) {
        actions.push({
            platform: 'instagram',
            type: 'dm',
            count: snapshot.instagram.dms,
            action: 'scrape_ig_inbox_and_reply',
            priority: 'high',
        });
    }

    // Instagram notifications — medium priority
    if (snapshot.instagram.notifications > 0) {
        actions.push({
            platform: 'instagram',
            type: 'notification',
            count: snapshot.instagram.notifications,
            action: 'check_ig_notifications',
            priority: 'medium',
        });
    }

    // Threads notifications — low priority
    if (snapshot.threads.notifications > 0) {
        actions.push({
            platform: 'threads',
            type: 'notification',
            count: snapshot.threads.notifications,
            action: 'check_threads_notifications',
            priority: 'low',
        });
    }

    // Sort: high > medium > low, then by count descending
    const priorityOrder = { high: 0, medium: 1, low: 2 };
    actions.sort((a, b) => {
        const pDiff = priorityOrder[a.priority] - priorityOrder[b.priority];
        if (pDiff !== 0) return pDiff;
        return b.count - a.count;
    });

    return actions;
}

// ── Get latest snapshot ──────────────────────────────────────────────

export function getLatestBadgeSnapshot(): BadgeSnapshot | null {
    const history = loadBadgeHistory();
    return history.length > 0 ? history[history.length - 1] : null;
}

/**
 * Get trend: are notifications going up or down?
 */
export function getBadgeTrend(platform: Platform, type: 'dm' | 'notification', lookback: number = 5): {
    current: number;
    previous: number;
    direction: 'up' | 'down' | 'stable';
} {
    const history = loadBadgeHistory();
    if (history.length < 2) return { current: 0, previous: 0, direction: 'stable' };

    const recent = history.slice(-lookback);
    const current = type === 'dm'
        ? recent[recent.length - 1][platform].dms
        : recent[recent.length - 1][platform].notifications;
    const previous = type === 'dm'
        ? recent[0][platform].dms
        : recent[0][platform].notifications;

    return {
        current,
        previous,
        direction: current > previous ? 'up' : current < previous ? 'down' : 'stable',
    };
}
