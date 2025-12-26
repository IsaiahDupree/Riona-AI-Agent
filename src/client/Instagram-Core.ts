// Import required modules
import { ElementHandle, Page } from 'puppeteer';
import { logger } from '../utils/logger';
import { delay } from '../utils/delay';
import OpenAI from 'openai';
import dotenv from 'dotenv';
import { MongoClient } from 'mongodb';
import * as cheerio from 'cheerio';
import * as fs from 'fs';
import * as path from 'path';
import { pushStep } from '../trace/runtime';
import { InteractionHistoryService } from '../analytics/interactionHistory';
import { artifact } from '../trace/linkResolver';
import { saveTrace } from '../trace/store';
import { createProposedInteraction } from '../hitl/service';
import { AccountModel } from '../hitl/models';
import { StorageInterface } from '../db/interfaces';
import { SupabaseStorage } from '../db/supabase';

// Load environment variables
dotenv.config();

// Human-in-the-loop review mode gate (env fallback)
const HITL_MODE = String(process.env.INSTAGRAM_HITL ?? process.env.HITL_REQUIRE_REVIEW ?? '').toLowerCase();
const HITL_REVIEW = ['1', 'true', 'yes', 'on'].includes(HITL_MODE);

// Determine if review is required for the running account
async function isReviewEnabledForAccount(botUsername?: string): Promise<{ enabled: boolean; accountId?: string }> {
    try {
        if (botUsername) {
            const acc = await AccountModel.findOne({ platform: 'instagram', username: botUsername }).lean();
            if (acc) {
                const level = String((acc as any).hitlLevel || '').toLowerCase();
                if (['off', 'none', 'disabled'].includes(level)) {
                    return { enabled: false, accountId: (acc as any).id };
                }
                // 'soft', 'strict', or any other value -> enable review
                return { enabled: true, accountId: (acc as any).id };
            }
        }
        // Fallback to env flag if account not found
        return { enabled: HITL_REVIEW };
    } catch {
        // On error, fallback to env gate
        return { enabled: HITL_REVIEW };
    }
}

function computeQualityScores(caption: string, targetUsername: string, prefs: any): { brandFit: number; audienceFit: number; competitor: boolean } {
    try {
        const text = (caption || '').toLowerCase();
        const brand = Array.isArray(prefs?.brandKeywords) ? prefs.brandKeywords : [];
        const audience = Array.isArray(prefs?.audienceKeywords) ? prefs.audienceKeywords : [];
        const competitors = Array.isArray(prefs?.competitorUsernames) ? prefs.competitorUsernames.map((s: string) => s.toLowerCase()) : [];

        const countMatches = (keywords: string[]) => keywords.reduce((acc, k) => acc + (text.includes(String(k).toLowerCase()) ? 1 : 0), 0);

        const brandTotal = Math.max(1, brand.length);
        const audienceTotal = Math.max(1, audience.length);
        const brandFit = Math.min(1, countMatches(brand) / brandTotal);
        const audienceFit = Math.min(1, countMatches(audience) / audienceTotal);
        const competitor = competitors.includes((targetUsername || '').toLowerCase());

        return { brandFit, audienceFit, competitor };
    } catch {
        return { brandFit: 0, audienceFit: 0, competitor: false };
    }
}

// Configure OpenAI
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY || ''
});

// MongoDB setup
// Storage setup
let storage: StorageInterface | null = null;

// Interfaces
interface BaseMetadata {
    type: string;
    timestamp: Date;
    success: boolean;
    error?: string;
}

async function extractPermalink(post: ElementHandle<Element>): Promise<string | null> {
    try {
        const href = await post.evaluate((el) => {
            const a = el.querySelector('a[href^="/p/"]') || el.querySelector('a[href^="/reel/"]') || el.querySelector('a[href^="/stories/"]');
            return a ? (a.getAttribute('href') || null) : null;
        });
        if (!href) return null;
        if (href.startsWith('http')) return href;
        return `https://www.instagram.com${href}`;
    } catch (e) {
        return null;
    }
}

interface PostMetadata {
    username: string;
    caption: string;
    isVideo: boolean;
    hashtags: string[];
    timestamp: Date;
    type: 'post';
    likes: number;
    success: boolean;
    error?: string;
}

interface CommentMetadata extends BaseMetadata {
    type: 'comment';
    comment: string;
}

interface LikeMetadata extends BaseMetadata {
    type: 'like';
}

interface ErrorMetadata {
    type: 'error';
    timestamp: Date;
    error: string;
}

interface SuccessMetadata extends BaseMetadata {
    type: 'success';
}

interface BotInteraction {
    timestamp: Date;
    type: 'comment' | 'like' | 'test' | 'follow' | 'unfollow' | 'dm' | 'view' | 'share';
    success: boolean;
    error?: string;
    details?: string;
    actor?: string;
    metadata?: any;
}

type MetadataType = PostMetadata | CommentMetadata | LikeMetadata | ErrorMetadata;

interface PostData {
    caption: string;
    username: string;
    hashtags: string[];
    mentions: string[];
    likes: number;
    isVideo: boolean;
    timestamp?: string;
}

interface PostInteraction {
    success: boolean;
    error?: string;
    details: string;
}

interface InteractionResult {
    success: boolean;
    error?: string;
    details: string;
    metadata: MetadataType;
    skipped?: boolean;
    stopProcessing?: boolean;
}

interface ProcessPostResult {
    success: boolean;
    error?: string;
    details?: string;
    metadata?: MetadataType;
    skipped?: boolean;
}

interface CommentGuidelines {
    minLength: number;
    maxLength: number;
    maxEmojis: number;
    forbiddenPhrases: string[];
    spamPatterns: RegExp[];
    mustIncludeEmoji: boolean;
    mustAddValue: boolean;
    mustBeRelevant: boolean;
    maxPunctuation: number;
    maxCapitalizedWords: number;
    requiredElements: {
        mustIncludeEmoji: boolean;
        mustAddValue: boolean;
        mustBeRelevant: boolean;
        maxPunctuation: number;
        maxCapitalizedWords: number;
    };
}

interface BoundingBox {
    x: number;
    y: number;
    width: number;
    height: number;
}

