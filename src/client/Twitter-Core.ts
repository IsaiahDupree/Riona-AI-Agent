// Twitter/X Core — tweet interaction functions (reply, like, retweet, metadata extraction)
import { ElementHandle, Page } from 'puppeteer';
import { logger } from '../utils/logger';
import { formatError, withRetry, classifyError, sanitizeForPrompt } from '../utils/errors';
import { delay } from '../utils/delay';
import { chatCompletion } from '../utils/ai';
import dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';

// Load environment variables
dotenv.config();

// ── Interfaces ───────────────────────────────────────────────────────

export interface TweetMetadata {
    type: 'tweet';
    username: string;
    displayName: string;
    text: string;
    isRetweet: boolean;
    hasMedia: boolean;
    hashtags: string[];
    mentions: string[];
    likes: number;
    retweets: number;
    replies: number;
    timestamp: Date;
    tweetUrl: string | null;
    success: boolean;
    error?: string;
}

export interface ReplyGuidelines {
    minLength: number;
    maxLength: number;
    maxEmojis: number;
    forbiddenPhrases: string[];
    mustAddValue: boolean;
}

interface ProcessTweetResult {
    success: boolean;
    error?: string;
    details?: string;
    metadata?: TweetMetadata;
    skipped?: boolean;
}

// ── Defaults ─────────────────────────────────────────────────────────

const DEFAULT_REPLY_GUIDELINES: ReplyGuidelines = {
    minLength: 10,
    maxLength: 280,
    maxEmojis: 3,
    forbiddenPhrases: [
        'follow me', 'follow back', 'check my profile', 'check my bio',
        'link in bio', 'dm me', 'sub for sub', 'f4f', 'l4l',
        'great post', 'nice post', 'awesome post', 'love this post'
    ],
    mustAddValue: true
};

// ── Helpers ──────────────────────────────────────────────────────────

function getRandomDelay(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Safely type text into a contenteditable element with front-truncation protection.
 *
 * Twitter's contenteditable divs often swallow the first few keystrokes
 * because the placeholder handler hasn't finished clearing by the time
 * keyboard.type() fires. This function:
 *  1. Clicks the element to focus it
 *  2. Sends a throwaway space + backspace to "wake up" the input handler
 *  3. Types the actual text
 *  4. Verifies the text wasn't truncated at the front
 *  5. Retries once if truncation is detected
 */
export async function safeType(
    page: Page,
    element: ElementHandle<Element>,
    text: string,
    options?: { charDelay?: number; label?: string }
): Promise<{ success: boolean; truncated: boolean }> {
    const charDelay = options?.charDelay ?? getRandomDelay(20, 50);
    const label = options?.label ?? 'safeType';

    // Step 1: Focus the element
    await element.click();
    await delay(300);

    // Step 2: "Wake up" the input handler with a throwaway keystroke
    // This clears the placeholder and ensures the input is ready for real text
    await page.keyboard.press('Space');
    await delay(100);
    await page.keyboard.press('Backspace');
    await delay(300);

    // Step 3: Type the actual text
    await page.keyboard.type(text, { delay: charDelay });
    await delay(800);

    // Step 4: Verify the text wasn't truncated at the front
    const typedContent = await element.evaluate(
        (el: Element) => {
            if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) return el.value;
            return (el as HTMLElement).innerText || el.textContent || '';
        }
    );
    const typedTrimmed = typedContent.trim();
    const expectedStart = text.slice(0, 20);

    if (typedTrimmed.length === 0) {
        // Text went somewhere else entirely (search box?) — retry with extra focus
        logger.warn(`[${label}] Typed text not found in element — refocusing and retrying`);
        await page.keyboard.press('Escape');
        await delay(300);
        await element.click();
        await delay(500);
        await element.click();
        await delay(300);
        await page.keyboard.press('Space');
        await delay(100);
        await page.keyboard.press('Backspace');
        await delay(300);
        await page.keyboard.type(text, { delay: charDelay + 10 });
        await delay(800);
        return { success: true, truncated: false }; // Best-effort
    }

    if (!typedTrimmed.startsWith(expectedStart)) {
        // Front truncation detected — clear and retype
        logger.warn(`[${label}] Front truncation detected: expected "${expectedStart}..." but got "${typedTrimmed.slice(0, 25)}...". Retrying.`);

        // Select all and delete
        await page.keyboard.down('Control');
        await page.keyboard.press('a');
        await page.keyboard.up('Control');
        await delay(200);
        await page.keyboard.press('Backspace');
        await delay(500);

        // Re-focus and retype with slightly slower delay
        await element.click();
        await delay(500);
        await page.keyboard.press('Space');
        await delay(100);
        await page.keyboard.press('Backspace');
        await delay(400);
        await page.keyboard.type(text, { delay: charDelay + 15 });
        await delay(800);

        // Second verification
        const retryContent = await element.evaluate(
            (el: Element) => {
                if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) return el.value;
                return (el as HTMLElement).innerText || el.textContent || '';
            }
        );
        const retryTrimmed = retryContent.trim();
        if (!retryTrimmed.startsWith(expectedStart)) {
            logger.error(`[${label}] Front truncation persists after retry: "${retryTrimmed.slice(0, 30)}..."`);
            return { success: false, truncated: true };
        }

        logger.info(`[${label}] Front truncation fixed on retry`);
        return { success: true, truncated: true };
    }

    return { success: true, truncated: false };
}

