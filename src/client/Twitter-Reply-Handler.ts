/**
 * Twitter Reply-to-Reply Handler
 *
 * Processes unactioned reply notifications by:
 * 1. Navigating to the reply tweet URL
 * 2. Reading the reply context (their reply + our original tweet)
 * 3. Generating a contextual response using AI + brand voice
 * 4. Posting the reply
 * 5. Tracking and marking as actioned
 *
 * Does NOT count toward cold DM/reply limits — these are relationship responses.
 */

import { Page } from 'puppeteer';
import OpenAI from 'openai';
import dotenv from 'dotenv';
import { logger } from '../utils/logger';
import { formatError, withRetry } from '../utils/errors';
import { delay } from '../utils/delay';
import {
    getUnactionedReplies, markNotificationActioned,
    DetectedNotification,
} from './Twitter-Notifications';
import { trackReply, hasRepliedToTweet, recentReplyToUser } from '../tracking/twitterTracker';
import { updateHealth, loadVRState, recordBanditReward } from '../nurture/vr-scheduler';
import { profileExists } from '../nurture/store';
import { getBrandPromptContext } from '../strategy/twitter-brand';

dotenv.config();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || '' });

// ── Config ──────────────────────────────────────────────────────────

const MAX_REPLIES_PER_RUN = 5;
const MIN_HOURS_BETWEEN_REPLIES_SAME_USER = 1;
const REPLY_COOLDOWN_MS = 30000; // 30s between replies to avoid rate limits

// ── Types ───────────────────────────────────────────────────────────

export interface ReplyToReplyResult {
    processed: number;
    replied: number;
    liked: number;
    skipped: number;
    failed: number;
    details: Array<{
        username: string;
        action: 'replied' | 'liked' | 'skipped' | 'failed';
        reason?: string;
        replyText?: string;
    }>;
}

interface TweetContext {
    theirReplyText: string;
    ourOriginalText: string;
    theirUsername: string;
    conversationThread: string[];
}

// ── AI reply generation (context-aware) ─────────────────────────────

async function generateReplyToReply(
    theirReply: string,
    theirUsername: string,
    ourOriginal: string,
    brandContext: string,
): Promise<string> {
    const prompt = `Someone replied to your tweet on Twitter. Generate a natural, conversational response.

YOUR ORIGINAL TWEET/REPLY:
"${ourOriginal}"

THEIR REPLY (@${theirUsername}):
"${theirReply}"

Rules:
1. Keep it under 200 characters — short and conversational
2. Sound natural — like a real person continuing a conversation
3. Acknowledge what they said specifically — don't be generic
4. Add value: share a quick insight, agree with substance, or ask a follow-up
5. Match their energy/tone (if casual, be casual; if technical, be technical)
6. Do NOT use generic responses like "Thanks!", "Great point!", "Appreciate it!"
7. Do NOT pitch products, ask for follows, or promote anything
8. Maximum 1 emoji (prefer none)
9. Do NOT start with "I" if possible
10. Do NOT use hashtags

Reply only with the response text, nothing else.`;

    const reply = await withRetry(
        async () => {
            const completion = await openai.chat.completions.create({
                model: 'gpt-4o-mini',
                messages: [
                    {
                        role: 'system',
                        content: `You are responding to replies on Twitter. ${brandContext} Be genuine, conversational, and brief. You're continuing a real conversation, not generating content.`,
                    },
                    { role: 'user', content: prompt },
                ],
                max_tokens: 80,
                temperature: 0.85,
            });
            const content = completion.choices[0]?.message?.content?.trim();
            if (!content) throw new Error('OpenAI returned empty reply');
            return content;
        },
        { maxRetries: 2, baseDelay: 1000, label: 'reply-to-reply-generation' },
    );

    // Clean up: remove quotes if AI wrapped it
    return reply.replace(/^["']|["']$/g, '').trim();
}

// ── Extract context from a tweet page ───────────────────────────────

async function extractTweetContext(page: Page, notification: DetectedNotification): Promise<TweetContext | null> {
    try {
        const targetUrl = notification.theirTweetUrl || notification.ourTweetUrl;
        if (!targetUrl) return null;

        await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 20000 });
        await delay(3000);

        const context = await page.evaluate((username: string) => {
            const articles = document.querySelectorAll('article[data-testid="tweet"]');
            let theirReplyText = '';
            let ourOriginalText = '';
            const thread: string[] = [];

            for (const article of articles) {
                const text = (article.textContent || '').trim();
                const links = article.querySelectorAll('a[href]');
                let tweetAuthor = '';

                for (const link of links) {
                    const href = (link as HTMLAnchorElement).getAttribute('href') || '';
                    const match = href.match(/^\/([a-zA-Z0-9_]+)$/);
                    if (match && !['home', 'notifications', 'messages', 'explore', 'settings', 'i'].includes(match[1])) {
                        tweetAuthor = match[1];
                        break;
                    }
                }

                // Extract just the tweet text (skip metadata)
                const tweetTextEl = article.querySelector('div[data-testid="tweetText"]');
                const cleanText = tweetTextEl ? (tweetTextEl.textContent || '').trim() : text.slice(0, 300);

                if (tweetAuthor.toLowerCase() === username.toLowerCase()) {
                    theirReplyText = cleanText;
                } else {
                    // Assume other tweets in thread are ours or context
                    ourOriginalText = ourOriginalText || cleanText;
                }
                thread.push(`@${tweetAuthor}: ${cleanText.slice(0, 150)}`);
            }

            return { theirReplyText, ourOriginalText, thread };
        }, notification.fromUsername);

        return {
            theirReplyText: context.theirReplyText || notification.text.slice(0, 300),
            ourOriginalText: context.ourOriginalText || '',
            theirUsername: notification.fromUsername,
            conversationThread: context.thread,
        };
    } catch (e) {
        logger.warn(`[reply-handler] Failed to extract context: ${formatError(e)}`);
        // Fallback: use notification text
        return {
            theirReplyText: notification.text.slice(0, 300),
            ourOriginalText: '',
            theirUsername: notification.fromUsername,
            conversationThread: [],
        };
    }
}