// Helper functions
function getRandomDelay(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function waitForPostContent(page: Page, post: ElementHandle<Element>, timeout = 5000): Promise<boolean> {
    try {
        const startTime = Date.now();
        let lastError: Error | null = null;

        while (Date.now() - startTime < timeout) {
            try {
                // Check if post is visible
                const isVisible = await post.evaluate(el => {
                    const rect = el.getBoundingClientRect();
                    return rect.width > 0 && rect.height > 0;
                });

                if (!isVisible) {
                    await delay(100);
                    continue;
                }

                // Check for key elements
                const hasImage = await post.$('img');
                const hasVideo = await post.$('video');
                const hasCaption = await post.$('div[dir="auto"]');

                if (hasImage || hasVideo) {
                    // Wait for media to load
                    await post.evaluate(async el => {
                        const media = el.querySelector('img, video');
                        if (media) {
                            await new Promise<void>((resolve) => {
                                if (media instanceof HTMLImageElement && media.complete) {
                                    resolve();
                                } else if (media instanceof HTMLVideoElement && media.readyState >= 2) {
                                    resolve();
                                } else {
                                    media.addEventListener('load', () => resolve(), { once: true });
                                    media.addEventListener('loadeddata', () => resolve(), { once: true });
                                }
                            });
                        }
                    });

                    // If we have media and optionally caption, post is ready
                    return true;
                }

                await delay(100);
            } catch (error) {
                lastError = error instanceof Error ? error : new Error(String(error));
                await delay(100);
            }
        }

        if (lastError) {
            throw lastError;
        }

        return false;
    } catch (error) {
        logger.error('Error waiting for post content:', error);
        return false;
    }
}

async function getPostCaption(page: Page, post: ElementHandle<Element>): Promise<string | null> {
    try {
        // Wait for any dynamic content to load
        await delay(1000);

        // Try multiple selectors for caption
        const captionSelectors = [
            'h1', // Main caption heading
            'div[dir="auto"]', // Auto-direction text containers
            'div._a9zs', // Instagram caption class
            'div._aacl._aaco._aacu._aacx._aad7._aade', // Instagram text classes
            'span[dir="auto"]', // Auto-direction spans
            'div[role="button"] span', // Expandable text
            'div._a9zr', // Another Instagram caption class
            'div._a9zs h1._aacl._aaco._aacu._aacx._aad7._aade' // Combined selectors
        ];

        let caption = '';

        // Try each selector
        for (const selector of captionSelectors) {
            try {
                const elements = await post.$$(selector);
                for (const element of elements) {
                    const text = await element.evaluate(el => el.textContent?.trim() || '');
                    if (text && text.length > 10) { // Ignore very short texts
                        caption = text;
                        break;
                    }
                }
                if (caption) break;
            } catch (error) {
                logger.debug(`Selector ${selector} failed:`, error);
                continue;
            }
        }

        // If no caption found, try getting all text content
        if (!caption) {
            caption = await post.evaluate(el => {
                const textNodes = Array.from(el.querySelectorAll('*'))
                    .map(node => node.textContent?.trim())
                    .filter(text => text && text.length > 10)
                    .join(' ');
                return textNodes || '';
            });
        }

        // Clean up the caption
        if (caption) {
            caption = caption
                .replace(/\s+/g, ' ') // Replace multiple spaces with single space
                .replace(/[\n\r]+/g, ' ') // Replace newlines with space
                .trim();

            logger.info('Found caption:', { caption });
            return caption;
        }

        logger.warn('No caption found');
        return null;
    } catch (error) {
        logger.error('Error getting post caption:', error);
        return null;
    }
}

async function expandCaption(page: Page, post: ElementHandle<Element>): Promise<void> {
    try {
        // Try multiple selectors for "more" button
        const moreButtonSelectors = [
            'div[role="button"]',
            'button._abl- svg[aria-label="Like"]',
            'button[type="button"] svg[aria-label="Like"]',
            'span._aamw button',
            'div._aamu button',
            'button._abl-'
        ];

        for (const selector of moreButtonSelectors) {
            try {
                const moreButtons = await post.$$(selector);
                for (const button of moreButtons) {
                    const text = await button.evaluate(el => el.textContent?.toLowerCase() || '');
                    if (text.includes('more')) {
                        await button.click();
                        await delay(500);
                        return;
                    }
                }
            } catch (error) {
                logger.debug(`More button selector ${selector} failed:`, error);
                continue;
            }
        }
    } catch (error) {
        logger.warn('Error expanding caption:', error);
        // Don't throw, just continue with unexpanded caption
    }
}

async function findButton(post: ElementHandle<Element>, selectors: string[]): Promise<ElementHandle<Element> | null> {
    for (const selector of selectors) {
        try {
            const button = await post.$(selector);
            if (button) {
                const element = button.asElement();
                if (element) {
                    return element as ElementHandle<Element>;
                }
            }
        } catch (error) {
            logger.debug(`Button selector ${selector} failed:`, error);
            continue;
        }
    }
    return null;
}

async function hasAlreadyCommented(page: Page, post: ElementHandle<Element>, comment: string): Promise<boolean> {
    try {
        const username = process.env.INSTAGRAM_USERNAME;
        if (!username) {
            logger.error('Instagram username not found in environment variables');
            return false;
        }

        // Check for comments by the bot directly in the feed
        const commentSelectors = [
            `a[href="/${username}/"]`,
            `span._aacl:has-text("${username}")`,
            `div._a9zr a[href="/${username}/"]`
        ];

        for (const selector of commentSelectors) {
            try {
                logger.debug('Trying comment selector:', { selector });
                const userComments = await post.$$(selector);
                logger.debug('Found elements:', { count: userComments.length });

                if (userComments.length > 0) {
                    logger.info('Found existing comment by bot:', {
                        username,
                        selector,
                        count: userComments.length
                    });
                    return true;
                }
            } catch (error) {
                logger.debug('Error with selector:', { selector, error });
                continue;
            }
        }

        logger.info('No existing comments found from bot:', { username });
        return false;
    } catch (error) {
        logger.error('Error checking for existing comments:', error);
        return false;
    }
}

async function clickWithPrecision(page: Page, element: ElementHandle<Element>): Promise<boolean> {
    try {
        // Get the bounding box of the element
        const box = await element.boundingBox();
        if (!box) {
            logger.error('Could not get element bounding box');
            return false;
        }

        // Calculate the center point
        const x = box.x + box.width / 2;
        const y = box.y + box.height / 2;

        // Move mouse to element with a natural curve
        await page.mouse.move(x, y, {
            steps: 10 // Makes the movement more natural
        });

        // Add a small random delay before clicking
        await delay(getRandomDelay(50, 150));

        // Click the element
        await page.mouse.click(x, y);

        // Add a small delay after clicking
        await delay(getRandomDelay(50, 150));

        return true;
    } catch (error) {
        logger.error('Error clicking element:', error);
        return false;
    }
}

async function getLikeButton(post: ElementHandle<Element>, page: Page): Promise<ElementHandle<Element> | null> {
    const likeButtonSelectors = [
        'svg[aria-label="Like"]',
        'button._abl- svg[aria-label="Like"]',
        'button[type="button"] svg[aria-label="Like"]',
        'span._aamw button',
        'div._aamu button',
        'button._abl-'
    ];

    return findButton(post, likeButtonSelectors);
}

async function verifyLike(post: ElementHandle<Element>, page: Page): Promise<boolean> {
    try {
        // Find like button with "Unlike" label
        const unlikeButton = await post.$('button[type="button"] > div > span[aria-label*="Unlike"]');
        return !!unlikeButton;
    } catch (error) {
        logger.error('Error verifying like:', error);
        return false;
    }
}

async function hasAlreadyLiked(post: ElementHandle<Element>, page: Page): Promise<boolean> {
    try {
        return await verifyLike(post, page);
    } catch (error) {
        logger.error('Error checking if already liked:', error);
        return false;
    }
}

async function findPostedComment(page: Page, post: ElementHandle<Element>, comment: string): Promise<boolean> {
    try {
        // Wait for comment to appear
        await delay(1000);

        // Find all comments
        const comments = await post.$$('ul > li span');

        // Look for our comment
        for (const commentEl of comments) {
            const text = await commentEl.evaluate(el => el.textContent);
            if (text && text.includes(comment)) {
                logger.debug('Found posted comment in verification');
                return true;
            }
        }

        return false;
    } catch (error) {
        logger.error('Error finding posted comment:', error);
        return false;
    }
}

async function verifyComment(page: Page, post: ElementHandle<Element>, comment: string): Promise<boolean> {
    try {
        return await findPostedComment(page, post, comment);
    } catch (error) {
        logger.error('Error verifying comment:', error);
        return false;
    }
}

async function extractPostMetadata(post: ElementHandle<Element>, page: Page): Promise<PostMetadata | null> {
    try {
        logger.info('Starting post metadata extraction', {
            timestamp: new Date().toISOString(),
            component: 'Instagram-Core',
            event: 'metadata_extraction_start'
        });

        // Log the post element handle details
        const postExists = await post.evaluate((el) => !!el);
        logger.debug('Post element status', {
            timestamp: new Date().toISOString(),
            exists: postExists,
            component: 'Instagram-Core',
            event: 'post_element_check'
        });

        // Extract username
        const username = await extractUsername(post);
        logger.debug('Username extraction result', {
            timestamp: new Date().toISOString(),
            usernameFound: !!username,
            username: username || 'not_found',
            component: 'Instagram-Core',
            event: 'username_extraction'
        });

        // Check if post is video
        const isVideo = await isVideoPost(post);
        logger.debug('Video check result', {
            timestamp: new Date().toISOString(),
            isVideo,
            component: 'Instagram-Core',
            event: 'video_check'
        });

        // Extract caption
        const caption = await extractCaption(post, page);
        logger.debug('Caption extraction result', {
            timestamp: new Date().toISOString(),
            captionFound: !!caption,
            captionLength: caption?.length || 0,
            component: 'Instagram-Core',
            event: 'caption_extraction'
        });

        // Extract likes count
        const likes = await extractLikesCount(post);
        logger.debug('Likes count extraction result', {
            timestamp: new Date().toISOString(),
            likes,
            component: 'Instagram-Core',
            event: 'likes_extraction'
        });

        // Extract hashtags from caption
        const hashtags = extractHashtags(caption || '');
        logger.debug('Hashtags extraction result', {
            timestamp: new Date().toISOString(),
            hashtagCount: hashtags.length,
            hashtags,
            component: 'Instagram-Core',
            event: 'hashtags_extraction'
        });

        const metadata: PostMetadata = {
            type: 'post',
            timestamp: new Date(),
            success: true,
            username,
            caption: caption || '',
            isVideo,
            hashtags,
            likes
        };

        logger.info('Post metadata extraction completed', {
            timestamp: new Date().toISOString(),
            username,
            isVideo,
            hashtagCount: hashtags.length,
            likes,
            component: 'Instagram-Core',
            event: 'metadata_extraction_complete'
        });

        return metadata;
    } catch (error) {
        logger.error('Error extracting post metadata:', {
            error: error instanceof Error ? error.message : String(error),
            timestamp: new Date().toISOString(),
            component: 'Instagram-Core',
            event: 'metadata_extraction_error'
        });
        return null;
    }
}

async function generateComment(caption: string): Promise<string | null> {
    try {
        if (!caption) {
            logger.warn('No caption provided for comment generation', {
                component: 'Instagram-Core',
                event: 'comment_generation_no_caption'
            });
            return null;
        }

        logger.info('Starting comment generation', {
            component: 'Instagram-Core',
            event: 'comment_generation_start',
            captionLength: caption.length
        });

        const prompt = `Generate a simple Instagram comment for this post: "${caption}"\n\nFollow these basic rules:
        1. Length: 3-300 characters
        2. Style: Casual and friendly
        3. Content: Should relate to the post content
        4. Optional elements:
           - Emojis (0-6)
           - Punctuation marks (up to 10)
           - Capitalized words (up to 8)
        5. Avoid:
           - Follow/followback requests
           - "Check my profile" phrases`;

        logger.info('Sending request to OpenAI', {
            component: 'Instagram-Core',
            event: 'openai_request_start'
        });

        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                {
                    role: "system",
                    content: "You are a casual Instagram user who leaves simple, friendly comments. Keep comments natural and related to the post content."
                },
                {
                    role: "user",
                    content: prompt
                }
            ],
            max_tokens: 60,
            temperature: 0.7
        });

        const comment = completion.choices[0]?.message?.content?.trim();

        if (!comment) {
            logger.warn('OpenAI did not generate a comment', {
                component: 'Instagram-Core',
                event: 'openai_no_comment'
            });
            return null;
        }

        logger.info('Generated comment from OpenAI', {
            component: 'Instagram-Core',
            event: 'comment_generation_success',
            commentLength: comment.length
        });

        // Validate the generated comment
        const isValid = await validateComment(comment);
        if (!isValid) {
            logger.warn('Generated comment failed validation', {
                component: 'Instagram-Core',
                event: 'comment_validation_failed',
                comment
            });
            return null;
        }

        logger.info('Comment passed validation', {
            component: 'Instagram-Core',
            event: 'comment_validation_success',
            comment
        });

        return comment;
    } catch (error) {
        logger.error('Error generating comment:', {
            error: error instanceof Error ? error.message : String(error),
            component: 'Instagram-Core',
            event: 'comment_generation_error'
        });
        return null;
    }
}