function extractHashtags(text: string): string[] {
    const matches = text.match(/#[\w\u0080-\uFFFF]+/g);
    return matches ? matches.map(h => h.toLowerCase()) : [];
}

function extractMentions(text: string): string[] {
    const matches = text.match(/@[\w]+/g);
    return matches ? matches.map(m => m.toLowerCase()) : [];
}

export function parseMetricFromAriaLabel(ariaLabel: string | null, keyword: string): number {
    if (!ariaLabel) return 0;
    // e.g. "123 Likes" or "1,234 replies"
    const regex = new RegExp(`([\\d,]+)\\s+${keyword}`, 'i');
    const match = ariaLabel.match(regex);
    if (match) {
        return parseInt(match[1].replace(/,/g, ''), 10) || 0;
    }
    return 0;
}

// ── Core Functions ───────────────────────────────────────────────────

/**
 * Extract metadata from a tweet article element.
 */
export async function extractTweetMetadata(tweet: ElementHandle, page: Page): Promise<TweetMetadata> {
    try {
        const data = await tweet.evaluate((el: Element) => {
            // Tweet text
            const tweetTextEl = el.querySelector('div[data-testid="tweetText"]');
            const text = tweetTextEl?.textContent?.trim() || '';

            // Author info from User-Name container
            const userNameEl = el.querySelector('div[data-testid="User-Name"]');
            let username = '';
            let displayName = '';
            if (userNameEl) {
                // The User-Name div typically contains display name and @username
                const spans = userNameEl.querySelectorAll('span');
                for (const span of spans) {
                    const content = span.textContent?.trim() || '';
                    if (content.startsWith('@')) {
                        username = content.slice(1); // remove leading @
                    } else if (!displayName && content && !content.includes('·') && !content.match(/^\d+[hms]$/)) {
                        displayName = content;
                    }
                }
                // Fallback: extract from links
                if (!username) {
                    const links = userNameEl.querySelectorAll('a[href^="/"]');
                    for (const link of links) {
                        const href = link.getAttribute('href') || '';
                        if (href && !href.includes('/') || href.split('/').filter(Boolean).length === 1) {
                            username = href.replace(/^\//, '');
                            break;
                        }
                    }
                }
            }

            // Check if this is a retweet
            const isRetweet = !!el.querySelector('span[data-testid="socialContext"]');

            // Check for media (images, videos, cards)
            const hasMedia = !!(
                el.querySelector('div[data-testid="tweetPhoto"]') ||
                el.querySelector('div[data-testid="videoPlayer"]') ||
                el.querySelector('video') ||
                el.querySelector('img[src*="media"]')
            );

            // Timestamp from time element
            let timestampStr = '';
            const timeEl = el.querySelector('time');
            if (timeEl) {
                timestampStr = timeEl.getAttribute('datetime') || '';
            }

            // Tweet URL from the timestamp link
            let tweetUrl: string | null = null;
            const statusLink = el.querySelector('a[href*="/status/"]');
            if (statusLink) {
                const href = statusLink.getAttribute('href') || '';
                tweetUrl = href.startsWith('http') ? href : `https://x.com${href}`;
            }

            // Engagement metrics from button aria-labels
            const likeBtn = el.querySelector('button[data-testid="like"], button[data-testid="unlike"]');
            const retweetBtn = el.querySelector('button[data-testid="retweet"], button[data-testid="unretweet"]');
            const replyBtn = el.querySelector('button[data-testid="reply"]');

            const likesLabel = likeBtn?.getAttribute('aria-label') || '';
            const retweetsLabel = retweetBtn?.getAttribute('aria-label') || '';
            const repliesLabel = replyBtn?.getAttribute('aria-label') || '';

            return {
                text,
                username,
                displayName,
                isRetweet,
                hasMedia,
                timestampStr,
                tweetUrl,
                likesLabel,
                retweetsLabel,
                repliesLabel
            };
        });

        const hashtags = extractHashtags(data.text);
        const mentions = extractMentions(data.text);

        return {
            type: 'tweet',
            username: data.username,
            displayName: data.displayName,
            text: data.text,
            isRetweet: data.isRetweet,
            hasMedia: data.hasMedia,
            hashtags,
            mentions,
            likes: parseMetricFromAriaLabel(data.likesLabel, 'like'),
            retweets: parseMetricFromAriaLabel(data.retweetsLabel, 'retweet'),
            replies: parseMetricFromAriaLabel(data.repliesLabel, 'repl'),
            timestamp: data.timestampStr ? new Date(data.timestampStr) : new Date(),
            tweetUrl: data.tweetUrl,
            success: true
        };
    } catch (error) {
        logger.error('Failed to extract tweet metadata', {
            component: 'Twitter-Core',
            event: 'metadata_extraction_failed',
            error: formatError(error)
        });
        return {
            type: 'tweet',
            username: '',
            displayName: '',
            text: '',
            isRetweet: false,
            hasMedia: false,
            hashtags: [],
            mentions: [],
            likes: 0,
            retweets: 0,
            replies: 0,
            timestamp: new Date(),
            tweetUrl: null,
            success: false,
            error: formatError(error)
        };
    }
}

/**
 * Generate a contextual reply to a tweet using OpenAI.
 */
export async function generateReply(
    tweetText: string,
    author: string,
    guidelines: ReplyGuidelines = DEFAULT_REPLY_GUIDELINES
): Promise<string> {
    if (!tweetText) {
        logger.warn('No tweet text provided for reply generation', {
            component: 'Twitter-Core',
            event: 'reply_generation_no_text'
        });
        return '';
    }

    logger.info('Starting reply generation', {
        component: 'Twitter-Core',
        event: 'reply_generation_start',
        tweetTextLength: tweetText.length,
        author
    });

    const cleanText = sanitizeForPrompt(tweetText, 500);
    const cleanAuthor = sanitizeForPrompt(author, 50);

    const prompt = `Generate a reply to this tweet by @${cleanAuthor}: "${cleanText}"

Rules:
1. Length: ${guidelines.minLength}-${guidelines.maxLength} characters
2. Sound natural and conversational — write like a real person on Twitter
3. Add value: share an insight, ask a thoughtful question, or agree with substance
4. Do NOT use generic filler like "Great post!", "Love this!", "So true!"
5. Do NOT ask the author to follow you or check your profile
6. Maximum ${guidelines.maxEmojis} emojis (fewer is better)
7. Match the tone of the original tweet (casual, professional, humorous, etc.)
8. Keep it concise — Twitter rewards brevity
9. Do NOT start with "I" if possible
10. Do NOT use hashtags in the reply

Reply only with the comment text, nothing else.`;

    const reply = await withRetry(
        async () => {
            const content = await chatCompletion({
                messages: [
                    {
                        role: 'system',
                        content: 'You are a knowledgeable Twitter user who writes concise, thoughtful replies. Your replies are genuine, add to the conversation, and never feel spammy or generic.'
                    },
                    { role: 'user', content: prompt }
                ],
                max_tokens: 100,
                temperature: 0.8
            });

            if (!content) {
                throw new Error('AI returned empty reply');
            }
            return content;
        },
        {
            maxRetries: 3,
            baseDelay: 1000,
            label: 'twitter-reply-generation'
        }
    );

    logger.info('Generated reply from OpenAI', {
        component: 'Twitter-Core',
        event: 'reply_generation_success',
        replyLength: reply.length
    });

    return reply;
}

/**
 * Validate a reply against guidelines before posting.
 */
export function validateReply(
    reply: string,
    guidelines: ReplyGuidelines = DEFAULT_REPLY_GUIDELINES
): { valid: boolean; reason?: string } {
    if (!reply) {
        return { valid: false, reason: 'Reply is empty' };
    }

    // Check length
    if (reply.length < guidelines.minLength) {
        return { valid: false, reason: `Reply too short (${reply.length} < ${guidelines.minLength})` };
    }
    if (reply.length > guidelines.maxLength) {
        return { valid: false, reason: `Reply too long (${reply.length} > ${guidelines.maxLength})` };
    }

    // Count emojis
    const emojiRegex = /[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu;
    const emojiCount = (reply.match(emojiRegex) || []).length;
    if (emojiCount > guidelines.maxEmojis) {
        return { valid: false, reason: `Too many emojis (${emojiCount} > ${guidelines.maxEmojis})` };
    }

    // Check for forbidden phrases
    const lowerReply = reply.toLowerCase();
    for (const phrase of guidelines.forbiddenPhrases) {
        if (lowerReply.includes(phrase.toLowerCase())) {
            return { valid: false, reason: `Contains forbidden phrase: "${phrase}"` };
        }
    }

    // Check for value-add requirement
    if (guidelines.mustAddValue) {
        const genericPatterns = [
            /^(nice|great|good|awesome|cool|love it|amazing|wow|so true)\.?!?$/i,
            /^(this|agreed|same|facts|real|fr|literally)\.?!?$/i
        ];
        for (const pattern of genericPatterns) {
            if (pattern.test(reply.trim())) {
                return { valid: false, reason: 'Reply is too generic and does not add value' };
            }
        }
    }

    return { valid: true };
}

/**
 * Post a reply to a specific tweet.
 */
export async function postReply(
    tweet: ElementHandle,
    page: Page,
    reply: string,
    verifyAfterPost = true
): Promise<{ success: boolean; error?: string }> {
    try {
        logger.info('Starting reply operation', {
            component: 'Twitter-Core',
            event: 'reply_operation_start',
            replyLength: reply.length
        });

        // Scroll tweet into view
        await tweet.evaluate((el: Element) => {
            (el as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'center' });
        });
        await delay(1000);

        // Click the reply button to open the reply modal
        const replyButton = await tweet.$('button[data-testid="reply"]');
        if (!replyButton) {
            return { success: false, error: 'Reply button not found on tweet' };
        }

        await replyButton.click({ delay: getRandomDelay(30, 80) });
        await delay(2000);

        // Wait for the reply modal to appear — ONLY look inside modal/dialog
        // to avoid accidentally typing in the compose box or search bar
        const modalSelectors = [
            'div[aria-modal="true"] div[data-testid="tweetTextarea_0"]',
            'div[role="dialog"] div[data-testid="tweetTextarea_0"]',
            'div[aria-modal="true"] div[role="textbox"][contenteditable="true"]',
            'div[role="dialog"] div[role="textbox"][contenteditable="true"]',
        ];

        let replyTextarea: ElementHandle<Element> | null = null;
        for (const sel of modalSelectors) {
            replyTextarea = await page.waitForSelector(sel, { timeout: 5000 }).catch(() => null);
            if (replyTextarea) {
                logger.info(`Reply textarea found: ${sel}`, { component: 'Twitter-Core' });
                break;
            }
        }

        if (!replyTextarea) {
            // No modal appeared — abort rather than risk typing in wrong place
            // Try pressing Escape to close any partial modal, then bail
            await page.keyboard.press('Escape');
            return { success: false, error: 'Reply modal did not open — no modal textarea found' };
        }

        // Click the textarea to focus it
        await replyTextarea.click();
        await delay(500);

        // Verify focus is INSIDE the modal, not on search box or compose bar
        const focusCheck = await page.evaluate(() => {
            const active = document.activeElement;
            if (!active) return { ok: false, where: 'none' };

            // Check if active element is inside a modal/dialog
            const inModal = active.closest('[aria-modal="true"]') || active.closest('[role="dialog"]');
            if (!inModal) return { ok: false, where: 'outside_modal' };

            // Check it's not a search box
            let el: Element | null = active;
            while (el) {
                const testId = el.getAttribute?.('data-testid') || '';
                if (testId.toLowerCase().includes('search')) return { ok: false, where: 'search_box' };
                el = el.parentElement;
            }
            return { ok: true, where: 'modal_textarea' };
        });

        if (!focusCheck.ok) {
            logger.warn(`Focus not on reply textarea: ${focusCheck.where} — retrying`, {
                component: 'Twitter-Core', event: 'reply_focus_correction'
            });
            // Try clicking the textarea again, directly
            await replyTextarea.click();
            await delay(500);

            // Re-verify
            const recheck = await page.evaluate(() => {
                const active = document.activeElement;
                const inModal = active?.closest('[aria-modal="true"]') || active?.closest('[role="dialog"]');
                return !!inModal;
            });
            if (!recheck) {
                await page.keyboard.press('Escape');
                return { success: false, error: `Focus stuck on ${focusCheck.where} — cannot type reply safely` };
            }
        }

        // Type the reply with front-truncation protection
        const typeResult = await safeType(page, replyTextarea, reply, { label: 'postReply' });
        if (!typeResult.success) {
            return { success: false, error: 'Reply text was truncated at front even after retry' };
        }

        // Click submit — ONLY look inside the modal for the button
        let submitButton = await page.$('div[aria-modal="true"] button[data-testid="tweetButton"]')
            || await page.$('div[role="dialog"] button[data-testid="tweetButton"]');
        if (!submitButton) {
            // Fallback: any tweetButton on the page (but only if modal is still open)
            const modalStillOpen = await page.$('div[aria-modal="true"], div[role="dialog"]');
            if (modalStillOpen) {
                submitButton = await page.$('button[data-testid="tweetButton"]');
            }
        }
        if (!submitButton) {
            return { success: false, error: 'Reply submit button not found in modal' };
        }

        await submitButton.click({ delay: getRandomDelay(30, 80) });
        await delay(3000);

        // Verify the reply was posted
        if (verifyAfterPost) {
            // After posting, the modal should close. Check that compose area is gone.
            const composeGone = await page.$('div[data-testid="tweetTextarea_0"]');
            if (composeGone) {
                // Check if the textarea still has content (could indicate a failure)
                const remainingText = await composeGone.evaluate(
                    (el: Element) => el.textContent?.trim() || ''
                );
                if (remainingText.length > 0) {
                    logger.warn('Reply compose area still has text after submit — reply may not have posted', {
                        component: 'Twitter-Core',
                        event: 'reply_verification_warning'
                    });
                    return { success: false, error: 'Reply may not have posted — compose area still present with text' };
                }
            }

            logger.info('Reply posted successfully', {
                component: 'Twitter-Core',
                event: 'reply_operation_success'
            });
        }

        return { success: true };
    } catch (error) {
        const category = classifyError(error);
        logger.error('Reply operation failed', {
            component: 'Twitter-Core',
            event: 'reply_operation_failed',
            error: formatError(error),
            category
        });
        return { success: false, error: formatError(error) };
    }
}

/**
 * Like a tweet.
 */
export async function likeTweet(
    tweet: ElementHandle,
    page: Page
): Promise<{ success: boolean; error?: string }> {
    try {
        logger.info('Starting like operation', {
            component: 'Twitter-Core',
            event: 'like_operation_start'
        });

        // Check if already liked
        const alreadyLiked = await hasAlreadyLiked(tweet, page);
        if (alreadyLiked) {
            logger.info('Tweet already liked, skipping', {
                component: 'Twitter-Core',
                event: 'like_already_exists'
            });
            return { success: true };
        }

        // Scroll into view
        await tweet.evaluate((el: Element) => {
            (el as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'center' });
        });
        await delay(800);

        const likeButton = await tweet.$('button[data-testid="like"]');
        if (!likeButton) {
            return { success: false, error: 'Like button not found' };
        }

        // Click with try/catch for stale element
        try {
            await likeButton.click({ delay: getRandomDelay(20, 50) });
            logger.info('[action] likeButton.click() succeeded', { component: 'Twitter-Core' });
        } catch (clickErr) {
            logger.warn('[action] likeButton.click() failed, trying JS dispatch', { component: 'Twitter-Core' });
            await likeButton.evaluate((node: Element) => {
                node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
            });
        }

        await delay(1500);

        // Verify by checking for the "unlike" button
        const unlikeButton = await tweet.$('button[data-testid="unlike"]');
        if (unlikeButton) {
            logger.info('Like operation verified', {
                component: 'Twitter-Core',
                event: 'like_operation_success'
            });
            return { success: true };
        }

        // Even without verification, if no error was thrown, assume success
        logger.info('Like clicked — could not verify but no error', {
            component: 'Twitter-Core',
            event: 'like_operation_unverified'
        });
        return { success: true };
    } catch (error) {
        const category = classifyError(error);
        logger.error('Like operation failed', {
            component: 'Twitter-Core',
            event: 'like_operation_failed',
            error: formatError(error),
            category
        });
        return { success: false, error: formatError(error) };
    }
}

/**
 * Retweet a tweet.
 */
export async function retweet(
    tweet: ElementHandle,
    page: Page
): Promise<{ success: boolean; error?: string }> {
    try {
        logger.info('Starting retweet operation', {
            component: 'Twitter-Core',
            event: 'retweet_operation_start'
        });

        // Check if already retweeted
        const alreadyRetweeted = await tweet.$('button[data-testid="unretweet"]');
        if (alreadyRetweeted) {
            logger.info('Tweet already retweeted, skipping', {
                component: 'Twitter-Core',
                event: 'retweet_already_exists'
            });
            return { success: true };
        }

        // Scroll into view
        await tweet.evaluate((el: Element) => {
            (el as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'center' });
        });
        await delay(800);

        const retweetButton = await tweet.$('button[data-testid="retweet"]');
        if (!retweetButton) {
            return { success: false, error: 'Retweet button not found' };
        }

        // Click the retweet button — this opens a dropdown menu
        try {
            await retweetButton.click({ delay: getRandomDelay(20, 50) });
        } catch (clickErr) {
            await retweetButton.evaluate((node: Element) => {
                node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
            });
        }

        await delay(1500);

        // In the dropdown, click "Retweet" (not "Quote Tweet")
        // The dropdown menu item for plain retweet uses data-testid="retweetConfirm"
        const confirmButton = await page.$('div[data-testid="retweetConfirm"]');
        if (confirmButton) {
            await confirmButton.click({ delay: getRandomDelay(20, 50) });
            await delay(1500);
        } else {
            // Fallback: look for menu items with "Retweet" text
            const menuItems = await page.$$('div[role="menuitem"]');
            let clicked = false;
            for (const item of menuItems) {
                const text = await item.evaluate((el: Element) => el.textContent?.trim() || '');
                if (text.toLowerCase() === 'retweet') {
                    await item.click({ delay: getRandomDelay(20, 50) });
                    clicked = true;
                    break;
                }
            }
            if (!clicked) {
                // Press Escape to close menu and report error
                await page.keyboard.press('Escape');
                return { success: false, error: 'Retweet confirm option not found in dropdown' };
            }
            await delay(1500);
        }

        // Verify
        const unretweetButton = await tweet.$('button[data-testid="unretweet"]');
        if (unretweetButton) {
            logger.info('Retweet operation verified', {
                component: 'Twitter-Core',
                event: 'retweet_operation_success'
            });
            return { success: true };
        }

        logger.info('Retweet clicked — could not verify but no error', {
            component: 'Twitter-Core',
            event: 'retweet_operation_unverified'
        });
        return { success: true };
    } catch (error) {
        const category = classifyError(error);
        logger.error('Retweet operation failed', {
            component: 'Twitter-Core',
            event: 'retweet_operation_failed',
            error: formatError(error),
            category
        });
        return { success: false, error: formatError(error) };
    }
}

