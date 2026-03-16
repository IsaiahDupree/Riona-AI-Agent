/**
 * Instagram Notifications Checker & Reply Handler
 *
 * Scrapes Instagram activity page for replies to our comments,
 * generates contextual responses, and posts them.
 * Mirrors the Twitter-Notifications + Twitter-Reply-Handler pattern.
 */

import { Page } from 'puppeteer';
import OpenAI from 'openai';
import dotenv from 'dotenv';
import { logger } from '../utils/logger';
import { formatError, withRetry, safeReadJSON, safeWriteJSON } from '../utils/errors';
import { delay } from '../utils/delay';
import { updateHealth, loadVRState, recordBanditReward } from '../nurture/vr-scheduler';
import { profileExists } from '../nurture/store';
import { getBrandPromptContext } from '../strategy/twitter-brand';
import { hasCommentedOnPost, recentCommentOnUser, trackComment } from '../tracking/commentTracker';
import * as path from 'path';
import * as fs from 'fs';

dotenv.config();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || '' });

// ── Types ────────────────────────────────────────────────────────────

export type IGNotificationType = 'reply' | 'mention' | 'like' | 'follow' | 'tag' | 'unknown';

export interface IGDetectedNotification {
    type: IGNotificationType;
    fromUsername: string;
    text: string;
    postUrl?: string;         // URL of the post where the interaction happened
    detectedAt: string;
    actioned: boolean;
    actionedAt?: string;
    actionType?: 'replied' | 'liked' | 'ignored';
    actionText?: string;
}

export interface IGNotificationCheckResult {
    totalChecked: number;
    replies: number;
    mentions: number;
    likes: number;
    follows: number;
    tags: number;
    newNotifications: IGDetectedNotification[];
    healthUpdates: Array<{ username: string; event: string; newHealth: number }>;
}

export interface IGReplyResult {
    processed: number;
    replied: number;
    skipped: number;
    failed: number;
    details: Array<{
        username: string;
        action: 'replied' | 'skipped' | 'failed';
        reason?: string;
        replyText?: string;
    }>;
}

// ── File persistence ─────────────────────────────────────────────────

const NOTIF_DIR = path.join(process.cwd(), 'logs', 'tracking', 'instagram', 'notifications');
const NOTIF_FILE = path.join(NOTIF_DIR, 'detected.json');
const LAST_CHECK_FILE = path.join(NOTIF_DIR, 'last_check.json');

function ensureDir() {
    if (!fs.existsSync(NOTIF_DIR)) fs.mkdirSync(NOTIF_DIR, { recursive: true });
}

function loadNotifications(): IGDetectedNotification[] {
    ensureDir();
    return safeReadJSON<IGDetectedNotification[]>(NOTIF_FILE, [], 'ig_notifications');
}

function saveNotifications(notifs: IGDetectedNotification[]) {
    ensureDir();
    safeWriteJSON(NOTIF_FILE, notifs, 'ig_notifications');
}

// ── Scrape Instagram activity page ──────────────────────────────────