async function clickExactCenter(page: Page, element: ElementHandle<Element>): Promise<boolean> {
    try {
        // Calculate exact center coordinates
        const box = await element.boundingBox();
        if (!box) {
            logger.error('Failed to get element bounding box', {
                component: 'Instagram-Core',
                event: 'click_exact_center_error'
            });
            return false;
        }

        const centerX = box.x + (box.width / 2);
        const centerY = box.y + (box.height / 2);

        // Move mouse in small steps
        await page.mouse.move(centerX, centerY, { steps: 10 });
        await delay(100);

        // Click sequence
        await page.mouse.down();
        await delay(100);
        await page.mouse.up();

        return true;
    } catch (error) {
        logger.error('Error during exact center click:', {
            error: error instanceof Error ? error.message : String(error),
            component: 'Instagram-Core',
            event: 'click_exact_center_error'
        });
        return false;
    }
}

export async function postComment(post: ElementHandle<Element>, page: Page, comment: string, isModerationExecution = false): Promise<{ success: boolean; error?: string; metadata?: any }> {
    try {
        logger.info('Starting comment operation', {
            component: 'Instagram-Core',
            event: 'comment_operation_start'
        });

        // Scroll post into view and wait for it to stabilize
        await post.evaluate((el: Element) => {
            (el as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'center' });
        });
        await delay(1500);

        // Find comment box using multiple selectors (support different ellipsis variants)
        const commentSelectors = [
            'textarea[aria-label="Add a comment…"]',            // unicode ellipsis
            'textarea[placeholder="Add a comment…"]',           // unicode ellipsis
            'textarea[placeholder="Add a comment..."]',         // three dots
            'textarea[aria-label*="comment"]',
            'form textarea'
        ];

        let commentBox: ElementHandle<Element> | null = null;
        for (const selector of commentSelectors) {
            logger.info(`[detect] comment box via ${selector}`);
            const found = await post.$(selector);
            if (found) {
                logger.info(`[detect] ${selector} ✅`);
                if (isModerationExecution) console.log('✅ Found comment box field');
                commentBox = found;
                break;
            } else {
                logger.info(`[detect] ${selector} ❌`);
            }
        }

        // If not found, try opening the composer by clicking the comment icon
        if (!commentBox) {
            logger.info('[detect] Trying comment icon to open composer');
            const commentIcon = await post.$('svg[aria-label="Comment"]');
            if (commentIcon) {
                logger.info('[detect] comment icon found ✅');
                try {
                    await commentIcon.click();
                    await delay(700);
                    logger.info('[action] clicked comment icon ✅');
                } catch (e) {
                    logger.warn('[action] click comment icon failed ❌');
                }
                for (const selector of commentSelectors) {
                    logger.info(`[detect] comment box via ${selector} (after icon)`);
                    const found = await post.$(selector);
                    if (found) {
                        logger.info(`[detect] ${selector} ✅`);
                        if (isModerationExecution) console.log('✅ Found comment box field after clicking comment icon');
                        commentBox = found;
                        break;
                    } else {
                        logger.info(`[detect] ${selector} ❌`);
                    }
                }
            } else {
                logger.info('[detect] comment icon not found ❌');
            }
        }

        // Fallback to contenteditable composer
        if (!commentBox) {
            logger.info('[detect] trying contenteditable composer fallback');
            commentBox = await post.$('div[contenteditable="true"][role="textbox"]');
            logger.info(`[detect] contenteditable composer ${commentBox ? '✅' : '❌'}`);
            if (commentBox && isModerationExecution) {
                console.log('✅ Found comment box field (contenteditable fallback)');
            }
        }

        // Locale-specific keyword scan for comment fields
        if (!commentBox) {
            const commentKeywords = [
                'comment', 'comentario', 'comentários', 'commentaire', 'kommentar', 'commento',
                'коммент', 'تعليق', 'yorum', 'コメント', '評論', '评论', '댓글', 'komentar'
            ];
            logger.info('[detect] locale keyword scan for comment field');
            const candidates = await post.$$('textarea, form textarea, div[contenteditable="true"][role="textbox"], [role="textbox"][contenteditable="true"]');
            for (const el of candidates) {
                try {
                    const label = (await el.evaluate((node: Element) => {
                        const a = node.getAttribute('aria-label') || '';
                        const p = (node as any).getAttribute?.('placeholder') || '';
                        const t = (node.textContent || '');
                        return `${a} ${p} ${t}`.toLowerCase();
                    })) as string;
                    const matched = commentKeywords.some(k => label.includes(k));
                    logger.info(`[detect] locale scan label="${label.slice(0, 80)}" ${matched ? '✅' : '❌'}`);
                    if (matched) {
                        if (isModerationExecution) console.log('✅ Found comment box field (locale keyword scan)');
                        commentBox = el;
                        break;
                    }
                } catch { }
            }
        }

        if (!commentBox) {
            // Inspect page text to identify likely restriction
            const bodyText = (await page.evaluate(() => document.body.innerText)).toLowerCase();
            if (bodyText.includes('comments on this post have been limited')) {
                throw new Error('comment_limited');
            }
            if (bodyText.includes('only followers can comment')) {
                throw new Error('followers_only');
            }
            if (bodyText.includes('commenting has been turned off')) {
                throw new Error('commenting_turned_off');
            }
            throw new Error('Comment box not found with any selector');
        }

        // Focus the comment box
        logger.info('[comment] focusing composer');
        await commentBox.focus();
        await delay(500);
        logger.info('[comment] composer focused ✅');

        // Clear any existing text (works for both textarea and contenteditable)
        logger.info('[comment] clearing composer');
        await page.keyboard.down('Control');
        await page.keyboard.press('A');
        await page.keyboard.up('Control');
        await page.keyboard.press('Backspace');
        await delay(400);
        logger.info('[comment] composer cleared ✅');

        // Type comment with human-like delays
        logger.info(`[comment] typing ${comment.length} chars`);
        if (isModerationExecution) console.log(`⌨️ Typing message: "${comment}"`);
        const tType = Date.now();
        for (const char of comment) {
            await page.keyboard.type(char, { delay: Math.random() * 100 + 30 });
        }
        await delay(500);
        logger.info(`[comment] typing complete in ${Date.now() - tType}ms ✅`);
        if (isModerationExecution) console.log('✅ Message typed successfully');

        // Try multiple methods to submit the comment
        const methodStartTime = Date.now();
        let successfulMethod: string | null = null;
        let methodAttempts: Array<{ method: string, success: boolean, time_ms: number, error?: string }> = [];

        const submitMethods = [
            // Method 1: Press Enter key
            async () => {
                const attemptStart = Date.now();
                const methodName = 'enter_key';
                try {
                    logger.info('[submit] method 1: press Enter');
                    if (isModerationExecution) console.log('🔍 Looking for Enter key to submit');
                    await page.keyboard.press('Enter');
                    if (isModerationExecution) console.log('✅ Pressed Enter key');
                    const attemptTime = Date.now() - attemptStart;
                    methodAttempts.push({ method: methodName, success: true, time_ms: attemptTime });
                    successfulMethod = methodName;
                    return true;
                } catch (error) {
                    const attemptTime = Date.now() - attemptStart;
                    methodAttempts.push({ method: methodName, success: false, time_ms: attemptTime, error: error instanceof Error ? error.message : String(error) });
                    return false;
                }
            },
            // Method 2: Click Post button
            async () => {
                const attemptStart = Date.now();
                const methodName = 'submit_button';
                try {
                    logger.info('[submit] method 2: click button[type="submit"]');
                    if (isModerationExecution) console.log('🔍 Looking for submit button');
                    const postButton = await post.$('button[type="submit"]');
                    if (postButton) {
                        if (isModerationExecution) console.log('✅ Found submit button');
                        await postButton.click();
                        logger.info('[submit] method 2 invoked ✅');
                        if (isModerationExecution) console.log('✅ Clicked submit button');
                        const attemptTime = Date.now() - attemptStart;
                        methodAttempts.push({ method: methodName, success: true, time_ms: attemptTime });
                        successfulMethod = methodName;
                        return true;
                    }
                    logger.info('[submit] method 2 not found ❌');
                    if (isModerationExecution) console.log('❌ Submit button not found');
                    const attemptTime = Date.now() - attemptStart;
                    methodAttempts.push({ method: methodName, success: false, time_ms: attemptTime, error: 'Button not found' });
                    return false;
                } catch (error) {
                    const attemptTime = Date.now() - attemptStart;
                    methodAttempts.push({ method: methodName, success: false, time_ms: attemptTime, error: error instanceof Error ? error.message : String(error) });
                    return false;
                }
            },
            // Method 3: Use form submission
            async () => {
                const attemptStart = Date.now();
                const methodName = 'form_dispatch';
                try {
                    logger.info('[submit] method 3: dispatch form submit');
                    if (isModerationExecution) console.log('🔍 Looking for form to submit');
                    const form = await post.$('form');
                    if (form) {
                        if (isModerationExecution) console.log('✅ Found form element');
                        await form.evaluate((f: HTMLFormElement) => {
                            const submitEvent = new Event('submit', { bubbles: true });
                            f.dispatchEvent(submitEvent);
                        });
                        logger.info('[submit] method 3 invoked ✅');
                        if (isModerationExecution) console.log('✅ Dispatched form submit event');
                        const attemptTime = Date.now() - attemptStart;
                        methodAttempts.push({ method: methodName, success: true, time_ms: attemptTime });
                        successfulMethod = methodName;
                        return true;
                    }
                    logger.info('[submit] method 3 not found ❌');
                    if (isModerationExecution) console.log('❌ Form element not found');
                    const attemptTime = Date.now() - attemptStart;
                    methodAttempts.push({ method: methodName, success: false, time_ms: attemptTime, error: 'Form not found' });
                    return false;
                } catch (error) {
                    const attemptTime = Date.now() - attemptStart;
                    methodAttempts.push({ method: methodName, success: false, time_ms: attemptTime, error: error instanceof Error ? error.message : String(error) });
                    return false;
                }
            },
            // Method 4: Click role button with visible text (e.g., "Post")
            async () => {
                logger.info('[submit] method 4: click role button by text');
                if (isModerationExecution) console.log('🔍 Looking for role=button with visible label (e.g., "Post")');
                const candidateSelectors = [
                    'div[role="button"]',
                    'button[role="button"]',
                    'form div[role="button"]',
                    'form button:not([type])'
                ];
                const labels = [
                    // English
                    'post', 'send',
                    // French
                    'publier', 'envoyer',
                    // Spanish / Portuguese
                    'publicar', 'enviar', 'postar',
                    // Italian
                    'pubblica',
                    // German
                    'veröffentlichen', 'senden',
                    // Turkish
                    'gönder',
                    // Japanese
                    '投稿',
                    // Korean
                    '게시', '보내기',
                    // Chinese (Simplified)
                    '发布', '发表', '发送',
                    // Vietnamese
                    'gửi'
                ];
                for (const sel of candidateSelectors) {
                    const nodes = await post.$$(sel);
                    for (const n of nodes) {
                        try {
                            const text = (await n.evaluate(el => (el.textContent || '').trim().toLowerCase())) as string;
                            if (labels.some(l => text === l || text.includes(l))) {
                                await n.click();
                                logger.info('[submit] method 4 invoked ✅');
                                if (isModerationExecution) console.log(`✅ Clicked role button: "${text}"`);
                                return true;
                            }
                        } catch { }
                    }
                }
                logger.info('[submit] method 4 not found ❌');
                if (isModerationExecution) console.log('❌ Role button with visible label not found');
                return false;
            }
        ];

        // Try each submit method until one works
        let submitted = false;
        for (const method of submitMethods) {
            try {
                submitted = await method();
                if (submitted) break;
            } catch (error) {
                logger.warn('Submit method failed, trying next method', {
                    error: error instanceof Error ? error.message : String(error),
                    component: 'Instagram-Core',
                    event: 'comment_submit_retry'
                });
                continue;
            }
        }

        if (!submitted) {
            const totalTime = Date.now() - methodStartTime;
            logger.error('All comment methods failed', {
                totalAttempts: methodAttempts.length,
                totalTime,
                attempts: methodAttempts
            });
            throw new Error('Failed to submit comment with any method');
        }

        const totalSubmitTime = Date.now() - methodStartTime;
        logger.info('Comment submitted successfully', {
            method: successfulMethod,
            totalTime: totalSubmitTime,
            attempts: methodAttempts
        });

        // Wait for comment to be processed
        await delay(2000);

        // Verify comment was posted successfully
        const verificationMethods: Array<() => Promise<boolean>> = [
            // Method 1: Check if comment box is empty (textarea or contenteditable)
            async () => {
                try {
                    const isEmpty = await commentBox?.evaluate((el) => {
                        const ta = el as HTMLTextAreaElement;
                        const ce = el as HTMLElement;
                        const isCE = ce.getAttribute('contenteditable') === 'true';
                        if (isCE) return (ce.textContent || '').trim() === '';
                        return (ta.value || '').trim() === '';
                    });
                    return !!isEmpty;
                } catch { return false; }
            },
            // Method 2: Look for the comment text within the post container
            async () => {
                try {
                    const found = await post.evaluate((el, c) => {
                        const text = (el as HTMLElement).innerText || '';
                        return text.includes(c as string);
                    }, comment);
                    return !!found;
                } catch { return false; }
            },
            // Method 3: Ensure no obvious error banners are present on the page
            async () => {
                try {
                    const body = await page.evaluate(() => document.body.innerText.toLowerCase());
                    const hasError = [
                        "couldn't post",
                        'try again',
                        'action blocked',
                        'comments on this post have been limited',
                        'only followers can comment',
                        'commenting has been turned off'
                    ].some(t => body.includes(t));
                    return !hasError;
                } catch { return true; }
            }
        ];

        // Try each verification method
        if (isModerationExecution) console.log('🔍 Verifying comment was posted...');
        for (let i = 0; i < verificationMethods.length; i++) {
            try {
                const ok = await verificationMethods[i]();
                logger.info(`[verify] comment method ${i + 1} ${ok ? '✅' : '❌'}`);
                if (ok) {
                    logger.info('Comment posted successfully', {
                        component: 'Instagram-Core',
                        event: 'comment_operation_success'
                    });
                    if (isModerationExecution) console.log('✅ Comment verified - successfully posted!');
                    // Return success with method tracking metadata
                    return {
                        success: true,
                        metadata: {
                            comment_method: successfulMethod,
                            comment_method_attempt_time_ms: totalSubmitTime,
                            comment_method_attempts: methodAttempts
                        }
                    };
                }
            } catch { }
        }
        if (isModerationExecution) console.log('❌ Comment verification failed');

        // Provide more descriptive error hints if we failed to verify
        const hint = await page.evaluate(() => document.body.innerText.toLowerCase());
        if (hint.includes('action blocked')) throw new Error('action_blocked');
        if (hint.includes("couldn't post") || hint.includes('could not post')) throw new Error('post_failed');
        if (hint.includes('comments on this post have been limited')) throw new Error('comment_limited');
        if (hint.includes('only followers can comment')) throw new Error('followers_only');
        if (hint.includes('commenting has been turned off')) throw new Error('commenting_turned_off');
        throw new Error('Could not verify comment was posted');
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error('Error during comment operation:', {
            error: errorMessage,
            component: 'Instagram-Core',
            event: 'comment_operation_error'
        });
        return { success: false, error: errorMessage };
    }
}