// ── Post reply to a specific tweet ──────────────────────────────────

async function postReplyToTweet(page: Page, replyText: string): Promise<{ success: boolean; error?: string }> {
    try {
        // We should be on the tweet page already — find the reply compose area
        // Click the reply button on the tweet we want to reply to
        const replyButton = await page.$('button[data-testid="reply"]');
        if (!replyButton) {
            // Try the inline reply box (sometimes present on tweet detail pages)
            const inlineReply = await page.$('div[data-testid="tweetTextarea_0"]');
            if (!inlineReply) {
                return { success: false, error: 'No reply button or textarea found' };
            }
            await inlineReply.click();
            await delay(500);
            await page.keyboard.type(replyText, { delay: Math.floor(Math.random() * 40) + 20 });
        } else {
            await replyButton.click();
            await delay(2000);

            // Wait for compose area
            const textarea = await page.waitForSelector(
                'div[data-testid="tweetTextarea_0"]',
                { timeout: 8000 },
            ).catch(() => null);

            if (!textarea) {
                const fallback = await page.$('div[role="textbox"][contenteditable="true"]');
                if (!fallback) return { success: false, error: 'Reply compose area not found' };
                await fallback.click();
                await delay(500);
                await page.keyboard.type(replyText, { delay: Math.floor(Math.random() * 40) + 20 });
            } else {
                await textarea.click();
                await delay(500);
                await page.keyboard.type(replyText, { delay: Math.floor(Math.random() * 40) + 20 });
            }
        }

        await delay(1000);

        // Click send
        const sendButton = await page.$('button[data-testid="tweetButton"]');
        if (!sendButton) {
            return { success: false, error: 'Send button not found' };
        }

        await sendButton.click();
        await delay(3000);

        // Verify: compose area should be gone
        const stillOpen = await page.$('div[data-testid="tweetTextarea_0"]');
        if (stillOpen) {
            const text = await page.evaluate(el => (el as HTMLElement).textContent?.trim() || '', stillOpen);
            if (text.length > 0) {
                return { success: false, error: 'Reply may not have been sent — compose area still has text' };
            }
        }

        return { success: true };
    } catch (e) {
        return { success: false, error: formatError(e) };
    }
}

// ── Main: process unactioned replies ────────────────────────────────

/**
 * Process unactioned reply notifications.
 *
 * For each reply:
 * 1. Navigate to the tweet
 * 2. Read context (their reply + our original)
 * 3. Generate a response
 * 4. Post the reply
 * 5. Track and mark actioned
 *
 * @param page - Puppeteer page (should be logged into Twitter)
 * @param maxReplies - Max replies to post this run (default 5)
 */
