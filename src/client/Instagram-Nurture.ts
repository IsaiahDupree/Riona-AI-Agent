/**
 * Instagram Nurture Client — Visit contact profiles, find recent posts,
 * and comment strategically using the VR scheduler.
 *
 * Mirrors Twitter-Nurture.ts architecture. Does NOT count toward cold DM limits.
 */

import { Page, ElementHandle } from 'puppeteer';
import { logger } from '../utils/logger';
import { formatError } from '../utils/errors';
import { delay } from '../utils/delay';
import dotenv from 'dotenv';
import { chatCompletion } from '../utils/ai';
import { postComment } from './Instagram-Core';
import {
    recordInteractionAndDecide, recordBanditPull, updateHealth,
    loadVRState, saveVRState, getContactsReadyForEngagement,
    CommentStyle, VRDecision,
} from '../nurture/vr-scheduler';
import { loadNurtureProfile, saveNurtureProfile } from '../nurture/store';
import { getTierForMessage } from '../nurture/tiers';
import { getBestInterestForMessage } from '../nurture/interests';
import { hasCommentedOnPost, trackComment, TrackedComment } from '../tracking/commentTracker';

dotenv.config();

// OpenAI replaced by shared Anthropic wrapper (chatCompletion)

// ── Types ────────────────────────────────────────────────────────────

export interface IGNurtureCommentResult {
    username: string;
    postUrl: string;
    caption: string;
    commentText: string;
    style: CommentStyle;
    success: boolean;
    error?: string;
}

export interface IGNurtureRunResult {
    commentsPosted: number;
    contactsVisited: number;
    contactsSkipped: number;
    results: IGNurtureCommentResult[];
}

// ── Style-specific prompts (adapted for Instagram) ───────────────────

const STYLE_PROMPTS: Record<CommentStyle, string> = {
    short_value: 'Write a SHORT (1-2 sentence) comment that adds a specific insight or useful perspective on their post.',
    thoughtful_question: 'Ask a GENUINE question about their post that shows you engaged with the content. Make them want to reply.',
    humor: 'Write a WITTY comment with light humor relevant to their post. Be clever, not forced.',
    contrarian_take: 'Offer a respectful ALTERNATIVE perspective. Be thoughtful, not argumentative. Acknowledge their point first.',
    personal_story: 'Share a BRIEF personal anecdote (1-2 sentences) that relates to their post. Be authentic.',
    encouragement: 'Write a SPECIFIC, genuine supportive comment. Reference something concrete in their post. No generic praise.',
    resource_share: 'Briefly mention a relevant tool, concept, or idea that adds to their post. Be helpful, not promotional.',
};

// ── Generate nurture comment ─────────────────────────────────────────