async function processPostWithRetry(post: ElementHandle<Element>, page: Page, trace?: any, index?: number, retryCount = 0): Promise<ProcessPostResult> {
    let retryCountLocal = 0;
    const tStart = Date.now();
    const maxRetries = 3;
    while (retryCountLocal < maxRetries) {
        try {
            logger.info('Starting post processing', {
                component: 'Instagram-Core',
                event: 'post_processing_start',
                retryCount: retryCountLocal
            });

            // Extract post metadata
            const metadata = await extractPostMetadata(post, page);
            if (!metadata) {
                throw new Error('Failed to extract post metadata');
            }

            // Extract permalink and capture screenshot as artifact when tracing is enabled
            let permalink: string | null = null;
            try {
                permalink = await extractPermalink(post);
            } catch { }

            if (trace && trace.runId) {
                try {
                    const dir = path.join(process.cwd(), 'artifacts', trace.runId);
                    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                    const fileName = `post_${index ?? 'x'}_${Date.now()}.png`;
                    const filePath = path.join(dir, fileName);
                    await (post as any).screenshot({ path: filePath });
                    trace.links = trace.links || {};
                    trace.links.artifacts = [...(trace.links.artifacts || []), { title: `Post ${index ?? ''} Screenshot`, url: artifact(trace.runId, fileName) }];
                    pushStep(trace, { name: 'post_scanned', status: 'ok', notes: JSON.stringify({ index, username: metadata.username, permalink, screenshot: fileName, captionLen: metadata.caption?.length || 0 }) });
                    await saveTrace(trace);
                } catch (e) {
                    try { pushStep(trace, { name: 'post_scan_failed', status: 'warn', notes: (e as Error)?.message }); await saveTrace(trace); } catch { }
                }
            }

            // Load account preferences for quality gating
            const botUsername = (trace?.target?.username as string) || process.env.INSTAGRAM_BOT_USERNAME || undefined;
            let prefs: any = {};
            try {
                if (botUsername) {
                    const acc = await AccountModel.findOne({ platform: 'instagram', username: botUsername }).lean();
                    prefs = (acc as any)?.preferences || {};
                }
            } catch { }

            // Compute quality scores
            const quality = computeQualityScores(metadata.caption || '', metadata.username || '', prefs);
            logger.info('Quality assessment', {
                component: 'Instagram-Core',
                event: 'quality_assessment',
                brandFit: quality.brandFit,
                audienceFit: quality.audienceFit,
                competitor: quality.competitor
            });

            // Gating: competitor disallowed
            if (quality.competitor && prefs?.allowCompetitor === false) {
                logger.info('Skipping post due to competitor disallowed by preferences', { component: 'Instagram-Core', event: 'skip_competitor' });
                return {
                    success: true,
                    skipped: true,
                    details: 'competitor_disallowed',
                    metadata: {
                        type: 'post',
                        timestamp: new Date(),
                        username: metadata.username,
                        caption: metadata.caption,
                        isVideo: metadata.isVideo,
                        hashtags: metadata.hashtags,
                        likes: metadata.likes,
                        success: true,
                        quality
                    } as PostMetadata
                };
            }

            // Check if already interacted
            const hasCommented = await hasAlreadyCommented(page, post, '');
            if (hasCommented) {
                return {
                    success: true,
                    skipped: true,
                    details: 'Already commented on this post',
                    metadata: ({
                        type: 'post',
                        timestamp: new Date(),
                        username: metadata.username,
                        caption: metadata.caption,
                        isVideo: metadata.isVideo,
                        hashtags: metadata.hashtags,
                        likes: metadata.likes,
                        success: true,
                        quality
                    } as any) as PostMetadata
                };
            }

            // Try to like the post
            const likeResult = await likePost(post, page);
            if (!likeResult) {
                throw new Error('Failed to like post');
            }

            // Enforce min quality for auto-post path; always allow queue-for-review path with scores attached
            const minQ = typeof prefs?.minQualityScore === 'number' ? prefs.minQualityScore : 0;

            // Generate and post comment if caption exists
            if (metadata.caption) {
                const comment = await generateComment(metadata.caption);
                if (!comment) {
                    throw new Error('Failed to generate comment');
                }

                // If HITL review mode is enabled (per-account), queue for moderation instead of auto-posting
                const { enabled: reviewEnabled, accountId: resolvedAccountId } = await isReviewEnabledForAccount(botUsername);
                if (reviewEnabled) {
                    try {
                        const accountId = resolvedAccountId || process.env.HITL_ACCOUNT_ID || process.env.INSTAGRAM_BOT_USERNAME || metadata.username || 'unknown';
                        await createProposedInteraction({
                            accountId,
                            type: 'comment',
                            target: { username: metadata.username, permalink },
                            proposed: { text: comment },
                            requiresReview: true,
                            scores: { brandFit: quality.brandFit, audienceFit: quality.audienceFit, competitor: quality.competitor }
                        });
                    } catch (e) {
                        logger.error('Error creating proposed interaction for review mode', {
                            error: e instanceof Error ? e.message : String(e),
                            component: 'Instagram-Core',
                            event: 'hitl_propose_error'
                        });
                        if (trace) { try { pushStep(trace, { name: 'propose_failed', status: 'warn', notes: e instanceof Error ? e.message : String(e) }); await saveTrace(trace); } catch { } }
                    }

                    if (trace) {
                        try {
                            pushStep(trace, { name: 'proposed_for_review', status: 'ok', notes: JSON.stringify({ index, username: metadata.username, permalink, comment }) });
                            await saveTrace(trace);
                        } catch { }
                    }

                    return {
                        success: true,
                        skipped: true,
                        details: 'queued_for_review',
                        metadata: {
                            type: 'post',
                            timestamp: new Date(),
                            username: metadata.username,
                            caption: metadata.caption,
                            isVideo: metadata.isVideo,
                            hashtags: metadata.hashtags,
                            likes: metadata.likes,
                            success: true,
                            quality
                        } as PostMetadata
                    };
                }

                // Auto-post path: respect minQualityScore if configured
                if (minQ > 0 && Math.max(quality.brandFit, quality.audienceFit) < minQ) {
                    logger.info('Skipping auto-post due to quality below threshold', { component: 'Instagram-Core', event: 'skip_low_quality', minQ, brandFit: quality.brandFit, audienceFit: quality.audienceFit });
                    return {
                        success: true,
                        skipped: true,
                        details: 'below_quality_threshold',
                        metadata: ({
                            type: 'post',
                            timestamp: new Date(),
                            username: metadata.username,
                            caption: metadata.caption,
                            isVideo: metadata.isVideo,
                            hashtags: metadata.hashtags,
                            likes: metadata.likes,
                            success: true,
                            quality
                        } as any) as PostMetadata
                    };
                }

                const commentResult = await postComment(post, page, comment);
                if (!commentResult.success) {
                    throw new Error(`Failed to post comment: ${commentResult.error}`);
                }

                // Trace the comment action if available
                if (trace) {
                    try {
                        pushStep(trace, { name: 'comment_posted', status: 'ok', notes: JSON.stringify({ index, username: metadata.username, permalink, comment }) });
                        await saveTrace(trace);
                    } catch { }
                }

                // Record in analytics history for limits/insights
                try {
                    await InteractionHistoryService.recordInteraction({
                        runId: trace?.runId || `process_${Date.now()}`,
                        accountId: resolvedAccountId || botUsername || 'unknown',
                        interactionType: 'comment',
                        targetUser: metadata.username,
                        targetPost: permalink || undefined,
                        content: comment,
                        responseStyle: undefined,
                        success: true,
                        responseTime: Date.now() - tStart
                    })
                } catch { }
            }

            logger.info('Post processing completed successfully', {
                component: 'Instagram-Core',
                event: 'post_processing_success'
            });

            return {
                success: true,
                skipped: false,
                details: 'Successfully processed post',
                metadata: ({
                    type: 'post',
                    timestamp: new Date(),
                    username: metadata.username,
                    caption: metadata.caption,
                    isVideo: metadata.isVideo,
                    hashtags: metadata.hashtags,
                    likes: metadata.likes,
                    success: true,
                    quality
                } as any) as PostMetadata
            };

        } catch (error) {
            logger.error('Error during post processing', {
                error: error instanceof Error ? error.message : String(error),
                component: 'Instagram-Core',
                event: 'post_processing_error',
                retryCount: retryCountLocal
            });

            retryCountLocal++;
            if (retryCountLocal < maxRetries) {
                logger.info('Retrying post processing', {
                    component: 'Instagram-Core',
                    event: 'post_processing_retry',
                    retryCount: retryCountLocal
                });
                await delay(getRandomDelay(2000, 4000));
            }
        }
    }

    return {
        success: false,
        error: `Failed to process post after ${maxRetries} retries`,
        details: 'Max retries exceeded',
        metadata: {
            type: 'error',
            timestamp: new Date(),
            error: 'Max retries exceeded'
        } as ErrorMetadata
    };
}