/**
 * Check if the bot has already replied to a tweet.
 */
export async function hasAlreadyReplied(
    tweet: ElementHandle,
    page: Page,
    botUsername: string
): Promise<boolean> {
    try {
        // Navigate to the tweet thread to check replies is expensive,
        // so we use a lightweight check: look at the tweet URL and check
        // for cached replies, or inspect inline reply previews.
        const tweetUrl = await extractTweetUrl(tweet);
        if (!tweetUrl) return false;

        // Check if we can see a reply indicator from our account in the thread preview
        // Twitter sometimes shows "You replied" or shows inline reply from the user
        const replied = await tweet.evaluate((el: Element, username: string) => {
            // Look for reply thread indicators mentioning our username
            const allText = el.textContent?.toLowerCase() || '';
            return allText.includes(`@${username.toLowerCase()}`);
        }, botUsername);

        return replied;
    } catch (error) {
        logger.debug(`[Twitter-Core] hasAlreadyReplied check failed: ${formatError(error)}`);
        return false;
    }
}

/**
 * Check if the tweet has already been liked.
 */
export async function hasAlreadyLiked(
    tweet: ElementHandle,
    page: Page
): Promise<boolean> {
    try {
        // If "unlike" button exists, tweet is already liked
        const unlikeButton = await tweet.$('button[data-testid="unlike"]');
        return !!unlikeButton;
    } catch (error) {
        logger.debug(`[Twitter-Core] hasAlreadyLiked check failed: ${formatError(error)}`);
        return false;
    }
}

