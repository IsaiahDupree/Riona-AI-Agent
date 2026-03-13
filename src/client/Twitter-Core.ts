// Twitter/X Core — tweet interaction functions (reply, like, retweet, metadata extraction)
import { ElementHandle, Page } from 'puppeteer';
import { logger } from '../utils/logger';
import { formatError, withRetry, classifyError } from '../utils/errors';
import { delay } from '../utils/delay';
import OpenAI from 'openai';
import dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';

// Load environment variables
dotenv.config();

// Configure OpenAI
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY || ''
});

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

function extractHashtags(text: string): string[] {
    const matches = text.match(/#[\w\u0080-\uFFFF]+/g);
    return matches ? matches.map(h => h.toLowerCase()) : [];
}

function extractMentions(text: string): string[] {
    const matches = text.match(/@[\w]+/g);
    return matches ? matches.map(m => m.toLowerCase()) : [];
}

function parseMetricFromAriaLabel(ariaLabel: string | null, keyword: string): number {
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

    const prompt = `Generate a reply to this tweet by @${author}: "${tweetText}"

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
            const completion = await openai.chat.completions.create({
                model: 'gpt-4o-mini',
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

            const content = completion.choices[0]?.message?.content?.trim();
            if (!content) {
                throw new Error('OpenAI returned empty reply');
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

        // Wait for the reply modal / compose area to appear
        const replyTextarea = await page.waitForSelector(
            'div[data-testid="tweetTextarea_0"]',
            { timeout: 8000 }
        ).catch(() => null);

        if (!replyTextarea) {
            // Fallback: try finding any contenteditable div in the reply modal
            const fallbackTextarea = await page.$('div[role="textbox"][contenteditable="true"]');
            if (!fallbackTextarea) {
                return { success: false, error: 'Reply compose area not found after clicking reply' };
            }
            await fallbackTextarea.click();
            await delay(500);
            await page.keyboard.type(reply, { delay: getRandomDelay(20, 60) });
        } else {
            await replyTextarea.click();
            await delay(500);

            // Type the reply with human-like delays
            await page.keyboard.type(reply, { delay: getRandomDelay(20, 60) });
        }

        await delay(1000);

        // Click the tweet/reply submit button
        const submitButton = await page.$('button[data-testid="tweetButton"]');
        if (!submitButton) {
            return { success: false, error: 'Reply submit button not found' };
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

// ── Named Exports ────────────────────────────────────────────────────

export {
    ProcessTweetResult,
    DEFAULT_REPLY_GUIDELINES,
    getRandomDelay,
    extractHashtags,
    extractMentions
};