export async function initStorage(): Promise<void> {
    try {
        // Default to Supabase for now, can be extended to support multiple backends
        storage = new SupabaseStorage();
        await storage.connect();
        logger.info('Storage initialized');
    } catch (error) {
        logger.error('Error initializing storage:', error);
        throw error;
    }
}

// Export all necessary functions and types
export async function processPosts(posts: ElementHandle<Element>[], page: Page, trace?: any): Promise<void> {
    try {
        logger.info('Starting batch post processing', {
            timestamp: new Date().toISOString(),
            postCount: posts.length,
            component: 'Instagram-Core',
            event: 'batch_processing_start'
        });

        let i = 0;
        const botActor = (trace?.target?.username as string) || process.env.INSTAGRAM_BOT_USERNAME || 'unknown';
        for (const post of posts) {
            try {
                const result = await processPostWithRetry(post, page, trace, i);
                logger.info('Post processing result:', {
                    timestamp: new Date().toISOString(),
                    success: result.success,
                    error: result.error,
                    component: 'Instagram-Core',
                    event: 'post_processing_result'
                });

                if (result.metadata) {
                    const interaction: BotInteraction = {
                        timestamp: new Date(),
                        type: result.metadata.type as 'comment' | 'like',
                        success: result.success,
                        error: result.error,
                        details: result.details || '',
                        actor: botActor,
                        metadata: result.metadata
                    };
                    await saveInteractionToDb(interaction);
                }

                // Add delay between posts
                await delay(getRandomDelay(2000, 4000));
                i++;
            } catch (error) {
                logger.error('Error processing post:', {
                    error: error instanceof Error ? error.message : String(error),
                    timestamp: new Date().toISOString(),
                    component: 'Instagram-Core',
                    event: 'post_processing_error'
                });
            }
        }

        logger.info('Completed batch post processing', {
            timestamp: new Date().toISOString(),
            postCount: posts.length,
            component: 'Instagram-Core',
            event: 'batch_processing_complete'
        });
    } catch (error) {
        logger.error('Error in batch post processing:', {
            error: error instanceof Error ? error.message : String(error),
            timestamp: new Date().toISOString(),
            component: 'Instagram-Core',
            event: 'batch_processing_error'
        });
    }
}