/**
 * Extract the URL of a tweet from its element.
 */
export async function extractTweetUrl(tweet: ElementHandle): Promise<string | null> {
    try {
        const url = await tweet.evaluate((el: Element) => {
            const link = el.querySelector('a[href*="/status/"]');
            if (!link) return null;
            const href = link.getAttribute('href') || '';
            return href.startsWith('http') ? href : `https://x.com${href}`;
        });
        return url;
    } catch (error) {
        logger.debug(`[Twitter-Core] extractTweetUrl failed: ${formatError(error)}`);
        return null;
    }
}

/**
 * Process a batch of tweets: extract metadata, generate replies, and interact.
 */
export async function processTweets(
    tweets: ElementHandle[],
    page: Page,
    trace?: any,
    session?: any
): Promise<void> {
    try {
        const maxTweetsPerIteration = 10;
        const tweetsPerRun = parseInt(process.env.TWEETS_PER_RUN || '10', 10);
        const effectiveMax = Math.min(maxTweetsPerIteration, tweetsPerRun);
        const tweetsToProcess = tweets.slice(0, effectiveMax);

        logger.info(`Processing ${tweetsToProcess.length} of ${tweets.length} tweets`, {
            component: 'Twitter-Core',
            event: 'batch_processing_start',
            total: tweets.length,
            processing: tweetsToProcess.length
        });

        let processedCount = 0;
        let skippedCount = 0;
        let errorCount = 0;

        for (let i = 0; i < tweetsToProcess.length; i++) {
            const tweet = tweetsToProcess[i];

            try {
                const result = await processTweetWithRetry(tweet, page, trace, i);
                if (session) session.tweetsProcessed = (session.tweetsProcessed || 0) + 1;

                if (result.success) {
                    processedCount++;
                } else if (result.skipped) {
                    skippedCount++;
                } else {
                    errorCount++;
                }

                logger.info('Tweet processing result', {
                    component: 'Twitter-Core',
                    event: 'tweet_result',
                    index: i,
                    success: result.success,
                    skipped: result.skipped,
                    error: result.error
                });

                // Human-like delay between interactions
                if (i < tweetsToProcess.length - 1) {
                    const betweenDelay = getRandomDelay(3000, 8000);
                    logger.info(`Waiting ${betweenDelay}ms before next tweet`, { component: 'Twitter-Core' });
                    await delay(betweenDelay);
                }
            } catch (error) {
                errorCount++;
                const category = classifyError(error);
                logger.error(`Failed to process tweet ${i}`, {
                    component: 'Twitter-Core',
                    event: 'tweet_processing_error',
                    index: i,
                    error: formatError(error),
                    category
                });

                // If blocked or auth error, stop processing entirely
                if (category === 'blocked' || category === 'auth') {
                    logger.error('Critical error — stopping batch processing', {
                        component: 'Twitter-Core',
                        event: 'batch_processing_abort',
                        category
                    });
                    break;
                }
            }
        }

        logger.info('Batch processing complete', {
            component: 'Twitter-Core',
            event: 'batch_processing_complete',
            processed: processedCount,
            skipped: skippedCount,
            errors: errorCount
        });
    } catch (error) {
        logger.error('Batch tweet processing failed', {
            component: 'Twitter-Core',
            event: 'batch_processing_failed',
            error: formatError(error)
        });
    }
}

/**
 * Process a single tweet with retry logic: extract metadata, generate and post a reply, and like.
 */
