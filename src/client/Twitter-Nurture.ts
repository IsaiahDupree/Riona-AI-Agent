/**
 * Twitter Nurture Client — Visit contact profiles, find recent posts,
 * and comment strategically using the VR scheduler.
 *
 * This does NOT count toward cold DM limits. It's separate nurture engagement.
 */

import { Page, ElementHandle } from 'puppeteer';
import { logger } from '../utils/logger';
import { formatError } from '../utils/errors';
import { delay } from '../utils/delay';
import dotenv from 'dotenv';
import { chatCompletion } from '../utils/ai';
import {
    extractTweetMetadata, postReply, likeTweet, extractTweetUrl,
    TweetMetadata,
} from './Twitter-Core';
import {
    recordInteractionAndDecide, recordBanditPull, updateHealth,
    loadVRState, saveVRState, getContactsReadyForEngagement,
    CommentStyle, VRDecision,
} from '../nurture/vr-scheduler';
import { loadNurtureProfile, saveNurtureProfile } from '../nurture/store';
import { getTierForMessage } from '../nurture/tiers';
import { getBestInterestForMessage } from '../nurture/interests';
import { hasRepliedToTweet, trackReply, TrackedReply } from '../tracking/twitterTracker';

dotenv.config({ override: true });

// OpenAI replaced by shared Anthropic wrapper (chatCompletion)

// ── Types ────────────────────────────────────────────────────────────

export interface NurtureCommentResult {
    username: string;
    tweetUrl: string;
    tweetText: string;
    commentText: string;
    style: CommentStyle;
    success: boolean;
    error?: string;
}

export interface NurtureRunResult {
    commentsPosted: number;
    contactsVisited: number;
    contactsSkipped: number;
    results: NurtureCommentResult[];
}

// ── Style-specific prompt fragments ──────────────────────────────────

const STYLE_PROMPTS: Record<CommentStyle, string> = {
    short_value: 'Write a SHORT (1-2 sentence) reply that adds a specific insight, data point, or useful perspective. Be concise and punchy.',
    thoughtful_question: 'Ask a GENUINE question about their content that shows you read and understood it. Make them want to answer.',
    humor: 'Write a WITTY reply with light humor. Be clever, not try-hard. Match their energy.',
    contrarian_take: 'Respectfully offer an ALTERNATIVE perspective or gentle pushback. Be thoughtful, not argumentative. Start with acknowledgment.',
    personal_story: 'Share a BRIEF personal anecdote (1-2 sentences) that relates to their post. Be genuine and specific.',
    encouragement: 'Write a SPECIFIC, genuine supportive reply. Reference something concrete in their post. Avoid generic praise.',
    resource_share: 'Briefly mention a relevant resource, tool, article, or concept that adds to their point. Be helpful, not salesy.',
};

// ── Generate nurture comment via AI ──────────────────────────────────