export {
    PostMetadata,
    InteractionResult,
    CommentMetadata,
    LikeMetadata,
    ErrorMetadata,
    BotInteraction,
    MetadataType,
    ProcessPostResult,
    generateComment,
    validateComment,
    likePost,
    processPostWithRetry,
    saveInteractionToDb,
    extractPostMetadata,
    extractHashtags,
    hasAlreadyLiked,
    hasAlreadyCommented,
    getRandomDelay,
    DEFAULT_COMMENT_GUIDELINES,
    clickWithPrecision,
    verifyComment
};

async function extractUsername(post: ElementHandle<Element>): Promise<string> {
    try {
        const username = await post.evaluate(el => {
            const userLink = el.querySelector('a[href*="/"]');
            return userLink ? userLink.getAttribute('href')?.replace('/', '') || '' : '';
        });
        return username || '';
    } catch (error) {
        logger.error('Error extracting username', {
            error: error instanceof Error ? error.message : String(error),
            component: 'Instagram-Core',
            event: 'username_extraction_error'
        });
        return '';
    }
}

async function extractCaption(post: ElementHandle<Element>, page: Page): Promise<string> {
    try {
        // Get HTML content of the post
        const html = await post.evaluate(el => el.outerHTML);
        const $ = cheerio.load(html);

        // Try multiple methods to extract caption
        const captionMethods = [
            // Method 1: Using article text content
            () => {
                const articleText = $('article').text();
                if (articleText) {
                    const textParts = articleText.split('\n').filter(part => part.trim().length > 0);
                    if (textParts.length > 0) {
                        return textParts[0].trim();
                    }
                }
                return null;
            },
            // Method 2: Using specific class selectors
            () => {
                const caption = $('div._a9zs').text() ||
                    $('h1._aacl').text() ||
                    $('div[data-testid="post-content"] > div > span').text();
                return caption ? caption.trim() : null;
            },
            // Method 3: Using role attributes
            () => {
                const menuText = $('div[role="menuitem"]').text();
                return menuText ? menuText.trim() : null;
            }
        ];

        // Try each method
        for (const method of captionMethods) {
            try {
                const caption = method();
                if (caption) {
                    logger.debug('Caption extracted successfully', {
                        length: caption.length,
                        component: 'Instagram-Core',
                        event: 'caption_extraction_success'
                    });
                    return caption;
                }
            } catch (error) {
                continue;
            }
        }

        // If no caption found, try to expand and retry
        try {
            const moreButton = await post.$('div[role="button"]:has-text("more")');
            if (moreButton) {
                await moreButton.click();
                await delay(1000);

                // Get updated HTML after expansion
                const expandedHtml = await post.evaluate(el => el.outerHTML);
                const $expanded = cheerio.load(expandedHtml);

                // Try methods again with expanded content
                for (const method of captionMethods) {
                    try {
                        const caption = method();
                        if (caption) {
                            logger.debug('Caption extracted after expansion', {
                                length: caption.length,
                                component: 'Instagram-Core',
                                event: 'caption_extraction_expanded_success'
                            });
                            return caption;
                        }
                    } catch (error) {
                        continue;
                    }
                }
            }
        } catch (error) {
            logger.debug('Failed to expand caption:', {
                error: error instanceof Error ? error.message : String(error),
                component: 'Instagram-Core',
                event: 'caption_expansion_failed'
            });
        }

        logger.warn('No caption found with any method', {
            component: 'Instagram-Core',
            event: 'caption_extraction_all_failed'
        });
        return '';
    } catch (error) {
        logger.error('Error extracting caption:', {
            error: error instanceof Error ? error.message : String(error),
            component: 'Instagram-Core',
            event: 'caption_extraction_error'
        });
        return '';
    }
}