export async function processTweetWithRetry(
    tweet: ElementHandle,
    page: Page,
    trace?: any,
    index?: number
): Promise<ProcessTweetResult> {
    let retryCount = 0;
    const maxRetries = 3;
    const tStart = Date.now();

    while (retryCount < maxRetries) {
        try {
            logger.info('Starting tweet processing', {
                component: 'Twitter-Core',
                event: 'tweet_processing_start',
                index,
                retryCount
            });

            // Extract metadata
            const metadata = await extractTweetMetadata(tweet, page);
            if (!metadata.success) {
                throw new Error(metadata.error || 'Failed to extract tweet metadata');
            }

            // Skip retweets (interact with originals only)
            if (metadata.isRetweet) {
                logger.info('Skipping retweet', {
                    component: 'Twitter-Core',
                    event: 'tweet_skipped_retweet',
                    username: metadata.username
                });
                return { success: false, skipped: true, details: 'Skipped retweet', metadata };
            }

            // Skip tweets with no text
            if (!metadata.text || metadata.text.trim().length === 0) {
                logger.info('Skipping tweet with no text', {
                    component: 'Twitter-Core',
                    event: 'tweet_skipped_no_text',
                    username: metadata.username
                });
                return { success: false, skipped: true, details: 'No tweet text', metadata };
            }

            // Check if already replied
            const botUsername = process.env.TWITTER_BOT_USERNAME || '';
            if (botUsername) {
                const alreadyReplied = await hasAlreadyReplied(tweet, page, botUsername);
                if (alreadyReplied) {
                    logger.info('Already replied to this tweet, skipping', {
                        component: 'Twitter-Core',
                        event: 'tweet_skipped_already_replied',
                        username: metadata.username
                    });
                    return { success: false, skipped: true, details: 'Already replied', metadata };
                }
            }

            // Content filter — language, topic, risk, blocked accounts
            const { filterTweet } = await import('../filters/twitter-content-filter');
            const filterResult = filterTweet(metadata.text, metadata.username, metadata.displayName);
            if (!filterResult.allowed) {
                logger.info('Content filter blocked tweet', {
                    component: 'Twitter-Core',
                    event: 'tweet_skipped_filter',
                    gate: filterResult.gate,
                    reason: filterResult.reason,
                    username: metadata.username,
                });
                return { success: false, skipped: true, details: `Filter: ${filterResult.reason}`, metadata };
            }

            // Capture screenshot artifact when tracing
            if (trace && trace.runId) {
                try {
                    const dir = path.join(process.cwd(), 'artifacts', trace.runId);
                    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                    const fileName = `tweet_${index ?? 'x'}_${Date.now()}.png`;
                    const filePath = path.join(dir, fileName);
                    await (tweet as any).screenshot({ path: filePath });
                } catch (screenshotErr) {
                    logger.debug(`[Twitter-Core] Screenshot capture failed: ${formatError(screenshotErr)}`);
                }
            }

            // Generate reply
            const reply = await generateReply(metadata.text, metadata.username);
            if (!reply) {
                logger.warn('Reply generation returned empty', {
                    component: 'Twitter-Core',
                    event: 'reply_generation_empty',
                    username: metadata.username
                });
                return { success: false, error: 'Empty reply generated', metadata };
            }

            // Validate reply
            const validation = validateReply(reply);
            if (!validation.valid) {
                logger.warn('Generated reply failed validation', {
                    component: 'Twitter-Core',
                    event: 'reply_validation_failed',
                    reason: validation.reason,
                    reply
                });
                return { success: false, error: `Reply validation failed: ${validation.reason}`, metadata };
            }

            // Like the tweet first (lower risk action)
            const likeResult = await likeTweet(tweet, page);
            if (!likeResult.success) {
                logger.warn('Like failed but continuing to reply', {
                    component: 'Twitter-Core',
                    event: 'like_failed_continuing',
                    error: likeResult.error
                });
            }

            await delay(getRandomDelay(1000, 2500));

            // Post the reply
            const replyResult = await postReply(tweet, page, reply);
            if (!replyResult.success) {
                throw new Error(replyResult.error || 'Reply posting failed');
            }

            const elapsed = Date.now() - tStart;
            logger.info('Tweet processed successfully', {
                component: 'Twitter-Core',
                event: 'tweet_processing_success',
                index,
                username: metadata.username,
                elapsedMs: elapsed,
                liked: likeResult.success,
                replied: true
            });

            return {
                success: true,
                details: `Replied to @${metadata.username}: "${reply.substring(0, 50)}..."`,
                metadata
            };
        } catch (error) {
            retryCount++;
            const category = classifyError(error);

            logger.error(`Tweet processing attempt ${retryCount}/${maxRetries} failed`, {
                component: 'Twitter-Core',
                event: 'tweet_processing_retry',
                index,
                retryCount,
                error: formatError(error),
                category
            });

            // Don't retry on non-transient errors
            if (category === 'blocked' || category === 'auth' || category === 'fatal') {
                return {
                    success: false,
                    error: `${category}: ${formatError(error)}`
                };
            }

            if (retryCount >= maxRetries) {
                return {
                    success: false,
                    error: `Failed after ${maxRetries} retries: ${formatError(error)}`
                };
            }

            // Exponential backoff between retries
            const backoffDelay = Math.min(30000, 2000 * Math.pow(2, retryCount - 1));
            logger.info(`Retrying in ${backoffDelay}ms`, { component: 'Twitter-Core' });
            await delay(backoffDelay);
        }
    }

    return { success: false, error: 'Exhausted all retries' };
}

// ── Deep Reply Verification ─────────────────────────────────────────

/**
 * Navigate to the tweet URL and verify our reply is visible in the thread.
 */