async function generateIGNurtureComment(
    caption: string,
    author: string,
    style: CommentStyle,
    tier: string,
    interestContext?: string,
): Promise<string> {
    const tierHints = getTierForMessage(tier as any);
    const stylePrompt = STYLE_PROMPTS[style];

    const systemPrompt = [
        `You are commenting on @${author}'s Instagram post.`,
        tierHints.style,
        tierHints.depthHint,
        interestContext ? `You share interests in: ${interestContext}` : '',
        'Your comment must feel genuine. Never be salesy or self-promotional.',
    ].filter(Boolean).join(' ');

    const userPrompt = `Post caption by @${author}: "${caption.slice(0, 500)}"

${stylePrompt}

Rules:
1. Max 150 characters (Instagram comments should be concise)
2. Sound like a real person
3. Do NOT use hashtags in the comment
4. Do NOT ask them to follow you or check your profile
5. No generic filler ("Amazing!", "Love this!", "Fire!", etc.)
6. Maximum 1 emoji (zero is fine)

Reply with ONLY the comment text.`;

    try {
        const content = await chatCompletion({
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
            ],
            max_tokens: 60,
            temperature: 0.85,
        });

        return content?.trim()?.replace(/^["']|["']$/g, '') || '';
    } catch (e) {
        logger.error(`[ig-nurture] AI generation failed: ${formatError(e)}`);
        return '';
    }
}

// ── Visit user profile and get their recent posts ────────────────────

async function getIGUserRecentPosts(
    page: Page,
    username: string,
    maxPosts: number = 3,
): Promise<Array<{ element: ElementHandle; caption: string; postUrl: string }>> {
    const profileUrl = `https://www.instagram.com/${username}/`;
    logger.info(`[ig-nurture] Visiting @${username}'s profile`);

    try {
        await page.goto(profileUrl, { waitUntil: 'networkidle2', timeout: 20000 });
        await delay(2000 + Math.random() * 2000);

        // Dismiss popups
        await page.evaluate(() => {
            const buttons = document.querySelectorAll('button');
            for (const btn of buttons) {
                const text = (btn.textContent || '').trim().toLowerCase();
                if (['not now', 'maybe later', 'dismiss', 'close'].includes(text)) {
                    btn.click();
                    return;
                }
            }
        }).catch(() => {});

        await delay(1000);

        // Check if profile exists / is accessible
        const isPrivate = await page.evaluate(() => {
            const text = document.body.textContent || '';
            return text.includes('This account is private') || text.includes('This Account is Private');
        });
        if (isPrivate) {
            logger.info(`[ig-nurture] @${username} is private, skipping`);
            return [];
        }

        // Get post links from the profile grid
        const postLinks = await page.evaluate((max) => {
            const links = document.querySelectorAll('a[href*="/p/"]');
            const urls: string[] = [];
            for (const link of links) {
                const href = (link as HTMLAnchorElement).getAttribute('href');
                if (href && !urls.includes(href)) {
                    urls.push(href);
                    if (urls.length >= max) break;
                }
            }
            return urls;
        }, maxPosts);

        if (postLinks.length === 0) {
            logger.info(`[ig-nurture] No posts found for @${username}`);
            return [];
        }

        // Visit each post and extract caption + element
        const results: Array<{ element: ElementHandle; caption: string; postUrl: string }> = [];

        for (const postHref of postLinks.slice(0, maxPosts)) {
            const postUrl = postHref.startsWith('http') ? postHref : `https://www.instagram.com${postHref}`;

            // Skip if we've already commented
            if (hasCommentedOnPost(postUrl)) continue;

            try {
                await page.goto(postUrl, { waitUntil: 'networkidle2', timeout: 15000 });
                await delay(1500);

                // Extract caption
                const caption = await page.evaluate(() => {
                    // Instagram post caption is typically in a span or div
                    const captionEl = document.querySelector('h1') ||
                        document.querySelector('div[class*="Caption"] span') ||
                        document.querySelector('article span[dir="auto"]');
                    return captionEl?.textContent?.trim() || '';
                });

                if (!caption) continue;

                // Get the article element for postComment
                const article = await page.$('article');
                if (!article) continue;

                results.push({ element: article, caption, postUrl });
            } catch (_) {
                // Skip problematic posts
            }
        }

        logger.info(`[ig-nurture] Found ${results.length} engageable posts from @${username}`);
        return results;
    } catch (e) {
        logger.error(`[ig-nurture] Failed to load @${username}'s profile: ${formatError(e)}`);
        return [];
    }
}

// ── Comment on a single post ─────────────────────────────────────────

async function commentOnPost(
    page: Page,
    post: ElementHandle,
    caption: string,
    postUrl: string,
    style: CommentStyle,
    username: string,
): Promise<IGNurtureCommentResult> {
    const profile = loadNurtureProfile(username, 'instagram');
    const interestMatch = getBestInterestForMessage(username, 'instagram');

    const comment = await generateIGNurtureComment(
        caption, username, style, profile.tier, interestMatch?.context,
    );

    if (!comment || comment.length < 3 || comment.length > 300) {
        return {
            username, postUrl, caption,
            commentText: comment || '',
            style, success: false,
            error: `Comment invalid: ${comment ? `length ${comment.length}` : 'empty'}`,
        };
    }

    logger.info(`[ig-nurture] Posting ${style} comment on @${username}'s post: "${comment.slice(0, 50)}..."`);

    const result = await postComment(post, page, comment);

    if (result.success) {
        // Track the comment
        const tracked: TrackedComment = {
            postUrl,
            postUsername: username,
            commentText: comment,
            timestamp: new Date().toISOString(),
            verified: true,
            sessionId: `ig_nurture_${Date.now()}`,
            captionSnippet: caption.slice(0, 100),
            liked: false,
        };
        trackComment(tracked);

        recordBanditPull(username, 'instagram', style);

        // Update nurture profile
        profile.lastCheckIn = new Date().toISOString();
        profile.depth.exchangeCount++;
        saveNurtureProfile(profile);

        logger.info(`[ig-nurture] Successfully commented on @${username}'s post (${style})`);
    }

    return {
        username, postUrl, caption,
        commentText: comment, style,
        success: result.success,
        error: result.error,
    };
}

// ── Main nurture engagement run ──────────────────────────────────────

/**
 * Visit contacts' profiles and comment using VR schedule.
 * Does NOT count toward cold DM limits.
 */
export async function runIGNurtureEngagement(
    page: Page,
    maxContacts: number = 3,
    maxCommentsTotal: number = 3,
): Promise<IGNurtureRunResult> {
    const result: IGNurtureRunResult = {
        commentsPosted: 0,
        contactsVisited: 0,
        contactsSkipped: 0,
        results: [],
    };

    const readyContacts = getContactsReadyForEngagement('instagram', maxContacts + 3);

    if (readyContacts.length === 0) {
        logger.info('[ig-nurture] No Instagram contacts ready for engagement');
        return result;
    }

    logger.info(`[ig-nurture] ${readyContacts.length} contacts near VR threshold`);

    for (const contact of readyContacts) {
        if (result.commentsPosted >= maxCommentsTotal) break;
        if (result.contactsVisited >= maxContacts) break;

        const decision = recordInteractionAndDecide(contact.username, 'instagram');

        if (!decision.shouldEngage) {
            logger.info(`[ig-nurture] Skip @${contact.username}: ${decision.reason}`);
            result.contactsSkipped++;
            continue;
        }

        result.contactsVisited++;
        const style = decision.style!;

        const posts = await getIGUserRecentPosts(page, contact.username, 3);
        if (posts.length === 0) continue;

        const target = posts[0]; // Most recent

        const commentResult = await commentOnPost(
            page, target.element, target.caption, target.postUrl, style, contact.username,
        );
        result.results.push(commentResult);

        if (commentResult.success) {
            result.commentsPosted++;
        }

        await delay(4000 + Math.random() * 5000);
    }

    logger.info(
        `[ig-nurture] Run complete: ${result.commentsPosted} comments on ` +
        `${result.contactsVisited} profiles`
    );

    return result;
}

// ── Seed IG contact into VR system ───────────────────────────────────

export function seedIGNurtureContact(username: string): void {
    loadVRState(username, 'instagram');
    loadNurtureProfile(username, 'instagram');
    logger.info(`[ig-nurture] Seeded @${username} into Instagram VR nurture system`);
}