async function isVideoPost(post: ElementHandle<Element>): Promise<boolean> {
    try {
        return await post.evaluate(el => {
            return !!el.querySelector('video') || !!el.querySelector('[aria-label*="Video"]');
        });
    } catch (error) {
        logger.error('Error checking if post is video', {
            error: error instanceof Error ? error.message : String(error),
            component: 'Instagram-Core',
            event: 'video_check_error'
        });
        return false;
    }
}

async function extractLikesCount(post: ElementHandle<Element>): Promise<number> {
    try {
        return await post.evaluate(el => {
            const likeText = el.querySelector('section span')?.textContent;
            if (likeText) {
                const match = likeText.match(/\d+/);
                return match ? parseInt(match[0]) : 0;
            }
            return 0;
        });
    } catch (error) {
        logger.error('Error extracting likes count', {
            error: error instanceof Error ? error.message : String(error),
            component: 'Instagram-Core',
            event: 'likes_count_error'
        });
        return 0;
    }
}

async function findCommentInput(post: ElementHandle<Element>): Promise<ElementHandle<Element> | null> {
    const inputSelectors = [
        'textarea[aria-label="Add a comment…"]',
        'textarea[placeholder="Add a comment…"]',
        'textarea._ablz._aaoc',
        'form.x1i10hfl textarea'
    ];

    return findButton(post, inputSelectors);
}

async function findPostButton(post: ElementHandle<Element>): Promise<ElementHandle<Element> | null> {
    const buttonSelectors = [
        'button[type="submit"]',
        'button._acan._acap._acas',
        'button._acan._acap._acas._aj1-',
        'button[role="menuitem"]',
        'div[role="button"]'
    ];

    return findButton(post, buttonSelectors);
}

async function getLikeButtonBoundingBox(post: ElementHandle<Element>): Promise<BoundingBox | null> {
    try {
        const likeButton = await post.$('button[type="button"] > div > span[aria-label*="Like"]');
        if (!likeButton) {
            return null;
        }

        const box = await likeButton.boundingBox();
        if (!box) {
            return null;
        }

        return {
            x: box.x,
            y: box.y,
            width: box.width,
            height: box.height
        };
    } catch (error) {
        logger.error('Error getting like button bounding box:', error);
        return null;
    }
}