export async function verifyReplyVisible(
    page: Page,
    tweetUrl: string,
    replyText: string
): Promise<boolean> {
    try {
        const botUsername = (process.env.TWITTER_BOT_USERNAME || '').toLowerCase();
        if (!botUsername || !tweetUrl) return false;

        logger.info(`[Twitter-Core] Verifying reply on ${tweetUrl}`, {
            component: 'Twitter-Core',
            event: 'verify_reply_start'
        });

        await page.goto(tweetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await delay(3000);

        // Scroll down to expose reply section
        await page.evaluate(() => window.scrollBy(0, 600));
        await delay(2000);

        const snippet = replyText.slice(0, 50).toLowerCase();

        const found = await page.evaluate((username: string, textSnippet: string) => {
            const articles = document.querySelectorAll('article[data-testid="tweet"]');
            for (const article of articles) {
                const text = (article as HTMLElement).innerText?.toLowerCase() || '';
                if (text.includes(`@${username}`) && text.includes(textSnippet)) {
                    return true;
                }
            }
            return false;
        }, botUsername, snippet);

        logger.info(`[Twitter-Core] Reply verification: ${found ? 'FOUND' : 'NOT FOUND'}`, {
            component: 'Twitter-Core',
            event: found ? 'verify_reply_success' : 'verify_reply_not_found'
        });

        return found;
    } catch (error) {
        logger.warn(`[Twitter-Core] Reply verification failed: ${formatError(error)}`);
        return false;
    }
}

// ── Post Original Tweet ─────────────────────────────────────────────

export interface PostTweetOptions {
    text: string;
    mediaPath?: string;          // Path to image/video/GIF to attach
    quoteTweetUrl?: string;      // URL of tweet to quote
    poll?: { options: string[]; durationHours: number };
}

export interface PostTweetResult {
    success: boolean;
    error?: string;
    tweetUrl?: string;
}

/**
 * Compose and post an original tweet.
 */
export async function postTweet(
    page: Page,
    options: PostTweetOptions
): Promise<PostTweetResult> {
    try {
        logger.info('[Twitter-Core] Posting tweet...', {
            component: 'Twitter-Core',
            event: 'post_tweet_start',
            hasMedia: !!options.mediaPath,
            isQuote: !!options.quoteTweetUrl,
            hasPoll: !!options.poll,
            textLength: options.text.length
        });

        // Navigate to home if not already there
        const url = page.url();
        if (!url.includes('x.com/home') && !url.includes('x.com/compose')) {
            await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 30000 });
            await delay(2000);
        }

        // Click the compose area on the home timeline
        const composeArea = await page.$('div[data-testid="tweetTextarea_0"]');
        if (!composeArea) {
            // Fallback: click the floating compose button
            const composeBtn = await page.$('a[data-testid="SideNav_NewTweet_Button"]')
                || await page.$('a[href="/compose/tweet"]');
            if (composeBtn) {
                await composeBtn.click();
                await delay(2000);
            } else {
                return { success: false, error: 'Could not find compose area or button' };
            }
        } else {
            await composeArea.click();
            await delay(500);
        }

        // Wait for the text input to be ready
        const textInput = await page.waitForSelector(
            'div[data-testid="tweetTextarea_0"]',
            { timeout: 8000 }
        ).catch(() => null);

        if (!textInput) {
            return { success: false, error: 'Tweet compose textarea not found' };
        }

        // Type with front-truncation protection
        const tweetText = options.quoteTweetUrl
            ? options.text + '\n' + options.quoteTweetUrl
            : options.text;
        const typeResult = await safeType(page, textInput, tweetText, { label: 'postTweet' });
        if (!typeResult.success) {
            return { success: false, error: 'Tweet text was truncated at front even after retry' };
        }
        await delay(500);

        // Attach media if provided
        if (options.mediaPath) {
            const attached = await attachMedia(page, options.mediaPath);
            if (!attached) {
                logger.warn('[Twitter-Core] Media attachment failed, posting without media');
            }
        }

        // Add poll if provided
        if (options.poll) {
            const pollAdded = await addPoll(page, options.poll.options, options.poll.durationHours);
            if (!pollAdded) {
                logger.warn('[Twitter-Core] Poll creation failed, posting without poll');
            }
        }

        await delay(1000);

        // Click the Post button
        const postButton = await page.$('button[data-testid="tweetButton"], button[data-testid="tweetButtonInline"]');
        if (!postButton) {
            return { success: false, error: 'Post button not found' };
        }

        await postButton.click({ delay: getRandomDelay(30, 80) });
        await delay(4000);

        // Verify — check that compose area is cleared or a success toast appeared
        const composeGone = await page.$('div[data-testid="tweetTextarea_0"]');
        if (composeGone) {
            const remainingText = await composeGone.evaluate(
                (el: Element) => el.textContent?.trim() || ''
            );
            if (remainingText.length > 0 && remainingText !== 'What is happening?!' && remainingText !== 'Post') {
                return { success: false, error: 'Tweet may not have posted — compose area still has text' };
            }
        }

        // Try to capture the tweet URL from the page (redirects to tweet after posting)
        let tweetUrl: string | undefined;
        try {
            await delay(2000);
            const currentUrl = page.url();
            if (currentUrl.includes('/status/')) {
                tweetUrl = currentUrl;
            } else {
                // Look for the most recent tweet by checking notification toast or nav
                const url = await page.evaluate((text: string) => {
                    const snippet = text.slice(0, 40).toLowerCase();
                    const articles = document.querySelectorAll('article[data-testid="tweet"]');
                    for (const article of articles) {
                        const articleText = (article as HTMLElement).innerText?.toLowerCase() || '';
                        if (articleText.includes(snippet)) {
                            const link = article.querySelector('a[href*="/status/"]');
                            if (link) {
                                const href = link.getAttribute('href') || '';
                                return href.startsWith('http') ? href : `https://x.com${href}`;
                            }
                        }
                    }
                    return null;
                }, options.text);
                if (url) tweetUrl = url;
            }
        } catch (urlErr) {
            logger.debug(`[Twitter-Core] Could not capture tweet URL (non-fatal): ${formatError(urlErr)}`);
        }

        // Verify posted text wasn't clipped (check first/last chars visible on page)
        if (tweetUrl && options.text.length > 20) {
            try {
                const textCheck = await page.evaluate((expectedText: string) => {
                    const snippet = expectedText.slice(0, 50).toLowerCase();
                    const endSnippet = expectedText.slice(-30).toLowerCase();
                    const articles = document.querySelectorAll('article[data-testid="tweet"]');
                    for (const article of articles) {
                        const text = (article as HTMLElement).innerText?.toLowerCase() || '';
                        if (text.includes(snippet)) {
                            return {
                                foundStart: true,
                                foundEnd: text.includes(endSnippet),
                            };
                        }
                    }
                    return { foundStart: false, foundEnd: false };
                }, options.text);

                if (textCheck.foundStart && !textCheck.foundEnd) {
                    logger.warn(`[Twitter-Core] Tweet text may be clipped — start found but end missing`);
                }
            } catch (verifyErr) {
                logger.debug(`[Twitter-Core] Text verification check failed (non-fatal): ${formatError(verifyErr)}`);
            }
        }

        logger.info('[Twitter-Core] Tweet posted successfully', {
            component: 'Twitter-Core',
            event: 'post_tweet_success',
            tweetUrl: tweetUrl || 'unknown'
        });

        return { success: true, tweetUrl };
    } catch (error) {
        logger.error('[Twitter-Core] Tweet posting failed', {
            component: 'Twitter-Core',
            event: 'post_tweet_failed',
            error: formatError(error)
        });
        return { success: false, error: formatError(error) };
    }
}

// ── Quote Tweet ─────────────────────────────────────────────────────

/**
 * Quote tweet: opens the quote dialog and posts with commentary.
 */
export async function quoteTweet(
    tweet: ElementHandle,
    page: Page,
    commentary: string
): Promise<PostTweetResult> {
    try {
        logger.info('[Twitter-Core] Starting quote tweet...', {
            component: 'Twitter-Core',
            event: 'quote_tweet_start'
        });

        // Scroll into view
        await tweet.evaluate((el: Element) => {
            (el as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'center' });
        });
        await delay(1000);

        // Click the retweet button to open the dropdown
        const retweetButton = await tweet.$('button[data-testid="retweet"]');
        if (!retweetButton) {
            return { success: false, error: 'Retweet button not found for quote tweet' };
        }

        await retweetButton.click({ delay: getRandomDelay(20, 50) });
        await delay(1500);

        // Click "Quote" in the dropdown
        const quoteOption = await page.$('a[href="/compose/tweet"]')
            || await page.$('div[data-testid="Dropdown"] a[href*="quote"]');

        // Fallback: find menu item with "Quote" text
        let quoteClicked = false;
        if (quoteOption) {
            await quoteOption.click();
            quoteClicked = true;
        } else {
            const menuItems = await page.$$('div[role="menuitem"], a[role="menuitem"]');
            for (const item of menuItems) {
                const text = await item.evaluate((el: Element) => el.textContent?.trim().toLowerCase() || '');
                if (text.includes('quote')) {
                    await item.click();
                    quoteClicked = true;
                    break;
                }
            }
        }

        if (!quoteClicked) {
            await page.keyboard.press('Escape');
            return { success: false, error: 'Quote option not found in retweet dropdown' };
        }

        await delay(2000);

        // Wait for the quote compose area
        const quoteInput = await page.waitForSelector(
            'div[data-testid="tweetTextarea_0"]',
            { timeout: 8000 }
        ).catch(() => null);

        if (!quoteInput) {
            return { success: false, error: 'Quote tweet compose area not found' };
        }

        // Type the commentary with front-truncation protection
        const quoteTypeResult = await safeType(page, quoteInput, commentary, { label: 'quoteTweet' });
        if (!quoteTypeResult.success) {
            return { success: false, error: 'Quote tweet text was truncated at front even after retry' };
        }
        await delay(500);

        // Post it
        const postButton = await page.$('button[data-testid="tweetButton"]');
        if (!postButton) {
            return { success: false, error: 'Quote tweet post button not found' };
        }

        await postButton.click({ delay: getRandomDelay(30, 80) });
        await delay(4000);

        logger.info('[Twitter-Core] Quote tweet posted successfully', {
            component: 'Twitter-Core',
            event: 'quote_tweet_success'
        });

        return { success: true };
    } catch (error) {
        logger.error('[Twitter-Core] Quote tweet failed', {
            component: 'Twitter-Core',
            event: 'quote_tweet_failed',
            error: formatError(error)
        });
        return { success: false, error: formatError(error) };
    }
}

// ── Tweet Thread ────────────────────────────────────────────────────

export interface ThreadTweet {
    text: string;
    mediaPath?: string;
}

/**
 * Post a tweet thread (multiple connected tweets).
 */
