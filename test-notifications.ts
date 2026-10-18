/**
 * Multi-Platform Notification & Badge Discovery Test
 *
 * Usage:
 *   npx ts-node test-notifications.ts                          # Twitter (default)
 *   npx ts-node test-notifications.ts --platform instagram     # Instagram
 *   npx ts-node test-notifications.ts --platform threads       # Threads
 *   npx ts-node test-notifications.ts --scrolls 10 --max 200   # Deep scroll
 *   npx ts-node test-notifications.ts --badges                 # Badges only
 *   npx ts-node test-notifications.ts --notifications          # Notifications only
 *
 * Read-only — does NOT post, reply, or modify anything.
 * Logs all notification types INCLUDING unknowns for discovery.
 */

import dotenv from 'dotenv';
dotenv.config();

import { Page } from 'puppeteer';
import {
    readTwitterBadges, readInstagramBadges, readThreadsBadges,
    getActionsFromBadges, BadgeSnapshot, PlatformBadges,
} from './src/client/NotificationBadgeReader';
import { checkNotifications, getUnactionedReplies, getNotificationStats } from './src/client/Twitter-Notifications';
import { logger } from './src/utils/logger';
import { delay } from './src/utils/delay';

// ── Arg parsing ─────────────────────────────────────────────────────

const args = process.argv.slice(2);
const hasFlags = args.includes('--badges') || args.includes('--notifications');
const doBadges = args.includes('--badges') || !hasFlags;
const doNotifs = args.includes('--notifications') || !hasFlags;

const platformIdx = args.indexOf('--platform');
const platform = platformIdx !== -1 ? args[platformIdx + 1] || 'twitter' : 'twitter';

const scrollIdx = args.indexOf('--scrolls');
const scrollPasses = scrollIdx !== -1 ? parseInt(args[scrollIdx + 1], 10) || 5 : 5;

const maxIdx = args.indexOf('--max');
const maxNotifs = maxIdx !== -1 ? parseInt(args[maxIdx + 1], 10) || 100 : 100;

// ── Platform-specific browser init ──────────────────────────────────

async function initBrowser(platform: string): Promise<{ page: Page; close: () => Promise<void> }> {
    if (platform === 'instagram') {
        const { InstagramAI } = await import('./src/client/Instagram-AI');
        const ig = new InstagramAI();
        await ig.initialize();
        return { page: ig.getPage()!, close: () => ig.close() };
    }
    // Twitter and Threads both use Twitter browser (Threads requires separate login)
    const { TwitterAI } = await import('./src/client/Twitter-AI');
    const tw = new TwitterAI();
    await tw.initialize();
    return { page: tw.getPage()!, close: () => tw.close() };
}

// ── Generic notification scraper (for Instagram/Threads discovery) ───

async function scrapePageNotifications(page: Page, platform: string, scrollPasses: number, maxItems: number) {
    const allItems: Array<{ text: string; links: string[]; usernames: string[]; type: string }> = [];
    const seenTexts = new Set<string>();

    for (let pass = 0; pass < scrollPasses; pass++) {
        const items = await page.evaluate(() => {
            const results: Array<{ text: string; links: string[]; usernames: string[]; type: string }> = [];

            // Try multiple selectors for notification items
            const selectors = [
                'article', '[role="listitem"]', '[data-testid="cellInnerDiv"]',
                'div[class*="notification"]', 'div[class*="activity"]',
                'section > div > div > div', 'main div[role="button"]',
            ];

            const seen = new Set<string>();
            for (const sel of selectors) {
                const els = document.querySelectorAll(sel);
                for (const el of els) {
                    const text = (el.textContent || '').trim();
                    if (!text || text.length < 10 || text.length > 1000) continue;
                    const key = text.slice(0, 100);
                    if (seen.has(key)) continue;
                    seen.add(key);

                    // Extract links
                    const links: string[] = [];
                    const usernames: string[] = [];
                    const anchors = el.querySelectorAll('a[href]');
                    for (const a of anchors) {
                        const href = (a as HTMLAnchorElement).getAttribute('href') || '';
                        links.push(href);
                        // Try to extract username from profile links
                        const userMatch = href.match(/^\/([a-zA-Z0-9_.]+)\/?$/);
                        if (userMatch && userMatch[1].length > 1 && !['explore', 'reels', 'direct', 'accounts', 'p'].includes(userMatch[1])) {
                            usernames.push(userMatch[1]);
                        }
                    }

                    // Classify
                    const lower = text.toLowerCase();
                    let type = 'unknown';
                    if (lower.includes('replied') || lower.includes('comment')) type = 'reply';
                    else if (lower.includes('mentioned')) type = 'mention';
                    else if (lower.includes('liked') || lower.includes('like')) type = 'like';
                    else if (lower.includes('started following') || lower.includes('followed you') || lower.includes('follow')) type = 'follow';
                    else if (lower.includes('retweet') || lower.includes('repost') || lower.includes('shared')) type = 'retweet';
                    else if (lower.includes('quoted') || lower.includes('quote')) type = 'quote';
                    else if (lower.includes('tagged')) type = 'mention';

                    results.push({ text: text.slice(0, 500), links, usernames, type });
                }
            }
            return results;
        });

        let newThisPass = 0;
        for (const item of items) {
            const key = `${item.type}_${item.text.slice(0, 80)}`;
            if (!seenTexts.has(key)) {
                seenTexts.add(key);
                allItems.push(item);
                newThisPass++;
            }
        }

        console.log(`  Scroll ${pass + 1}/${scrollPasses}: ${items.length} elements, ${newThisPass} new (${allItems.length} total)`);

        if (allItems.length >= maxItems || newThisPass === 0) break;

        if (pass < scrollPasses - 1) {
            await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
            await delay(2500);
        }
    }

    return allItems;
}