async function generateNurtureComment(
    tweetText: string,
    author: string,
    style: CommentStyle,
    tier: string,
    interestContext?: string,
): Promise<string> {
    const tierHints = getTierForMessage(tier as any);
    const stylePrompt = STYLE_PROMPTS[style];

    const systemPrompt = [
        `You are a knowledgeable person replying to @${author}'s tweet.`,
        tierHints.style,
        tierHints.depthHint,
        interestContext ? `You share interests in: ${interestContext}` : '',
        'Your reply must feel genuine and human. Never be salesy or self-promotional.',
    ].filter(Boolean).join(' ');

    const userPrompt = `Tweet by @${author}: "${tweetText}"

${stylePrompt}

Rules:
1. Max 200 characters (short is better)
2. Sound like a real person, not a bot
3. Do NOT start with "I" if possible
4. Do NOT use hashtags
5. Do NOT mention following, DMs, or your own profile
6. No generic filler ("Great post!", "Love this!", etc.)
7. Maximum 1 emoji (zero is fine)

Reply with ONLY the comment text.`;

    try {
        const content = await chatCompletion({
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
            ],
            max_tokens: 80,
            temperature: 0.85,
        });

        return content?.trim()?.replace(/^["']|["']$/g, '') || '';
    } catch (e) {
        logger.error(`[twitter-nurture] AI generation failed: ${formatError(e)}`);
        return '';
    }
}

// ── Visit a user's profile and get their recent tweets ───────────────

async function getUserRecentTweets(
    page: Page,
    username: string,
    maxTweets: number = 5,
): Promise<Array<{ element: ElementHandle; metadata: TweetMetadata }>> {
    const profileUrl = `https://x.com/${username}`;
    logger.info(`[twitter-nurture] Visiting @${username}'s profile`);

    try {
        await page.goto(profileUrl, { waitUntil: 'networkidle2', timeout: 20000 });
        await delay(2000 + Math.random() * 2000);

        // Dismiss any popups
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

        await delay(1000);

        // Wait for tweets to load
        await page.waitForSelector('article[data-testid="tweet"]', { timeout: 10000 }).catch(() => null);

        // Get tweet elements
        const tweetElements = await page.$$('article[data-testid="tweet"]');
        const results: Array<{ element: ElementHandle; metadata: TweetMetadata }> = [];

        for (const tweet of tweetElements.slice(0, maxTweets)) {
            try {
                const meta = await extractTweetMetadata(tweet, page);
                if (!meta.success || !meta.text || meta.isRetweet) continue;

                // Skip our own tweets
                const botUsername = (process.env.TWITTER_BOT_USERNAME || '').toLowerCase();
                if (meta.username.toLowerCase() === botUsername) continue;

                // Skip if we've already replied
                if (meta.tweetUrl && hasRepliedToTweet(meta.tweetUrl)) continue;

                results.push({ element: tweet, metadata: meta });
            } catch (_) {
                // Skip problematic tweets
            }
        }

        logger.info(`[twitter-nurture] Found ${results.length} engageable tweets from @${username}`);
        return results;
    } catch (e) {
        logger.error(`[twitter-nurture] Failed to load @${username}'s profile: ${formatError(e)}`);
        return [];
    }
}

// ── Comment on a single tweet ────────────────────────────────────────

async function commentOnTweet(
    page: Page,
    tweet: ElementHandle,
    metadata: TweetMetadata,
    style: CommentStyle,
    username: string,
): Promise<NurtureCommentResult> {
    const profile = loadNurtureProfile(username, 'twitter');
    const interestMatch = getBestInterestForMessage(username, 'twitter');

    const comment = await generateNurtureComment(
        metadata.text,
        username,
        style,
        profile.tier,
        interestMatch?.context,
    );

    if (!comment) {
        return {
            username,
            tweetUrl: metadata.tweetUrl || '',
            tweetText: metadata.text,
            commentText: '',
            style,
            success: false,
            error: 'AI generation returned empty',
        };
    }

    // Validate comment
    if (comment.length < 5 || comment.length > 280) {
        return {
            username,
            tweetUrl: metadata.tweetUrl || '',
            tweetText: metadata.text,
            commentText: comment,
            style,
            success: false,
            error: `Comment length invalid: ${comment.length}`,
        };
    }

    logger.info(`[twitter-nurture] Posting ${style} comment on @${username}'s tweet: "${comment.slice(0, 60)}..."`);

    // Post the reply
    const result = await postReply(tweet, page, comment);

    if (result.success) {
        // Track the reply
        const tracked: TrackedReply = {
            tweetUrl: metadata.tweetUrl || '',
            tweetAuthor: username,
            replyText: comment,
            timestamp: new Date().toISOString(),
            verified: true,
            sessionId: `nurture_${Date.now()}`,
            tweetSnippet: metadata.text.slice(0, 100),
            liked: false,
            retweeted: false,
        };
        trackReply(tracked);

        // Record the bandit pull
        recordBanditPull(username, 'twitter', style);

        // Also like the tweet for added engagement
        try {
            await likeTweet(tweet, page);
            tracked.liked = true;
        } catch (_) { /* not critical */ }

        // Update nurture profile
        profile.lastCheckIn = new Date().toISOString();
        profile.depth.exchangeCount++;
        saveNurtureProfile(profile);

        logger.info(`[twitter-nurture] Successfully commented on @${username}'s tweet (${style})`);
    }

    return {
        username,
        tweetUrl: metadata.tweetUrl || '',
        tweetText: metadata.text,
        commentText: comment,
        style,
        success: result.success,
        error: result.error,
    };
}

// ── Main nurture engagement run ──────────────────────────────────────

/**
 * Visit contacts' profiles and comment using VR schedule.
 * Does NOT count toward cold DM limits.
 *
 * @param page - Puppeteer page (already logged in)
 * @param maxContacts - Max contacts to visit this run
 * @param maxCommentsTotal - Max total comments across all contacts
 */
export async function runNurtureEngagement(
    page: Page,
    maxContacts: number = 3,
    maxCommentsTotal: number = 5,
): Promise<NurtureRunResult> {
    const result: NurtureRunResult = {
        commentsPosted: 0,
        contactsVisited: 0,
        contactsSkipped: 0,
        results: [],
    };

    // Get contacts whose VR counter is near threshold
    const readyContacts = getContactsReadyForEngagement('twitter', maxContacts + 3);

    if (readyContacts.length === 0) {
        logger.info('[twitter-nurture] No contacts ready for engagement');
        return result;
    }

    logger.info(`[twitter-nurture] ${readyContacts.length} contacts near VR threshold, visiting up to ${maxContacts}`);

    for (const contact of readyContacts) {
        if (result.commentsPosted >= maxCommentsTotal) {
            logger.info(`[twitter-nurture] Hit comment cap (${maxCommentsTotal})`);
            break;
        }
        if (result.contactsVisited >= maxContacts) break;

        // Make the VR decision
        const decision = recordInteractionAndDecide(contact.username, 'twitter');

        if (!decision.shouldEngage) {
            logger.info(`[twitter-nurture] Skip @${contact.username}: ${decision.reason}`);
            result.contactsSkipped++;
            continue;
        }

        result.contactsVisited++;
        const style = decision.style!;

        // Visit their profile and get recent tweets
        const tweets = await getUserRecentTweets(page, contact.username, 5);
        if (tweets.length === 0) {
            logger.info(`[twitter-nurture] No engageable tweets from @${contact.username}`);
            continue;
        }

        // Pick a tweet to comment on (prefer higher engagement tweets)
        const sorted = [...tweets].sort((a, b) => {
            const scoreA = (a.metadata.likes || 0) + (a.metadata.retweets || 0) * 2;
            const scoreB = (b.metadata.likes || 0) + (b.metadata.retweets || 0) * 2;
            return scoreB - scoreA;
        });
        const target = sorted[0];

        const commentResult = await commentOnTweet(
            page, target.element, target.metadata, style, contact.username,
        );
        result.results.push(commentResult);

        if (commentResult.success) {
            result.commentsPosted++;
        }

        // Human-like delay between visiting different profiles
        await delay(3000 + Math.random() * 4000);
    }

    logger.info(
        `[twitter-nurture] Nurture run complete: ${result.commentsPosted} comments on ` +
        `${result.contactsVisited} profiles (${result.contactsSkipped} skipped)`
    );

    return result;
}

// ── Seed a contact into the VR system ────────────────────────────────

/**
 * Add a contact to the VR nurture system. Call this when someone
 * becomes a nurture target (e.g., after DM exchange, after follow, etc.)
 */
export function seedNurtureContact(username: string): void {
    // Loading the VR state creates it if it doesn't exist
    const state = loadVRState(username, 'twitter');
    // Also ensure they have a nurture profile
    loadNurtureProfile(username, 'twitter');
    logger.info(`[twitter-nurture] Seeded @${username} into VR nurture system (health=${state.health.toFixed(2)})`);
}

// ── Manually trigger engagement for a specific contact ───────────────

/**
 * Force a nurture comment on a specific contact (bypasses VR schedule).
 * Useful for "react to content" check-in type.
 */
export async function forceNurtureComment(
    page: Page,
    username: string,
    style?: CommentStyle,
): Promise<NurtureCommentResult | null> {
    const tweets = await getUserRecentTweets(page, username, 5);
    if (tweets.length === 0) return null;

    const target = tweets[0];
    const effectiveStyle = style || 'encouragement';

    return commentOnTweet(page, target.element, target.metadata, effectiveStyle, username);
}