export async function postThread(
    page: Page,
    tweets: ThreadTweet[]
): Promise<PostTweetResult> {
    try {
        if (tweets.length === 0) {
            return { success: false, error: 'Thread has no tweets' };
        }

        logger.info(`[Twitter-Core] Posting thread with ${tweets.length} tweets...`, {
            component: 'Twitter-Core',
            event: 'post_thread_start',
            tweetCount: tweets.length
        });

        // Navigate to home
        const url = page.url();
        if (!url.includes('x.com/home') && !url.includes('x.com/compose')) {
            await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 30000 });
            await delay(2000);
        }

        // Click compose area
        const composeArea = await page.$('div[data-testid="tweetTextarea_0"]');
        if (!composeArea) {
            const composeBtn = await page.$('a[data-testid="SideNav_NewTweet_Button"]');
            if (composeBtn) {
                await composeBtn.click();
                await delay(2000);
            } else {
                return { success: false, error: 'Could not find compose area' };
            }
        } else {
            await composeArea.click();
            await delay(500);
        }

        // Type the first tweet
        const firstInput = await page.waitForSelector(
            'div[data-testid="tweetTextarea_0"]',
            { timeout: 8000 }
        ).catch(() => null);

        if (!firstInput) {
            return { success: false, error: 'Compose textarea not found for thread' };
        }

        const firstTypeResult = await safeType(page, firstInput, tweets[0].text, { label: 'postThread[0]' });
        if (!firstTypeResult.success) {
            return { success: false, error: 'Thread first tweet text was truncated at front' };
        }
        await delay(500);

        // Attach media to first tweet if provided
        if (tweets[0].mediaPath) {
            await attachMedia(page, tweets[0].mediaPath);
        }

        // Add subsequent tweets by clicking the "Add another tweet" button
        for (let i = 1; i < tweets.length; i++) {
            await delay(1000);

            // Click the "+" / "Add another tweet" button
            const addButton = await page.$('button[data-testid="addButton"]')
                || await page.$('div[data-testid="addButton"]');

            if (!addButton) {
                // Fallback: look for a button with a plus icon near the compose area
                const allButtons = await page.$$('button');
                let addClicked = false;
                for (const btn of allButtons) {
                    const ariaLabel = await btn.evaluate(el => el.getAttribute('aria-label')?.toLowerCase() || '');
                    if (ariaLabel.includes('add') || ariaLabel.includes('thread')) {
                        await btn.click();
                        addClicked = true;
                        break;
                    }
                }
                if (!addClicked) {
                    logger.warn(`[Twitter-Core] Could not find "add tweet" button for tweet ${i + 1}, posting ${i} tweets only`);
                    break;
                }
            } else {
                await addButton.click();
            }

            await delay(1000);

            // Find the new textarea (it will be tweetTextarea_N where N is the index)
            const newTextarea = await page.$(`div[data-testid="tweetTextarea_${i}"]`);
            if (newTextarea) {
                await safeType(page, newTextarea, tweets[i].text, { label: `postThread[${i}]` });
            } else {
                // Fallback: type into whatever has focus
                await page.keyboard.type(tweets[i].text, { delay: getRandomDelay(15, 40) });
            }
            await delay(500);

            if (tweets[i].mediaPath) {
                await attachMedia(page, tweets[i].mediaPath!);
            }
        }

        await delay(1000);

        // Click "Post all" button
        const postButton = await page.$('button[data-testid="tweetButton"]')
            || await page.$('button[data-testid="tweetButtonInline"]');
        if (!postButton) {
            return { success: false, error: 'Post button not found for thread' };
        }

        await postButton.click({ delay: getRandomDelay(30, 80) });
        await delay(5000);

        logger.info(`[Twitter-Core] Thread posted successfully (${tweets.length} tweets)`, {
            component: 'Twitter-Core',
            event: 'post_thread_success',
            tweetCount: tweets.length
        });

        return { success: true };
    } catch (error) {
        logger.error('[Twitter-Core] Thread posting failed', {
            component: 'Twitter-Core',
            event: 'post_thread_failed',
            error: formatError(error)
        });
        return { success: false, error: formatError(error) };
    }
}

// ── Media Attachment ────────────────────────────────────────────────

/**
 * Attach an image, video, or GIF to the current compose area.
 */
async function attachMedia(page: Page, mediaPath: string): Promise<boolean> {
    try {
        if (!fs.existsSync(mediaPath)) {
            logger.warn(`[Twitter-Core] Media file not found: ${mediaPath}`);
            return false;
        }

        // Twitter uses a hidden file input for media uploads
        const fileInput = await page.$('input[data-testid="fileInput"]')
            || await page.$('input[type="file"][accept*="image"], input[type="file"][accept*="video"]');

        if (!fileInput) {
            // Try clicking the media button to reveal the file input
            const mediaButton = await page.$('button[aria-label="Add photos or video"]')
                || await page.$('div[data-testid="fileInput"]')
                || await page.$('input[aria-label="Add photos or video"]');

            if (mediaButton) {
                await mediaButton.click();
                await delay(1000);
            }

            // Try again
            const input = await page.$('input[type="file"]');
            if (!input) {
                logger.warn('[Twitter-Core] File input not found for media upload');
                return false;
            }

            await (input as any).uploadFile(mediaPath);
        } else {
            await (fileInput as any).uploadFile(mediaPath);
        }

        // Wait for upload to complete (look for the media preview)
        await delay(3000);

        // Check for upload errors
        const error = await page.$('div[data-testid="attachments"] div[role="alert"]');
        if (error) {
            const errorText = await error.evaluate(el => el.textContent || '');
            logger.warn(`[Twitter-Core] Media upload error: ${errorText}`);
            return false;
        }

        logger.info(`[Twitter-Core] Media attached: ${path.basename(mediaPath)}`, {
            component: 'Twitter-Core',
            event: 'media_attached'
        });
        return true;
    } catch (error) {
        logger.warn(`[Twitter-Core] Media attachment failed: ${formatError(error)}`);
        return false;
    }
}

// ── Poll Creation ───────────────────────────────────────────────────

/**
 * Add a poll to the current compose area.
 */
async function addPoll(page: Page, options: string[], durationHours: number): Promise<boolean> {
    try {
        if (options.length < 2 || options.length > 4) {
            logger.warn('[Twitter-Core] Poll requires 2-4 options');
            return false;
        }

        // Click the poll icon button
        const pollButton = await page.$('button[aria-label="Add poll"]')
            || await page.$('div[data-testid="pollButton"]');

        if (!pollButton) {
            // Fallback: look through toolbar buttons
            const toolbarButtons = await page.$$('div[role="toolbar"] button, div[data-testid="toolBar"] button');
            let pollClicked = false;
            for (const btn of toolbarButtons) {
                const label = await btn.evaluate(el =>
                    el.getAttribute('aria-label')?.toLowerCase() || el.textContent?.toLowerCase() || ''
                );
                if (label.includes('poll')) {
                    await btn.click();
                    pollClicked = true;
                    break;
                }
            }
            if (!pollClicked) {
                logger.warn('[Twitter-Core] Poll button not found');
                return false;
            }
        } else {
            await pollButton.click();
        }

        await delay(1500);

        // Fill in poll options
        for (let i = 0; i < options.length; i++) {
            let optionInput: ElementHandle<Element> | null = null;

            // First two options are always visible
            if (i < 2) {
                const inputs = await page.$$('div[data-testid="pollOptionTextInput"] input, input[placeholder*="Choice"]');
                optionInput = inputs[i] || null;
            } else {
                // Click "Add" for options 3 and 4
                const addChoice = await page.$('button[data-testid="addPollOptionButton"]');
                if (addChoice) {
                    await addChoice.click();
                    await delay(500);
                }
                const inputs = await page.$$('div[data-testid="pollOptionTextInput"] input, input[placeholder*="Choice"]');
                optionInput = inputs[i] || null;
            }

            if (optionInput) {
                await optionInput.click();
                await delay(200);
                await page.keyboard.type(options[i], { delay: getRandomDelay(15, 30) });
            } else {
                logger.warn(`[Twitter-Core] Could not find input for poll option ${i + 1}`);
            }
        }

        // Set duration (Twitter has dropdown selectors for days/hours/minutes)
        // Default is 1 day — adjust if needed
        if (durationHours !== 24) {
            const durationSelects = await page.$$('select[aria-label*="Day"], select[aria-label*="Hour"], select[aria-label*="Minute"]');
            if (durationSelects.length >= 2) {
                const days = Math.floor(durationHours / 24);
                const hours = durationHours % 24;
                // Set days
                await durationSelects[0].select(String(days));
                await delay(300);
                // Set hours
                await durationSelects[1].select(String(hours));
                await delay(300);
            }
        }

        logger.info(`[Twitter-Core] Poll added with ${options.length} options`, {
            component: 'Twitter-Core',
            event: 'poll_added'
        });
        return true;
    } catch (error) {
        logger.warn(`[Twitter-Core] Poll creation failed: ${formatError(error)}`);
        return false;
    }
}