// ── Main ────────────────────────────────────────────────────────────

(async () => {
    let closeBrowser: (() => Promise<void>) | null = null;

    try {
        console.log('\n╔═══════════════════════════════════════════════════╗');
        console.log(`║   ${platform.toUpperCase().padEnd(10)} Notification Discovery (read-only)  ║`);
        console.log('╚═══════════════════════════════════════════════════╝\n');

        console.log(`Platform: ${platform} | Scrolls: ${scrollPasses} | Max: ${maxNotifs}\n`);
        console.log('Initializing browser...');
        const { page, close } = await initBrowser(platform);
        closeBrowser = close;

        // ── Badge reading ──────────────────────────────────────────
        if (doBadges) {
            console.log('\n── Badge Reading ──────────────────────────');
            let badges: PlatformBadges;

            if (platform === 'instagram') {
                badges = await readInstagramBadges(page);
            } else if (platform === 'threads') {
                // Navigate to threads first
                await page.goto('https://www.threads.net/', { waitUntil: 'domcontentloaded', timeout: 15000 });
                await delay(3000);
                badges = await readThreadsBadges(page);
            } else {
                badges = await readTwitterBadges(page);
            }

            console.log(`  DMs:           ${badges.dms} (raw: "${badges.rawDms}")`);
            console.log(`  Notifications: ${badges.notifications} (raw: "${badges.rawNotifications}")`);

            const emptyBadges = (p: 'twitter' | 'instagram' | 'threads'): PlatformBadges => ({
                platform: p, dms: 0, notifications: 0, rawDms: '', rawNotifications: '', readAt: badges.readAt,
            });
            const snapshot: BadgeSnapshot = {
                twitter: platform === 'twitter' ? badges : emptyBadges('twitter'),
                instagram: platform === 'instagram' ? badges : emptyBadges('instagram'),
                threads: platform === 'threads' ? badges : emptyBadges('threads'),
                snapshotAt: badges.readAt,
            };
            const actions = getActionsFromBadges(snapshot);
            if (actions.length > 0) {
                console.log('\n  Actions to take:');
                for (const a of actions) {
                    console.log(`    [${a.priority.toUpperCase()}] ${a.platform} ${a.type}: ${a.action} (${a.count})`);
                }
            } else {
                console.log('  No actions needed (all badges zero)');
            }
        }

        // ── Notification check ─────────────────────────────────────
        if (doNotifs) {
            console.log(`\n── Notification Scrape (${scrollPasses} scrolls, max ${maxNotifs}) ──`);

            if (platform === 'twitter') {
                // Use the dedicated Twitter notification checker
                const result = await checkNotifications(page, maxNotifs, scrollPasses);

                console.log(`\n  Total new:  ${result.newNotifications.length}`);
                console.log(`  Replies:    ${result.replies}`);
                console.log(`  Mentions:   ${result.mentions}`);
                console.log(`  Likes:      ${result.likes}`);
                console.log(`  Retweets:   ${result.retweets}`);
                console.log(`  Quotes:     ${result.quotes}`);

                // Group by type for display
                const byType: Record<string, typeof result.newNotifications> = {};
                for (const n of result.newNotifications) {
                    if (!byType[n.type]) byType[n.type] = [];
                    byType[n.type].push(n);
                }

                for (const [type, notifs] of Object.entries(byType)) {
                    console.log(`\n  ── ${type.toUpperCase()} (${notifs.length}) ──`);
                    for (const n of notifs.slice(0, 10)) {
                        const preview = n.text.slice(0, 120).replace(/\n/g, ' ');
                        console.log(`    @${n.fromUsername}: ${preview}`);
                    }
                    if (notifs.length > 10) console.log(`    ... +${notifs.length - 10} more`);
                }

                if (result.healthUpdates.length > 0) {
                    console.log('\n  ── Health Updates ──');
                    for (const h of result.healthUpdates) {
                        console.log(`    @${h.username}: ${h.event} → ${h.newHealth.toFixed(2)}`);
                    }
                }

                // Stats
                console.log('\n── All-Time Stats ─────────────────────────');
                const stats = getNotificationStats();
                console.log(`  Total stored:   ${stats.total}`);
                console.log(`  Unactioned:     ${stats.unactioned}`);
                console.log(`  By type:        reply=${stats.byType.reply} mention=${stats.byType.mention} like=${stats.byType.like} RT=${stats.byType.retweet} quote=${stats.byType.quote} follow=${stats.byType.follow || 0} unknown=${stats.byType.unknown || 0}`);

                const unactioned = getUnactionedReplies();
                if (unactioned.length > 0) {
                    console.log(`\n── Unactioned Replies (${unactioned.length}) ──`);
                    for (const n of unactioned.slice(0, 15)) {
                        const preview = n.text.slice(0, 100).replace(/\n/g, ' ');
                        console.log(`    @${n.fromUsername} [${n.type}]: ${preview}`);
                        if (n.theirTweetUrl) console.log(`      → ${n.theirTweetUrl}`);
                    }
                }

            } else {
                // Instagram / Threads — generic discovery scraper
                let notifUrl: string;
                if (platform === 'instagram') {
                    notifUrl = 'https://www.instagram.com/accounts/activity/';
                } else {
                    notifUrl = 'https://www.threads.net/activity';
                }

                console.log(`  Navigating to ${notifUrl}...`);
                await page.goto(notifUrl, { waitUntil: 'networkidle2', timeout: 20000 });
                await delay(3000);

                const items = await scrapePageNotifications(page, platform, scrollPasses, maxNotifs);

                // Group by type
                const byType: Record<string, typeof items> = {};
                for (const item of items) {
                    if (!byType[item.type]) byType[item.type] = [];
                    byType[item.type].push(item);
                }

                console.log(`\n  Total found: ${items.length}`);
                for (const [type, group] of Object.entries(byType).sort((a, b) => b[1].length - a[1].length)) {
                    console.log(`\n  ── ${type.toUpperCase()} (${group.length}) ──`);
                    for (const item of group.slice(0, 8)) {
                        const preview = item.text.slice(0, 120).replace(/\n/g, ' ');
                        const user = item.usernames[0] || '???';
                        console.log(`    @${user}: ${preview}`);
                    }
                    if (group.length > 8) console.log(`    ... +${group.length - 8} more`);
                }

                // Show full unknown texts for pattern discovery
                const unknowns = byType['unknown'] || [];
                if (unknowns.length > 0) {
                    console.log(`\n  ── UNKNOWN PATTERNS (for discovery) ──`);
                    console.log(`  These ${unknowns.length} items didn't match any known pattern.`);
                    console.log(`  Review to add new detection rules:\n`);
                    for (const u of unknowns.slice(0, 15)) {
                        console.log(`    TEXT: "${u.text.slice(0, 200)}"`);
                        console.log(`    LINKS: ${u.links.slice(0, 3).join(', ') || '(none)'}`);
                        console.log(`    USERS: ${u.usernames.join(', ') || '(none)'}`);
                        console.log('');
                    }
                }
            }
        }

        console.log('\n── Done ───────────────────────────────────');

    } catch (e) {
        console.error('Test failed:', e);
    } finally {
        if (closeBrowser) {
            try { await closeBrowser(); } catch (_) {}
        }
        setTimeout(() => process.exit(0), 2000);
    }
})();