export async function checkIGNotifications(
    page: Page,
    maxToProcess: number = 30,
    scrollPasses: number = 5,
): Promise<IGNotificationCheckResult> {
    const result: IGNotificationCheckResult = {
        totalChecked: 0,
        replies: 0,
        mentions: 0,
        likes: 0,
        follows: 0,
        tags: 0,
        newNotifications: [],
        healthUpdates: [],
    };

    try {
        logger.info('[ig-notifs] Navigating to activity page...');
        await page.goto('https://www.instagram.com/accounts/activity/', {
            waitUntil: 'networkidle2', timeout: 20000,
        });
        await delay(3000);

        const existingNotifs = loadNotifications();
        const existingKeys = new Set(existingNotifs.map(n =>
            `${n.type}_${n.fromUsername}_${n.text.slice(0, 50)}`
        ));

        const allItems: Array<{
            text: string; usernames: string[]; links: string[]; type: string;
        }> = [];
        const seenTexts = new Set<string>();

        for (let pass = 0; pass < scrollPasses; pass++) {
            const items = await page.evaluate(() => {
                const results: Array<{
                    text: string; usernames: string[]; links: string[]; type: string;
                }> = [];
                const seen = new Set<string>();

                // Instagram activity items appear in various containers
                const selectors = [
                    'article', '[role="listitem"]', 'section > div > div > div',
                    'div[class*="notification"]', 'div[class*="activity"]',
                    'main div > div > div > div',
                ];

                for (const sel of selectors) {
                    const els = document.querySelectorAll(sel);
                    for (const el of els) {
                        const text = (el.textContent || '').trim();
                        if (!text || text.length < 10 || text.length > 800) continue;
                        const key = text.slice(0, 80);
                        if (seen.has(key)) continue;
                        seen.add(key);

                        const links: string[] = [];
                        const usernames: string[] = [];
                        const anchors = el.querySelectorAll('a[href]');
                        for (const a of anchors) {
                            const href = (a as HTMLAnchorElement).getAttribute('href') || '';
                            links.push(href);
                            const userMatch = href.match(/^\/([a-zA-Z0-9_.]+)\/?$/);
                            if (userMatch && !['explore', 'reels', 'direct', 'accounts', 'p', 'stories'].includes(userMatch[1])) {
                                usernames.push(userMatch[1]);
                            }
                        }

                        const lower = text.toLowerCase();
                        let type = 'unknown';
                        if (lower.includes('commented') || lower.includes('replied') || lower.includes('replying')) type = 'reply';
                        else if (lower.includes('mentioned you') || lower.includes('mentioned')) type = 'mention';
                        else if (lower.includes('liked your') || lower.includes('liked a') || /liked \d+/.test(text)) type = 'like';
                        else if (lower.includes('started following') || lower.includes('followed')) type = 'follow';
                        else if (lower.includes('tagged you') || lower.includes('tagged')) type = 'tag';

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

            logger.info(`[ig-notifs] Scroll ${pass + 1}/${scrollPasses}: ${items.length} elements, ${newThisPass} new`);
            if (allItems.length >= maxToProcess || newThisPass === 0) break;

            if (pass < scrollPasses - 1) {
                await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
                await delay(2500);
            }
        }

        // Process and deduplicate against stored notifications
        for (const raw of allItems.slice(0, maxToProcess)) {
            const fromUsername = raw.usernames[0] || 'unknown';
            const dedupeKey = `${raw.type}_${fromUsername}_${raw.text.slice(0, 50)}`;
            if (existingKeys.has(dedupeKey)) continue;

            const rawPostUrl = raw.links.find(l => l.includes('/p/') || l.includes('/reel/'));
            // Ensure absolute URL (scraper may return relative paths like /p/ABC123/)
            const postUrl = rawPostUrl
                ? (rawPostUrl.startsWith('http') ? rawPostUrl : `https://www.instagram.com${rawPostUrl}`)
                : undefined;

            const notif: IGDetectedNotification = {
                type: raw.type as IGNotificationType,
                fromUsername,
                text: raw.text,
                postUrl,
                detectedAt: new Date().toISOString(),
                actioned: false,
            };

            result.newNotifications.push(notif);
            result.totalChecked++;

            switch (notif.type) {
                case 'reply': result.replies++; break;
                case 'mention': result.mentions++; break;
                case 'like': result.likes++; break;
                case 'follow': result.follows++; break;
                case 'tag': result.tags++; break;
            }

            // Update VR health for known contacts
            if (fromUsername !== 'unknown' && profileExists(fromUsername, 'instagram')) {
                let healthEvent: string | null = null;
                switch (notif.type) {
                    case 'reply': healthEvent = 'reply_received'; break;
                    case 'like': healthEvent = 'like_received'; break;
                    case 'mention':
                    case 'tag': healthEvent = 'they_engaged_our_content'; break;
                }
                if (healthEvent) {
                    const newHealth = updateHealth(fromUsername, 'instagram', healthEvent as any);
                    result.healthUpdates.push({ username: fromUsername, event: healthEvent, newHealth });

                    if (notif.type === 'reply') {
                        const vrState = loadVRState(fromUsername, 'instagram');
                        const lastArm = vrState.commentBandit
                            .filter(a => a.pulls > 0)
                            .sort((a, b) => b.pulls - a.pulls)[0];
                        if (lastArm) {
                            recordBanditReward(fromUsername, 'instagram', lastArm.style, 1.0);
                        }
                    }
                }
            }
        }

        // Save all
        const allNotifs = [...existingNotifs, ...result.newNotifications];
        saveNotifications(allNotifs.slice(-500));

        safeWriteJSON(LAST_CHECK_FILE, {
            lastCheck: new Date().toISOString(),
            found: result.totalChecked,
        }, 'ig_notif_last_check');

        logger.info(
            `[ig-notifs] Check complete: ${result.newNotifications.length} new ` +
            `(${result.replies} replies, ${result.likes} likes, ${result.follows} follows, ${result.mentions} mentions)`,
        );

    } catch (e) {
        logger.error(`[ig-notifs] Notification check failed: ${formatError(e)}`);
    }

    return result;
}

// ── Get unactioned reply notifications ───────────────────────────────

export function getIGUnactionedReplies(): IGDetectedNotification[] {
    const notifs = loadNotifications();
    return notifs.filter(n =>
        !n.actioned &&
        (n.type === 'reply' || n.type === 'mention') &&
        n.fromUsername !== 'unknown'
    );
}

export function markIGNotificationActioned(
    fromUsername: string,
    type: IGNotificationType,
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

// ── AI reply generation ─────────────────────────────────────────────

async function generateIGReply(
    theirComment: string,
    theirUsername: string,
    brandContext: string,
): Promise<string> {
    const prompt = `Someone replied to your Instagram comment. Generate a natural response.

THEIR REPLY (@${theirUsername}):
"${theirComment}"

Rules:
1. Keep it under 150 characters — Instagram comments should be short
2. Sound natural — casual Instagram voice
3. Acknowledge what they said — don't be generic
4. Do NOT use generic responses like "Thanks!", "Love this!", "So true!"
5. Do NOT pitch, ask for follows, or self-promote
6. Maximum 1-2 emojis (Instagram allows a bit more than Twitter)
7. Keep it conversational — like texting a friend

Reply only with the comment text, nothing else.`;

    const reply = await withRetry(
        async () => {
            const completion = await openai.chat.completions.create({
                model: 'gpt-4o-mini',
                messages: [
                    {
                        role: 'system',
                        content: `You are replying to an Instagram comment. ${brandContext} Be genuine and brief.`,
                    },
                    { role: 'user', content: prompt },
                ],
                max_tokens: 60,
                temperature: 0.85,
            });
            const content = completion.choices[0]?.message?.content?.trim();
            if (!content) throw new Error('Empty reply');
            return content;
        },
        { maxRetries: 2, baseDelay: 1000, label: 'ig-reply-generation' },
    );

    return reply.replace(/^["']|["']$/g, '').trim();
}

// ── Post reply on Instagram ─────────────────────────────────────────

async function postIGReply(page: Page, postUrl: string, replyText: string): Promise<{ success: boolean; error?: string }> {
    try {
        // Ensure absolute URL
        const fullUrl = postUrl.startsWith('http') ? postUrl : `https://www.instagram.com${postUrl}`;
        // Navigate to the post
        await page.goto(fullUrl, { waitUntil: 'networkidle2', timeout: 20000 });
        await delay(3000);

        // Find comment box
        const commentSelectors = [
            'textarea[aria-label="Add a comment…"]',
            'textarea[aria-label="Add a comment\u2026"]',
            'textarea[placeholder*="comment"]',
            'form textarea',
        ];

        let commentBox = null;
        for (const sel of commentSelectors) {
            commentBox = await page.$(sel);
            if (commentBox) break;
        }

        if (!commentBox) {
            // Try clicking the comment icon first
            const commentIcon = await page.$('svg[aria-label="Comment"]')
                || await page.$('[aria-label="Comment"]');
            if (commentIcon) {
                await commentIcon.click();
                await delay(2000);
                for (const sel of commentSelectors) {
                    commentBox = await page.$(sel);
                    if (commentBox) break;
                }
            }
        }

        if (!commentBox) {
            return { success: false, error: 'Comment box not found' };
        }

        await commentBox.click();
        await delay(500);
        await page.keyboard.type(replyText, { delay: Math.floor(Math.random() * 30) + 15 });
        await delay(1000);

        // Find and click post button by text
        const posted = await page.evaluate(() => {
            const buttons = document.querySelectorAll('button, div[role="button"]');
            for (const btn of buttons) {
                const text = (btn.textContent || '').trim().toLowerCase();
                if (text === 'post' || text === 'reply') {
                    (btn as HTMLElement).click();
                    return true;
                }
            }
            return false;
        });

        if (!posted) {
            // Try submitting with Enter
            await page.keyboard.press('Enter');
        }

        await delay(3000);
        return { success: true };
    } catch (e) {
        return { success: false, error: formatError(e) };
    }
}

// ── Main: process IG unactioned replies ──────────────────────────────

export async function processIGReplyNotifications(
    page: Page,
    maxReplies: number = 5,
): Promise<IGReplyResult> {
    const result: IGReplyResult = {
        processed: 0,
        replied: 0,
        skipped: 0,
        failed: 0,
        details: [],
    };

    const unactioned = getIGUnactionedReplies();
    if (unactioned.length === 0) {
        logger.info('[ig-reply-handler] No unactioned replies');
        return result;
    }

    logger.info(`[ig-reply-handler] Processing ${unactioned.length} unactioned replies (max ${maxReplies})`);
    const brandContext = getBrandPromptContext();
    let repliesSent = 0;

    for (const notif of unactioned) {
        if (repliesSent >= maxReplies) break;
        result.processed++;

        const { fromUsername } = notif;

        // Skip if recently replied
        const recent = recentCommentOnUser(fromUsername, 1);
        if (recent) {
            result.skipped++;
            result.details.push({ username: fromUsername, action: 'skipped', reason: 'replied_recently' });
            continue;
        }

        // Need a post URL to reply on
        if (!notif.postUrl) {
            markIGNotificationActioned(fromUsername, notif.type, 'ignored', 'no_post_url');
            result.skipped++;
            result.details.push({ username: fromUsername, action: 'skipped', reason: 'no_post_url' });
            continue;
        }

        try {
            // Generate reply
            const replyText = await generateIGReply(
                notif.text.slice(0, 300),
                fromUsername,
                brandContext,
            );

            if (!replyText || replyText.length < 3) {
                result.failed++;
                result.details.push({ username: fromUsername, action: 'failed', reason: 'generation_failed' });
                continue;
            }

            logger.info(`[ig-reply-handler] Generated reply to @${fromUsername}: "${replyText.slice(0, 60)}"`);

            // Post reply
            const postResult = await postIGReply(page, notif.postUrl, replyText);

            if (postResult.success) {
                repliesSent++;
                result.replied++;

                // Track
                trackComment({
                    postUrl: notif.postUrl,
                    postUsername: fromUsername,
                    commentText: replyText,
                    timestamp: new Date().toISOString(),
                    verified: true,
                    sessionId: 'ig-reply-handler',
                    captionSnippet: notif.text.slice(0, 100),
                    liked: false,
                });

                markIGNotificationActioned(fromUsername, notif.type, 'replied', replyText);

                // Update VR health
                if (profileExists(fromUsername, 'instagram')) {
                    updateHealth(fromUsername, 'instagram', 'we_replied');
                }

                result.details.push({ username: fromUsername, action: 'replied', replyText });
                logger.info(`[ig-reply-handler] Replied to @${fromUsername}`);

                if (repliesSent < maxReplies) await delay(30000);
            } else {
                result.failed++;
                result.details.push({ username: fromUsername, action: 'failed', reason: postResult.error });
                logger.warn(`[ig-reply-handler] Failed: ${postResult.error}`);
            }
        } catch (e) {
            result.failed++;
            result.details.push({ username: fromUsername, action: 'failed', reason: formatError(e) });
            logger.error(`[ig-reply-handler] Error: ${formatError(e)}`);
        }
    }

    logger.info(`[ig-reply-handler] Complete: ${result.replied} replied, ${result.skipped} skipped, ${result.failed} failed`);
    return result;
}

// ── Stats ───────────────────────────────────────────────────────────

export function getIGNotificationStats(): {
    total: number;
    unactioned: number;
    byType: Record<IGNotificationType, number>;
    lastCheck: string | null;
} {
    const notifs = loadNotifications();
    const lastCheck = safeReadJSON<{ lastCheck: string } | null>(LAST_CHECK_FILE, null, 'ig_notif_last_check');

    const byType: Record<IGNotificationType, number> = {
        reply: 0, mention: 0, like: 0, follow: 0, tag: 0, unknown: 0,
    };
    let unactioned = 0;

    for (const n of notifs) {
        byType[n.type] = (byType[n.type] || 0) + 1;
        if (!n.actioned && (n.type === 'reply' || n.type === 'mention')) unactioned++;
    }

    return { total: notifs.length, unactioned, byType, lastCheck: lastCheck?.lastCheck || null };
}