// ── Follow / Unfollow ───────────────────────────────────────────────

/**
 * Follow a user from their profile page or from a tweet element.
 */
export async function followUser(
    page: Page,
    username: string
): Promise<{ success: boolean; error?: string }> {
    try {
        logger.info(`[Twitter-Core] Following @${username}...`, {
            component: 'Twitter-Core',
            event: 'follow_start'
        });

        await page.goto(`https://x.com/${username}`, {
            waitUntil: 'domcontentloaded', timeout: 30000
        });
        await delay(3000);

        // Check if already following
        const unfollowButton = await page.$('button[data-testid*="unfollow"]')
            || await page.$('div[data-testid="placementTracking"] button[data-testid*="unfollow"]');
        if (unfollowButton) {
            logger.info(`[Twitter-Core] Already following @${username}`, {
                component: 'Twitter-Core',
                event: 'already_following'
            });
            return { success: true };
        }

        // Find and click the Follow button
        // Twitter uses data-testid that contains the username for the follow button
        const followButton = await page.$(`button[data-testid="${username}-follow"]`)
            || await page.$('div[data-testid="placementTracking"] button:not([data-testid*="unfollow"])');

        if (!followButton) {
            // Fallback: search all buttons for "Follow" text
            const allButtons = await page.$$('button[role="button"], div[role="button"]');
            for (const btn of allButtons) {
                const info = await btn.evaluate(el => {
                    const text = el.textContent?.trim() || '';
                    const testId = el.getAttribute('data-testid') || '';
                    const rect = el.getBoundingClientRect();
                    return { text, testId, visible: rect.width > 0 && rect.height > 0 };
                });
                if (info.text === 'Follow' && info.visible && !info.testId.includes('unfollow')) {
                    await btn.click({ delay: getRandomDelay(20, 50) });
                    await delay(2000);

                    logger.info(`[Twitter-Core] Followed @${username}`, {
                        component: 'Twitter-Core',
                        event: 'follow_success'
                    });
                    return { success: true };
                }
            }
            return { success: false, error: 'Follow button not found' };
        }

        await followButton.click({ delay: getRandomDelay(20, 50) });
        await delay(2000);

        // Verify
        const verifyUnfollow = await page.$('button[data-testid*="unfollow"]');
        if (verifyUnfollow) {
            logger.info(`[Twitter-Core] Followed @${username} (verified)`, {
                component: 'Twitter-Core',
                event: 'follow_verified'
            });
            return { success: true };
        }

        logger.info(`[Twitter-Core] Follow clicked for @${username} — unverified`, {
            component: 'Twitter-Core',
            event: 'follow_unverified'
        });
        return { success: true };
    } catch (error) {
        logger.error(`[Twitter-Core] Follow failed for @${username}`, {
            component: 'Twitter-Core',
            event: 'follow_failed',
            error: formatError(error)
        });
        return { success: false, error: formatError(error) };
    }
}

/**
 * Unfollow a user.
 */
export async function unfollowUser(
    page: Page,
    username: string
): Promise<{ success: boolean; error?: string }> {
    try {
        logger.info(`[Twitter-Core] Unfollowing @${username}...`, {
            component: 'Twitter-Core',
            event: 'unfollow_start'
        });

        await page.goto(`https://x.com/${username}`, {
            waitUntil: 'domcontentloaded', timeout: 30000
        });
        await delay(3000);

        // Find the Following/Unfollow button
        const followingButton = await page.$(`button[data-testid="${username}-unfollow"]`)
            || await page.$('button[data-testid*="unfollow"]');

        if (!followingButton) {
            // May not be following
            const followBtn = await page.$(`button[data-testid="${username}-follow"]`);
            if (followBtn) {
                logger.info(`[Twitter-Core] Not following @${username}`, {
                    component: 'Twitter-Core',
                    event: 'not_following'
                });
                return { success: true };
            }
            return { success: false, error: 'Unfollow button not found' };
        }

        await followingButton.click({ delay: getRandomDelay(20, 50) });
        await delay(1500);

        // Confirm unfollow in the dialog
        const confirmButton = await page.$('button[data-testid="confirmationSheetConfirm"]');
        if (confirmButton) {
            await confirmButton.click({ delay: getRandomDelay(20, 50) });
            await delay(2000);
        }

        logger.info(`[Twitter-Core] Unfollowed @${username}`, {
            component: 'Twitter-Core',
            event: 'unfollow_success'
        });
        return { success: true };
    } catch (error) {
        logger.error(`[Twitter-Core] Unfollow failed for @${username}`, {
            component: 'Twitter-Core',
            event: 'unfollow_failed',
            error: formatError(error)
        });
        return { success: false, error: formatError(error) };
    }
}

// ── Bookmark ────────────────────────────────────────────────────────

/**
 * Bookmark a tweet.
 */
export async function bookmarkTweet(
    tweet: ElementHandle,
    page: Page
): Promise<{ success: boolean; error?: string }> {
    try {
        // Scroll into view
        await tweet.evaluate((el: Element) => {
            (el as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'center' });
        });
        await delay(800);

        // Click the share/bookmark button
        const shareButton = await tweet.$('button[data-testid="bookmark"]');
        if (shareButton) {
            await shareButton.click({ delay: getRandomDelay(20, 50) });
            await delay(1500);

            logger.info('[Twitter-Core] Tweet bookmarked', {
                component: 'Twitter-Core',
                event: 'bookmark_success'
            });
            return { success: true };
        }

        // Fallback: use the share menu → Bookmark option
        const moreButton = await tweet.$('button[data-testid="caret"]')
            || await tweet.$('button[aria-label="Share Tweet"]')
            || await tweet.$('button[aria-label="Share post"]');

        if (!moreButton) {
            return { success: false, error: 'Bookmark/share button not found' };
        }

        await moreButton.click({ delay: getRandomDelay(20, 50) });
        await delay(1000);

        const menuItems = await page.$$('div[role="menuitem"]');
        for (const item of menuItems) {
            const text = await item.evaluate((el: Element) => el.textContent?.trim().toLowerCase() || '');
            if (text.includes('bookmark')) {
                await item.click({ delay: getRandomDelay(20, 50) });
                await delay(1500);

                logger.info('[Twitter-Core] Tweet bookmarked via menu', {
                    component: 'Twitter-Core',
                    event: 'bookmark_success'
                });
                return { success: true };
            }
        }

        await page.keyboard.press('Escape');
        return { success: false, error: 'Bookmark option not found in menu' };
    } catch (error) {
        logger.error('[Twitter-Core] Bookmark failed', {
            component: 'Twitter-Core',
            event: 'bookmark_failed',
            error: formatError(error)
        });
        return { success: false, error: formatError(error) };
    }
}

// ── Named Exports ────────────────────────────────────────────────────

export {
    ProcessTweetResult,
    DEFAULT_REPLY_GUIDELINES,
    getRandomDelay,
    extractHashtags,
    extractMentions
};