async function likePost(post: ElementHandle<Element>, page: Page): Promise<boolean> {
    try {
        logger.info('Starting like operation', {
            component: 'Instagram-Core',
            event: 'like_operation_start'
        });

        // Try multiple strategies to find a like control
        const likeSelectors = [
            'svg[aria-label="Like"]',
            'button[aria-label="Like"]',
            'button[type="button"] svg[aria-label="Like"]',
            'div[role="button"] svg[aria-label="Like"]',
            'svg[aria-label*="Like"]',
            // Older/variant DOMs
            'button._abl- svg[aria-label="Like"]',
        ];

        let likeEl: ElementHandle<Element> | null = null;
        for (const sel of likeSelectors) {
            logger.info(`[detect] like via ${sel}`);
            const found = await post.$(sel);
            if (found) {
                logger.info(`[detect] ${sel} ✅`);
                likeEl = found;
                break;
            } else {
                logger.info(`[detect] ${sel} ❌`);
            }
        }

        if (!likeEl) {
            logger.warn('Like button not found', { component: 'Instagram-Core', event: 'like_button_not_found' });
            return false;
        }

        // Scroll post into view
        await post.evaluate(el => {
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        });
        await delay(1000);

        // Attempt click patterns with logging
        try {
            await likeEl.click({ delay: 20 });
            logger.info('[action] likeEl.click() ✅');
        } catch (e) {
            logger.warn('[action] likeEl.click() ❌, trying JS dispatch');
            try {
                await (likeEl as ElementHandle<Element>).evaluate((node: Element) => {
                    node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
                });
                logger.info('[action] JS dispatch click ✅');
            } catch {
                logger.warn('[action] JS dispatch click ❌');
            }
        }

        // Wait for like to register
        await delay(2000);

        // Verify like was successful using multiple methods
        const verificationMethods = [
            // Method 1: Check for Unlike text
            async () => {
                const html = await post.evaluate(el => el.outerHTML);
                const $ = cheerio.load(html);
                return $('[aria-label*="unlike" i]').length > 0;
            },
            // Method 2: Check for liked state
            async () => {
                const html = await post.evaluate(el => el.outerHTML);
                const $ = cheerio.load(html);
                return $('[aria-pressed="true"]').length > 0;
            },
            // Method 3: Check for visual indicators
            async () => {
                const html = await post.evaluate(el => el.outerHTML);
                const $ = cheerio.load(html);
                return $('svg[fill="#ff3040"]').length > 0 || // Red heart color
                    $('svg[color="#ff3040"]').length > 0;
            },
            // Method 4: Check for Unlike button
            async () => {
                const unlikeButton = await post.$('svg[aria-label="Unlike"]');
                return !!unlikeButton;
            }
        ];

        // Try each verification method
        for (let i = 0; i < verificationMethods.length; i++) {
            try {
                const ok = await verificationMethods[i]();
                logger.info(`[verify] like method ${i + 1} ${ok ? '✅' : '❌'}`);
                if (ok) {
                    logger.info('Like operation successful', { component: 'Instagram-Core', event: 'like_operation_success' });
                    return true;
                }
            } catch { }
        }

        logger.warn('Like operation failed - could not verify like', {
            component: 'Instagram-Core',
            event: 'like_operation_verify_failed'
        });
        return false;

    } catch (error) {
        logger.error('Error during like operation:', {
            error: error instanceof Error ? error.message : String(error),
            component: 'Instagram-Core',
            event: 'like_operation_error'
        });
        return false;
    }
}

const DEFAULT_COMMENT_GUIDELINES: CommentGuidelines = {
    minLength: 3,
    maxLength: 300,
    maxEmojis: 6,
    forbiddenPhrases: [],
    spamPatterns: [
        /\b(follow|f4f|l4l)\b/i,
        /\b(check|visit)\s+(my)\s+(profile)\b/i
    ],
    mustIncludeEmoji: false,
    mustAddValue: false,
    mustBeRelevant: true,
    maxPunctuation: 10,
    maxCapitalizedWords: 8,
    requiredElements: {
        mustIncludeEmoji: false,
        mustAddValue: false,
        mustBeRelevant: true,
        maxPunctuation: 10,
        maxCapitalizedWords: 8
    }
};

function extractHashtags(caption: string): string[] {
    if (!caption) {
        logger.info('No caption provided for hashtag extraction', {
            component: 'Instagram-Core',
            event: 'hashtag_extraction_empty'
        });
        return [];
    }

    try {
        logger.info('Extracting hashtags from caption', {
            component: 'Instagram-Core',
            event: 'hashtag_extraction_start',
            captionLength: caption.length
        });

        const hashtags = caption.match(/#[\w]+/g) || [];

        logger.info('Hashtag extraction complete', {
            component: 'Instagram-Core',
            event: 'hashtag_extraction_success',
            hashtagCount: hashtags.length,
            hashtags
        });

        return hashtags;
    } catch (error) {
        logger.error('Error extracting hashtags:', {
            error: error instanceof Error ? error.message : String(error),
            component: 'Instagram-Core',
            event: 'hashtag_extraction_error'
        });
        return [];
    }
}

async function validateComment(comment: string, guidelines: CommentGuidelines = DEFAULT_COMMENT_GUIDELINES): Promise<boolean> {
    try {
        if (!comment) {
            logger.warn('Empty comment provided for validation');
            return false;
        }

        // Check length requirements
        if (comment.length < guidelines.minLength || comment.length > guidelines.maxLength) {
            logger.warn('Comment length outside allowed range', {
                length: comment.length,
                min: guidelines.minLength,
                max: guidelines.maxLength
            });
            return false;
        }

        // Count emojis
        const emojiRegex = /[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu;
        const emojiCount = (comment.match(emojiRegex) || []).length;
        if (emojiCount > guidelines.maxEmojis) {
            logger.warn('Too many emojis in comment', {
                count: emojiCount,
                max: guidelines.maxEmojis
            });
            return false;
        }

        // Check for forbidden phrases
        for (const phrase of guidelines.forbiddenPhrases) {
            if (comment.toLowerCase().includes(phrase.toLowerCase())) {
                logger.warn('Comment contains forbidden phrase', { phrase });
                return false;
            }
        }

        // Check for spam patterns
        for (const pattern of guidelines.spamPatterns) {
            if (pattern.test(comment)) {
                logger.warn('Comment matches spam pattern', {
                    pattern: pattern.toString()
                });
                return false;
            }
        }

        // Count punctuation marks
        const punctuationCount = (comment.match(/[!?.,;:]/g) || []).length;
        if (punctuationCount > guidelines.maxPunctuation) {
            logger.warn('Too much punctuation in comment', {
                count: punctuationCount,
                max: guidelines.maxPunctuation
            });
            return false;
        }

        // Count capitalized words
        const capitalizedWords = comment.split(/\s+/).filter(word =>
            word.length > 1 && word[0] === word[0].toUpperCase()
        ).length;
        if (capitalizedWords > guidelines.maxCapitalizedWords) {
            logger.warn('Too many capitalized words in comment', {
                count: capitalizedWords,
                max: guidelines.maxCapitalizedWords
            });
            return false;
        }

        // Check if comment includes required emoji when specified
        if (guidelines.mustIncludeEmoji && !emojiRegex.test(comment)) {
            logger.warn('Comment missing required emoji');
            return false;
        }

        return true;
    } catch (error) {
        logger.error('Error validating comment:', {
            error: error instanceof Error ? error.message : String(error),
            component: 'Instagram-Core',
            event: 'comment_validation_error'
        });
        return false;
    }
}

async function findLikeButton(post: ElementHandle<Element>): Promise<ElementHandle<Element> | null> {
    try {
        // Try multiple selectors for the like button
        const selectors = [
            'button[type="button"] svg[aria-label="Like"]',
            'button[type="button"]:has(svg[aria-label="Like"])',
            'button[type="button"]:has(span[aria-label="Like"])',
            'button[type="button"]:has([aria-label="Like"])',
            'button[type="button"]:has([aria-label*="like"])',
            'button:has(svg[aria-label="Like"])',
            'button:has([aria-label*="like"])'
        ];

        for (const selector of selectors) {
            const button = await post.$(selector);
            if (button) {
                return button;
            }
        }

        return null;
    } catch (error) {
        logger.error('Error finding like button:', {
            error: error instanceof Error ? error.message : String(error),
            component: 'Instagram-Core',
            event: 'find_like_button_error'
        });
        return null;
    }
}

async function saveInteractionToDb(interaction: BotInteraction): Promise<void> {
    try {
        if (!storage) {
            logger.warn('Storage not initialized, skipping interaction save');
            return;
        }

        await storage.saveInteraction(interaction);
        logger.info('Saved interaction to storage');
    } catch (error) {
        logger.error('Error saving interaction to storage:', error);
    }
}