export async function processReplyNotifications(
    page: Page,
    maxReplies: number = MAX_REPLIES_PER_RUN,
): Promise<ReplyToReplyResult> {
    const result: ReplyToReplyResult = {
        processed: 0,
        replied: 0,
        liked: 0,
        skipped: 0,
        failed: 0,
        details: [],
    };

    const unactioned = getUnactionedReplies();
    if (unactioned.length === 0) {
        logger.info('[reply-handler] No unactioned replies to process');
        return result;
    }

    logger.info(`[reply-handler] Processing ${unactioned.length} unactioned replies (max ${maxReplies})`);
    const brandContext = getBrandPromptContext();
    let repliesSent = 0;

    for (const notif of unactioned) {
        if (repliesSent >= maxReplies) break;
        result.processed++;

        const { fromUsername } = notif;

        // Skip if we recently replied to this user
        const recentReply = recentReplyToUser(fromUsername, MIN_HOURS_BETWEEN_REPLIES_SAME_USER);
        if (recentReply) {
            logger.info(`[reply-handler] Skipping @${fromUsername} — replied recently`);
            result.skipped++;
            result.details.push({ username: fromUsername, action: 'skipped', reason: 'replied_recently' });
            continue;
        }

        // Skip if we already replied to this specific tweet
        if (notif.theirTweetUrl && hasRepliedToTweet(notif.theirTweetUrl)) {
            logger.info(`[reply-handler] Skipping @${fromUsername} — already replied to this tweet`);
            markNotificationActioned(fromUsername, notif.type, 'ignored', 'already_replied');
            result.skipped++;
            result.details.push({ username: fromUsername, action: 'skipped', reason: 'already_replied_to_tweet' });
            continue;
        }

        try {
            // 1. Navigate and extract context
            const context = await extractTweetContext(page, notif);
            if (!context || !context.theirReplyText) {
                logger.warn(`[reply-handler] No context for @${fromUsername}, skipping`);
                result.skipped++;
                result.details.push({ username: fromUsername, action: 'skipped', reason: 'no_context' });
                continue;
            }

            // 2. Generate reply
            const replyText = await generateReplyToReply(
                context.theirReplyText,
                context.theirUsername,
                context.ourOriginalText,
                brandContext,
            );

            if (!replyText || replyText.length < 5) {
                logger.warn(`[reply-handler] Generated reply too short for @${fromUsername}`);
                result.failed++;
                result.details.push({ username: fromUsername, action: 'failed', reason: 'generation_failed' });
                continue;
            }

            logger.info(`[reply-handler] Generated reply to @${fromUsername}: "${replyText.slice(0, 60)}..."`);

            // 3. Post the reply
            const postResult = await postReplyToTweet(page, replyText);

            if (postResult.success) {
                repliesSent++;
                result.replied++;

                // 4. Track the reply
                trackReply({
                    tweetUrl: notif.theirTweetUrl || notif.ourTweetUrl || '',
                    tweetAuthor: fromUsername,
                    replyText,
                    timestamp: new Date().toISOString(),
                    verified: true,
                    sessionId: 'reply-handler',
                    tweetSnippet: context.theirReplyText.slice(0, 50),
                    liked: false,
                    retweeted: false,
                });

                // 5. Mark notification as actioned
                markNotificationActioned(fromUsername, notif.type, 'replied', replyText);

                // 6. Update VR health if contact is in nurture system
                if (profileExists(fromUsername, 'twitter')) {
                    updateHealth(fromUsername, 'twitter', 'we_replied');
                    // Reward the last bandit arm used (they engaged)
                    const vrState = loadVRState(fromUsername, 'twitter');
                    const lastArm = vrState.commentBandit
                        .filter(a => a.pulls > 0)
                        .sort((a, b) => b.pulls - a.pulls)[0];
                    if (lastArm) {
                        recordBanditReward(fromUsername, 'twitter', lastArm.style, 0.5);
                    }
                }

                result.details.push({
                    username: fromUsername,
                    action: 'replied',
                    replyText,
                });

                logger.info(`[reply-handler] Successfully replied to @${fromUsername}`);

                // Cooldown between replies
                if (repliesSent < maxReplies) {
                    await delay(REPLY_COOLDOWN_MS);
                }
            } else {
                result.failed++;
                result.details.push({
                    username: fromUsername,
                    action: 'failed',
                    reason: postResult.error,
                });
                logger.warn(`[reply-handler] Failed to reply to @${fromUsername}: ${postResult.error}`);
            }
        } catch (e) {
            result.failed++;
            result.details.push({
                username: fromUsername,
                action: 'failed',
                reason: formatError(e),
            });
            logger.error(`[reply-handler] Error processing @${fromUsername}: ${formatError(e)}`);
        }
    }

    logger.info(
        `[reply-handler] Complete: ${result.replied} replied, ${result.liked} liked, ` +
        `${result.skipped} skipped, ${result.failed} failed (of ${result.processed} processed)`,
    );

    return result;
}
