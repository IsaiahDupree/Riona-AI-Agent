// Import required modules
import { ElementHandle, Page } from 'puppeteer';
import { logger } from '../utils/logger';
import { delay } from '../utils/delay';
import { chatCompletion } from '../utils/ai';
import dotenv from 'dotenv';
// MongoClient removed — imported but never used in this module
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
import { hasCommentedOnPost, trackComment, TrackedComment } from '../tracking/commentTracker';
import { formatError, sanitizeForPrompt } from '../utils/errors';

// Load environment variables
dotenv.config({ override: true });

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

// OpenAI replaced by shared Anthropic wrapper (chatCompletion)

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
            // Try direct post/reel/stories links first
            const a = el.querySelector('a[href^="/p/"]') || el.querySelector('a[href^="/reel/"]') || el.querySelector('a[href^="/stories/"]');
            if (a) return a.getAttribute('href') || null;

            // Fallback: look for any link containing /p/ or /reel/ in href
            const allLinks = el.querySelectorAll('a[href]');
            for (const link of allLinks) {
                const h = link.getAttribute('href') || '';
                if (h.match(/\/(p|reel)\/[A-Za-z0-9_-]+/)) return h;
            }

            // Fallback: check time elements with datetime that link to posts
            const timeLink = el.querySelector('time')?.closest('a');
            if (timeLink) return timeLink.getAttribute('href') || null;

            return null;
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
        // Fix: use INSTAGRAM_BOT_USERNAME (the correct env var)
        const username = process.env.INSTAGRAM_BOT_USERNAME || process.env.INSTAGRAM_USERNAME;
        if (!username) {
            logger.error('Instagram username not found in environment variables (checked INSTAGRAM_BOT_USERNAME and INSTAGRAM_USERNAME)');
            return false;
        }

        // 1. Check persistent tracker first (most reliable - survives restarts)
        let permalink: string | null = null;
        try {
            permalink = await extractPermalink(post);
        } catch (e) { logger.debug(`[core] Permalink extraction failed: ${formatError(e)}`); }
        if (permalink) {
            const existing = hasCommentedOnPost(permalink);
            if (existing) {
                logger.info(`[duplicate] Tracker found existing comment on ${permalink}`, {
                    component: 'Instagram-Core',
                    event: 'duplicate_tracker_hit',
                    originalComment: existing.commentText,
                    originalTime: existing.timestamp
                });
                return true;
            }
        }

        // 2. Check DOM within the post element for bot username links
        const postSelectors = [
            `a[href="/${username}/"]`,
            `a[href="/${username}"]`,
            `div._a9zr a[href="/${username}/"]`
        ];

        for (const selector of postSelectors) {
            try {
                const userComments = await post.$$(selector);
                if (userComments.length > 0) {
                    logger.info(`[duplicate] DOM found bot username in post via ${selector}`, {
                        component: 'Instagram-Core',
                        event: 'duplicate_dom_hit'
                    });
                    return true;
                }
            } catch {
                continue;
            }
        }

        // 3. Page-level check: search for bot username near comment sections
        try {
            const pageHasComment = await page.evaluate((user: string) => {
                // Look for comment sections containing our username
                const commentSections = document.querySelectorAll('ul, div[role="list"]');
                for (const section of commentSections) {
                    const links = section.querySelectorAll(`a[href="/${user}/"], a[href="/${user}"]`);
                    if (links.length > 0) return true;
                }
                return false;
            }, username);

            if (pageHasComment) {
                logger.info('[duplicate] Page-level check found bot username in comments', {
                    component: 'Instagram-Core',
                    event: 'duplicate_page_hit'
                });
                return true;
            }
        } catch (e) { logger.debug(`[core] Existing comments check failed: ${formatError(e)}`); }

        logger.debug('No existing comments found from bot:', { username });
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

/**
 * Page-level verification: check if our comment text appears anywhere on the page.
 * More reliable than post-scoped check since comments may render in modals.
 */
async function verifyCommentPosted(page: Page, commentText: string): Promise<boolean> {
    try {
        // Check a meaningful substring (first 20 chars) to avoid false negatives from truncation
        const snippet = commentText.slice(0, Math.min(20, commentText.length));
        const found = await page.evaluate((text: string) => {
            return document.body.innerText.includes(text);
        }, snippet);
        if (found) return true;

        // Also check for our username in recent comment area
        const botUser = process.env.INSTAGRAM_BOT_USERNAME || '';
        if (botUser) {
            const userFound = await page.evaluate((username: string) => {
                const links = document.querySelectorAll('a[href]');
                for (const link of links) {
                    if (link.getAttribute('href')?.includes(`/${username}`)) {
                        return true;
                    }
                }
                return false;
            }, botUser);
            if (userFound) return true;
        }

        return false;
    } catch {
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

        const cleanCaption = sanitizeForPrompt(caption, 500);

        const prompt = `Generate a simple Instagram comment for this post: "${cleanCaption}"\n\nFollow these basic rules:
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

        logger.info('Sending request to AI', {
            component: 'Instagram-Core',
            event: 'ai_request_start'
        });

        const comment = await chatCompletion({
            messages: [
                {
                    role: "system",
                    content: "You are a casual Instagram user who leaves simple, friendly comments. Keep comments natural and related to the post content. Reply with ONLY the comment text — no markdown, no headers, no formatting, no labels, no quotes."
                },
                {
                    role: "user",
                    content: prompt
                }
            ],
            max_tokens: 60,
            temperature: 0.7
        });

        if (!comment) {
            logger.warn('AI did not generate a comment', {
                component: 'Instagram-Core',
                event: 'ai_no_comment'
            });
            return null;
        }

        // Strip markdown formatting, headers, quotes, and meta-labels the AI sometimes adds
        const cleaned = stripMarkdownFromComment(comment);

        if (!cleaned) {
            logger.warn('Comment was entirely markdown/meta-text — discarding', {
                component: 'Instagram-Core',
                event: 'comment_markdown_stripped',
                original: comment
            });
            return null;
        }

        logger.info('Generated comment from OpenAI', {
            component: 'Instagram-Core',
            event: 'comment_generation_success',
            commentLength: cleaned.length,
            wasStripped: cleaned !== comment
        });

        // Validate the generated comment
        const isValid = await validateComment(cleaned);
        if (!isValid) {
            logger.warn('Generated comment failed validation', {
                component: 'Instagram-Core',
                event: 'comment_validation_failed',
                comment: cleaned
            });
            return null;
        }

        logger.info('Comment passed validation', {
            component: 'Instagram-Core',
            event: 'comment_validation_success',
            comment: cleaned
        });

        return cleaned;
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

        // Find comment box - search PAGE LEVEL FIRST since Instagram renders
        // the comment textarea in a modal outside the <article> element
        const commentSelectors = [
            'textarea[aria-label="Add a comment…"]',            // unicode ellipsis - Instagram's actual selector
            'textarea[placeholder="Add a comment…"]',           // placeholder variant
            'textarea[placeholder="Add a comment..."]',         // three dots variant
            'textarea[aria-label*="comment" i]',                // case-insensitive textarea
        ];

        const contentEditableSelectors = [
            'div[contenteditable="true"][role="textbox"][aria-label*="comment" i]',
            'div[contenteditable="true"][role="textbox"][aria-label*="Comment" i]',
            'div[contenteditable="true"][role="textbox"][aria-placeholder*="comment" i]',
            'div[contenteditable="true"][role="textbox"][data-lexical-editor="true"]',
            'div[role="textbox"][contenteditable="true"]',
            'form textarea',
            'form div[contenteditable="true"]'
        ];

        let commentBox: ElementHandle<Element> | null = null;

        // Step 1: Check PAGE level first (modal textarea)
        for (const selector of commentSelectors) {
            const found = await page.$(selector);
            if (found) {
                const isVisible = await found.evaluate((el: Element) => {
                    const rect = el.getBoundingClientRect();
                    return rect.width > 0 && rect.height > 0;
                });
                if (isVisible) {
                    logger.info(`[detect] comment box via page.$(${selector}) ✅`);
                    if (isModerationExecution) console.log('✅ Found comment box field (page-level)');
                    commentBox = found;
                    break;
                }
            }
        }

        // Step 2: Check inside the post element
        if (!commentBox) {
            for (const selector of [...commentSelectors, ...contentEditableSelectors]) {
                const found = await post.$(selector);
                if (found) {
                    logger.info(`[detect] comment box via post.$(${selector}) ✅`);
                    if (isModerationExecution) console.log('✅ Found comment box field (post-level)');
                    commentBox = found;
                    break;
                }
            }
        }

        // If not found, try opening the composer by clicking the comment icon
        if (!commentBox) {
            logger.info('[detect] Trying comment icon to open composer');
            // Try multiple comment icon selectors (Instagram changes these frequently)
            const commentIconSelectors = [
                'svg[aria-label="Comment"]',
                'svg[aria-label="Comment" i]',
                'svg[aria-label*="comment" i]',
                '[aria-label="Comment"] svg',
                '[aria-label*="comment" i] svg',
                'button svg[aria-label*="comment" i]',
                // Instagram 2026: sometimes wrapped in a span/div with role
                'span[role="button"] svg[aria-label*="comment" i]',
                'div[role="button"] svg[aria-label*="comment" i]'
            ];
            let commentIcon: ElementHandle<Element> | null = null;
            for (const iconSel of commentIconSelectors) {
                commentIcon = await post.$(iconSel);
                if (commentIcon) {
                    logger.info(`[detect] comment icon found via ${iconSel} ✅`);
                    break;
                }
            }
            // Fallback: find by SVG path shape (speech bubble icon)
            if (!commentIcon) {
                const svgs = await post.$$('svg');
                for (const svg of svgs) {
                    const hasCommentPath = await svg.evaluate((el: SVGSVGElement) => {
                        const paths = el.querySelectorAll('path');
                        for (const p of paths) {
                            const d = p.getAttribute('d') || '';
                            // Instagram comment icon typically contains bubble/chat path
                            if (d.includes('M20.656') || d.includes('47.5') || d.length > 80 && d.includes('C') && d.includes('Z')) {
                                return true;
                            }
                        }
                        // Also check parent for comment-related attributes
                        const parent = el.closest('[aria-label]');
                        if (parent) {
                            const label = (parent.getAttribute('aria-label') || '').toLowerCase();
                            if (label.includes('comment')) return true;
                        }
                        return false;
                    });
                    if (hasCommentPath) {
                        commentIcon = svg;
                        logger.info('[detect] comment icon found via SVG path analysis ✅');
                        break;
                    }
                }
            }
            if (commentIcon) {
                // Always click the parent button/div, not the SVG itself
                // Instagram wraps the SVG in a div[role="button"] which is the actual click target
                try {
                    const clicked = await commentIcon.evaluate((el: Element) => {
                        const clickable = el.closest('[role="button"]') || el.closest('button') || el.parentElement;
                        if (clickable) {
                            (clickable as HTMLElement).click();
                            return 'parent: ' + clickable.tagName + '[role=' + clickable.getAttribute('role') + ']';
                        }
                        (el as HTMLElement).click();
                        return 'self: ' + el.tagName;
                    });
                    await delay(2000);
                    logger.info(`[action] clicked comment icon via ${clicked} ✅`);
                } catch (e) {
                    try {
                        await commentIcon.click();
                        await delay(2000);
                        logger.info('[action] clicked comment icon directly ✅');
                    } catch {
                        logger.warn('[action] click comment icon failed ❌');
                    }
                }

                // Instagram opens a modal/overlay - wait for textarea to appear at page level
                // The textarea has aria-label="Add a comment…" (unicode ellipsis \u2026)
                logger.info('[detect] waiting for comment textarea in modal...');
                const modalTextareaSelector = 'textarea[aria-label="Add a comment\u2026"], textarea[placeholder="Add a comment\u2026"], textarea[placeholder="Add a comment..."]';
                try {
                    await page.waitForSelector(modalTextareaSelector, { timeout: 8000 });
                    logger.info('[detect] modal comment textarea appeared ✅');
                } catch {
                    logger.info('[detect] modal comment textarea did not appear within 8s, trying broader search');
                    await delay(3000); // Extra wait for slow modals
                }

                // Try direct page-level textarea detection first (most reliable for modal)
                const modalSelectors = [
                    'textarea[aria-label="Add a comment\u2026"]',
                    'textarea[placeholder="Add a comment\u2026"]',
                    'textarea[placeholder="Add a comment..."]',
                    'textarea[aria-label="Add a comment..."]',
                ];
                for (const sel of modalSelectors) {
                    const found = await page.$(sel);
                    if (found) {
                        logger.info(`[detect] modal textarea found via page.$(${sel}) ✅`);
                        if (isModerationExecution) console.log('✅ Found comment box in modal');
                        commentBox = found;
                        break;
                    }
                }

                // If not found with exact selectors, try broader search
                if (!commentBox) {
                    // Use page.evaluate to find ANY visible textarea on the page
                    const textareaInfo = await page.evaluate(() => {
                        const textareas = document.querySelectorAll('textarea');
                        const results: string[] = [];
                        textareas.forEach(ta => {
                            const rect = ta.getBoundingClientRect();
                            if (rect.width > 0 && rect.height > 0) {
                                results.push(`aria-label="${ta.getAttribute('aria-label')}" placeholder="${ta.getAttribute('placeholder')}"`);
                            }
                        });
                        return results;
                    });
                    logger.info(`[detect] visible textareas on page: ${JSON.stringify(textareaInfo)}`);

                    // Find first visible textarea that looks like a comment box
                    const foundTextarea = await page.evaluateHandle(() => {
                        const textareas = document.querySelectorAll('textarea');
                        for (const ta of textareas) {
                            const rect = ta.getBoundingClientRect();
                            if (rect.width > 0 && rect.height > 0) {
                                const label = (ta.getAttribute('aria-label') || '') + (ta.getAttribute('placeholder') || '');
                                if (label.toLowerCase().includes('comment') || label.includes('…') || label.includes('...')) {
                                    return ta;
                                }
                            }
                        }
                        return null;
                    });

                    if (foundTextarea && foundTextarea.asElement()) {
                        commentBox = foundTextarea.asElement() as ElementHandle<Element>;
                        logger.info('[detect] found comment textarea via evaluate ✅');
                    }
                }

                // Fall back to regular selector search
                if (!commentBox) {
                    for (const selector of commentSelectors) {
                        logger.info(`[detect] comment box via ${selector} (after icon)`);
                        const found = await page.$(selector) || await post.$(selector);
                        if (found) {
                            logger.info(`[detect] ${selector} ✅`);
                            if (isModerationExecution) console.log('✅ Found comment box field after clicking comment icon');
                            commentBox = found;
                            break;
                        } else {
                            logger.info(`[detect] ${selector} ❌`);
                        }
                    }
                }
            } else {
                logger.info('[detect] comment icon not found with any selector ❌');
            }
        }

        // Fallback to contenteditable composer (within post)
        if (!commentBox) {
            logger.info('[detect] trying contenteditable composer fallback (post-scoped)');
            commentBox = await post.$('div[contenteditable="true"][role="textbox"]');
            logger.info(`[detect] contenteditable composer (post) ${commentBox ? '✅' : '❌'}`);
            if (commentBox && isModerationExecution) {
                console.log('✅ Found comment box field (contenteditable fallback)');
            }
        }

        // Page-level fallback: Instagram opens a modal when clicking comment icon,
        // so the comment textarea is rendered outside the article element at the page level
        if (!commentBox) {
            logger.info('[detect] trying page-level comment box search');
            const pageSelectors = [
                'textarea[aria-label="Add a comment\u2026"]',                         // exact match (unicode ellipsis) - Instagram's actual selector
                'textarea[placeholder="Add a comment\u2026"]',                         // placeholder variant
                'textarea[aria-label="Add a comment..."]',                             // three dots variant
                'textarea[aria-label*="comment" i]',                                   // any textarea with comment
                'div[contenteditable="true"][role="textbox"][aria-label*="comment" i]',
                'div[contenteditable="true"][role="textbox"][aria-placeholder*="comment" i]',
                'div[contenteditable="true"][role="textbox"][data-lexical-editor="true"]',
                'form div[contenteditable="true"][role="textbox"]',
                'div[contenteditable="true"][role="textbox"]'
            ];
            for (const selector of pageSelectors) {
                const found = await page.$(selector);
                if (found) {
                    // Verify it's visible and likely a comment box
                    const isVisible = await found.evaluate((el: Element) => {
                        const rect = el.getBoundingClientRect();
                        const style = window.getComputedStyle(el);
                        return rect.width > 0 && rect.height > 0 &&
                               style.display !== 'none' && style.visibility !== 'hidden';
                    });
                    if (isVisible) {
                        logger.info(`[detect] page-level comment box via ${selector} ✅`);
                        if (isModerationExecution) console.log('✅ Found comment box field (page-level fallback)');
                        commentBox = found;
                        break;
                    }
                }
            }
            if (!commentBox) logger.info('[detect] page-level comment box search ❌');
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
                } catch (e) { logger.debug(`[core] Button eval failed: ${formatError(e)}`); }
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

        // Determine if comment box is contenteditable div or textarea
        const isContentEditable = await commentBox.evaluate((el: Element) => {
            return el.getAttribute('contenteditable') === 'true' || el.tagName !== 'TEXTAREA';
        });
        logger.info(`[comment] composer type: ${isContentEditable ? 'contenteditable' : 'textarea'}`);

        // Focus the comment box - use click for contenteditable (more reliable)
        logger.info('[comment] focusing composer');
        if (isContentEditable) {
            await commentBox.click();
            await delay(300);
        }
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

        // Verify text was actually typed (contenteditable divs can swallow input)
        if (isContentEditable) {
            const typedText = await commentBox.evaluate((el: Element) => (el.textContent || '').trim());
            if (!typedText || typedText.length === 0) {
                logger.warn('[comment] text not detected in contenteditable, retrying with insertText');
                // Retry using execCommand insertText (works better with some React editors)
                await commentBox.click();
                await delay(200);
                await commentBox.evaluate((el: Element, text: string) => {
                    (el as HTMLElement).focus();
                    // Clear first
                    const range = document.createRange();
                    range.selectNodeContents(el);
                    const sel = window.getSelection();
                    if (sel) {
                        sel.removeAllRanges();
                        sel.addRange(range);
                    }
                    document.execCommand('delete');
                    // Insert text
                    document.execCommand('insertText', false, text);
                    // Dispatch input event so React picks it up
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                }, comment);
                await delay(500);
            }
        }

        logger.info(`[comment] typing complete in ${Date.now() - tType}ms ✅`);
        if (isModerationExecution) console.log('✅ Message typed successfully');

        // Try multiple methods to submit the comment
        const methodStartTime = Date.now();
        let successfulMethod: string | null = null;
        let methodAttempts: Array<{ method: string, success: boolean, time_ms: number, error?: string }> = [];

        const submitMethods = [
            // Method 1: Click role button with visible text "Post" (primary — this is the actual Post button on Instagram)
            async () => {
                const attemptStart = Date.now();
                const methodName = 'role_button_text';
                try {
                    logger.info('[submit] method 1: click role button by text (Post/Send)');
                    if (isModerationExecution) console.log('🔍 Looking for "Post" button (div[role="button"] or button)');
                    const labels = [
                        'post', 'send',
                        'publier', 'envoyer',
                        'publicar', 'enviar', 'postar',
                        'pubblica',
                        'veröffentlichen', 'senden',
                        'gönder',
                        '投稿',
                        '게시', '보내기',
                        '发布', '发表', '发送',
                        'gửi'
                    ];
                    const candidateSelectors = [
                        'div[role="button"]',
                        'button',
                        'form div[role="button"]',
                        'form button'
                    ];

                    // First search within the post container
                    for (const sel of candidateSelectors) {
                        const nodes = await post.$$(sel);
                        for (const n of nodes) {
                            try {
                                const text = (await n.evaluate(el => (el.textContent || '').trim().toLowerCase())) as string;
                                if (labels.some(l => text === l)) {
                                    await n.click();
                                    logger.info(`[submit] method 1 invoked ✅ — clicked "${text}" in post container`);
                                    if (isModerationExecution) console.log(`✅ Clicked Post button: "${text}"`);
                                    const attemptTime = Date.now() - attemptStart;
                                    methodAttempts.push({ method: methodName, success: true, time_ms: attemptTime });
                                    successfulMethod = methodName;
                                    return true;
                                }
                            } catch (e) { logger.debug(`[core] DOM element eval failed: ${formatError(e)}`); }
                        }
                    }

                    // Fallback: search at page level (on individual post pages, button may be outside post element)
                    for (const sel of candidateSelectors) {
                        const nodes = await page.$$(sel);
                        for (const n of nodes) {
                            try {
                                const text = (await n.evaluate(el => (el.textContent || '').trim().toLowerCase())) as string;
                                if (labels.some(l => text === l)) {
                                    // Make sure it's near the comment box (within the same form or section)
                                    const isNearCommentBox = await n.evaluate((el) => {
                                        const form = el.closest('form') || el.closest('section');
                                        if (!form) return false;
                                        const textarea = form.querySelector('textarea, [contenteditable="true"]');
                                        return !!textarea;
                                    });
                                    if (isNearCommentBox) {
                                        await n.click();
                                        logger.info(`[submit] method 1 invoked ✅ — clicked "${text}" at page level`);
                                        if (isModerationExecution) console.log(`✅ Clicked Post button at page level: "${text}"`);
                                        const attemptTime = Date.now() - attemptStart;
                                        methodAttempts.push({ method: methodName, success: true, time_ms: attemptTime });
                                        successfulMethod = methodName;
                                        return true;
                                    }
                                }
                            } catch (e) { logger.debug(`[core] DOM element eval failed: ${formatError(e)}`); }
                        }
                    }

                    logger.info('[submit] method 1 not found ❌');
                    if (isModerationExecution) console.log('❌ Post button not found');
                    const attemptTime = Date.now() - attemptStart;
                    methodAttempts.push({ method: methodName, success: false, time_ms: attemptTime, error: 'Post button not found' });
                    return false;
                } catch (error) {
                    const attemptTime = Date.now() - attemptStart;
                    methodAttempts.push({ method: methodName, success: false, time_ms: attemptTime, error: error instanceof Error ? error.message : String(error) });
                    return false;
                }
            },
            // Method 2: Click button[type="submit"] (fallback for standard HTML forms)
            async () => {
                const attemptStart = Date.now();
                const methodName = 'submit_button';
                try {
                    logger.info('[submit] method 2: click button[type="submit"]');
                    if (isModerationExecution) console.log('🔍 Looking for submit button');
                    // Search in post container first, then page level
                    let postButton = await post.$('button[type="submit"]');
                    if (!postButton) {
                        postButton = await page.$('form button[type="submit"]');
                    }
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
            // Method 3: Press Enter key (last resort — on Instagram, Enter usually inserts a newline but worth trying)
            async () => {
                const attemptStart = Date.now();
                const methodName = 'enter_key';
                try {
                    logger.info('[submit] method 3: press Enter (last resort)');
                    if (isModerationExecution) console.log('🔍 Trying Enter key as last resort');
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
        await delay(3000);

        // Verify comment was posted successfully using combined checks
        if (isModerationExecution) console.log('🔍 Verifying comment was posted...');

        // Check 1: Is the comment box empty? (strong signal — Instagram clears it on success)
        let textboxEmpty = false;
        try {
            textboxEmpty = !!(await commentBox?.evaluate((el) => {
                const ta = el as HTMLTextAreaElement;
                const ce = el as HTMLElement;
                const isCE = ce.getAttribute('contenteditable') === 'true';
                if (isCE) return (ce.textContent || '').trim() === '';
                return (ta.value || '').trim() === '';
            }));
        } catch { textboxEmpty = false; }
        logger.info(`[verify] textbox empty: ${textboxEmpty}`);

        // Check 2: Is our comment text visible in the page? (strongest signal)
        let commentVisible = false;
        try {
            // Search at page level since comment may be in a comments section outside the post element
            commentVisible = await page.evaluate((c) => {
                const text = document.body.innerText || '';
                return text.includes(c);
            }, comment);
        } catch { commentVisible = false; }
        logger.info(`[verify] comment visible in DOM: ${commentVisible}`);

        // Check 3: Are there error banners?
        let hasError = false;
        try {
            hasError = await page.evaluate(() => {
                const body = document.body.innerText.toLowerCase();
                return [
                    "couldn't post",
                    'try again',
                    'action blocked',
                    'comments on this post have been limited',
                    'only followers can comment',
                    'commenting has been turned off',
                    'we restrict certain activity',
                    'this action was blocked'
                ].some(t => body.includes(t));
            });
        } catch { hasError = false; }
        logger.info(`[verify] error banners: ${hasError}`);

        // Decision: verified if (textbox is empty AND no errors) OR (comment is visible AND no errors)
        const verified = !hasError && (textboxEmpty || commentVisible);
        logger.info(`[verify] final verdict: ${verified ? '✅ VERIFIED' : '❌ NOT VERIFIED'} (empty=${textboxEmpty}, visible=${commentVisible}, error=${hasError})`);

        if (verified) {
                    logger.info('Comment posted successfully', {
                        component: 'Instagram-Core',
                        event: 'comment_operation_success',
                        textboxEmpty,
                        commentVisible,
                        hasError
                    });
                    if (isModerationExecution) console.log('✅ Comment verified - successfully posted!');

                    // Close the post modal so the feed is visible for the next post
                    try {
                        // Press Escape to close modal
                        await page.keyboard.press('Escape');
                        await delay(1000);
                        // If modal still open, try clicking the close button
                        let closeBtn: ElementHandle<Element> | null = await page.$('svg[aria-label="Close"]') as ElementHandle<Element> | null;
                        if (!closeBtn) closeBtn = await page.$('[aria-label="Close"]');
                        if (closeBtn) {
                            await (closeBtn as ElementHandle<Element>).evaluate((el: Element) => {
                                const btn = el.closest('button') || el.closest('[role="button"]') || el;
                                (btn as HTMLElement).click();
                            });
                            await delay(1000);
                        }
                        logger.info('[action] closed post modal ✅');
                    } catch {
                        logger.info('[action] modal close attempted (may not have been open)');
                    }

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

        // Close any open modal on error so the feed is accessible for next post
        try {
            await page.keyboard.press('Escape');
            await delay(500);
        } catch (e) { logger.debug(`[core] Escape key press failed: ${formatError(e)}`); }

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
            } catch (e) { logger.debug(`[core] Permalink extraction failed: ${formatError(e)}`); }

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
                    try { pushStep(trace, { name: 'post_scan_failed', status: 'warn', notes: (e as Error)?.message }); await saveTrace(trace); } catch (traceErr) { logger.debug(`[core] Trace save failed: ${formatError(traceErr)}`); }
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
            } catch (e) { logger.debug(`[core] Account preferences load failed: ${formatError(e)}`); }

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

            // Track comment text and verification at function scope for metadata
            let postedComment: string | undefined;
            let commentVerified: boolean | undefined;

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
                        if (trace) { try { pushStep(trace, { name: 'propose_failed', status: 'warn', notes: e instanceof Error ? e.message : String(e) }); await saveTrace(trace); } catch (traceErr) { logger.debug(`[core] Trace save failed: ${formatError(traceErr)}`); } }
                    }

                    if (trace) {
                        try {
                            pushStep(trace, { name: 'proposed_for_review', status: 'ok', notes: JSON.stringify({ index, username: metadata.username, permalink, comment }) });
                            await saveTrace(trace);
                        } catch (e) { logger.debug(`[core] Trace step failed: ${formatError(e)}`); }
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

                // Verify comment actually appears in DOM
                postedComment = comment;
                commentVerified = false;
                try {
                    await delay(2000);
                    commentVerified = await verifyCommentPosted(page, comment);
                    logger.info(`[verify] Comment verification: ${commentVerified ? 'CONFIRMED' : 'UNCONFIRMED'}`, {
                        component: 'Instagram-Core',
                        event: commentVerified ? 'comment_verified' : 'comment_unverified'
                    });
                } catch (e) {
                    logger.warn('[verify] Comment verification check failed', { error: (e as Error).message });
                }

                // Trace the comment action if available
                if (trace) {
                    try {
                        pushStep(trace, { name: 'comment_posted', status: 'ok', notes: JSON.stringify({ index, username: metadata.username, permalink, comment, verified: commentVerified }) });
                        await saveTrace(trace);
                    } catch (e) { logger.debug(`[core] Trace step failed: ${formatError(e)}`); }
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
                } catch (e) { logger.debug(`[core] Interaction history save failed: ${formatError(e)}`); }
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
                    quality,
                    comment: postedComment,
                    commentVerified,
                    permalink
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
export async function processPosts(posts: ElementHandle<Element>[], page: Page, trace?: any, session?: any): Promise<void> {
    try {
        // Process up to 10 posts per call (caller handles multiple iterations with page refresh)
        const maxPostsPerIteration = 10;
        const postsPerRun = parseInt(process.env.POSTS_PER_RUN || '10', 10);
        const effectiveMax = Math.min(maxPostsPerIteration, postsPerRun);
        logger.info('Starting batch post processing', {
            timestamp: new Date().toISOString(),
            postCount: posts.length,
            targetPosts: effectiveMax,
            component: 'Instagram-Core',
            event: 'batch_processing_start'
        });

        const botActor = (trace?.target?.username as string) || process.env.INSTAGRAM_BOT_USERNAME || 'unknown';
        const maxPosts = Math.min(posts.length, effectiveMax);
        let processedCount = 0;

        // In-memory set to prevent double-processing within this batch
        const processedPermalinks = new Set<string>();

        for (let i = 0; i < maxPosts; i++) {
            try {
                // Re-discover posts each iteration since modal open/close invalidates DOM references
                if (i > 0) {
                    logger.info(`[batch] re-discovering posts for iteration ${i + 1}`);
                    // Navigate back to feed if needed
                    const currentUrl = page.url();
                    if (!currentUrl.includes('instagram.com') || currentUrl.includes('/p/') || currentUrl.includes('/reel/')) {
                        await page.goto('https://www.instagram.com/', { waitUntil: 'networkidle0', timeout: 30000 });
                        await delay(3000);
                    }
                    // Scroll down to load more posts - scroll further for higher indices
                    await page.evaluate((scrollAmount: number) => window.scrollBy(0, scrollAmount), i * 800);
                    await delay(2000);

                    // If we need more posts than visible, keep scrolling until enough load
                    let currentPosts = await page.$$('article');
                    let scrollAttempts = 0;
                    while (currentPosts.length <= i && scrollAttempts < 5) {
                        logger.info(`[batch] only ${currentPosts.length} posts, scrolling more (attempt ${scrollAttempts + 1})`);
                        await page.evaluate(() => window.scrollBy(0, 1200));
                        await delay(2500);
                        currentPosts = await page.$$('article');
                        scrollAttempts++;
                    }
                }

                // Dismiss any popup that appeared during scrolling
                try {
                    await page.evaluate(() => {
                        // Text-based detection
                        const buttons = document.querySelectorAll('button');
                        for (const btn of buttons) {
                            if (btn.textContent?.trim() === 'Not Now' || btn.textContent?.trim() === 'Not now') {
                                btn.click();
                                return true;
                            }
                        }
                        // Instagram dialog class-based detection
                        const dialogSelectors = [
                            'div._a9-z button._a9--._ap36._asz1',
                            'div[role="dialog"] button._a9--._ap36',
                        ];
                        for (const sel of dialogSelectors) {
                            const btn = document.querySelector(sel) as HTMLElement;
                            if (btn) { btn.click(); return true; }
                        }
                        return false;
                    });
                } catch (e) { logger.debug(`[core] Modal dismiss failed: ${formatError(e)}`); }

                // Get fresh post references
                const currentPosts = await page.$$('article');
                if (i >= currentPosts.length) {
                    logger.info(`[batch] only ${currentPosts.length} posts available, stopping at index ${i}`);
                    break;
                }
                const post = currentPosts[i];

                // ── Duplicate check: 3 layers ──
                // Layer 1: Extract permalink and check in-memory batch set
                let permalink: string | null = null;
                try {
                    permalink = await extractPermalink(post);
                } catch (e) { logger.debug(`[core] Permalink extraction failed: ${formatError(e)}`); }

                if (permalink) {
                    // Check if already processed in THIS batch (scroll re-discovery can show same post)
                    if (processedPermalinks.has(permalink)) {
                        logger.info(`[batch] DUPLICATE SKIPPED (in-batch) - already processed ${permalink} this session`, {
                            component: 'Instagram-Core',
                            event: 'duplicate_batch_skip'
                        });
                        if (session) {
                            session.postsSkippedDuplicate++;
                            session.postsProcessed++;
                        }
                        continue;
                    }

                    // Layer 2: Check persistent tracker (cross-session duplicate detection)
                    const existing = hasCommentedOnPost(permalink);
                    if (existing) {
                        logger.info(`[batch] DUPLICATE SKIPPED (tracker) - already commented on ${permalink} at ${existing.timestamp}`, {
                            component: 'Instagram-Core',
                            event: 'duplicate_tracker_skip',
                            postUrl: permalink,
                            originalComment: existing.commentText
                        });
                        processedPermalinks.add(permalink);
                        if (session) {
                            session.postsSkippedDuplicate++;
                            session.postsProcessed++;
                        }
                        continue;
                    }

                    // Mark as being processed
                    processedPermalinks.add(permalink);
                }

                // Skip own posts — don't comment on our own content
                const botUser = (process.env.INSTAGRAM_BOT_USERNAME || '').toLowerCase();
                if (botUser) {
                    try {
                        const postAuthor = await post.evaluate((el: Element) => {
                            // Username is typically in the first <a> link inside the article header
                            const links = el.querySelectorAll('a[href]');
                            for (const link of links) {
                                const href = link.getAttribute('href') || '';
                                if (/^\/[a-zA-Z0-9_.]+\/$/.test(href) && href !== '/' && !href.includes('/explore/')) {
                                    return href.replace(/\//g, '').toLowerCase();
                                }
                            }
                            return '';
                        });
                        if (postAuthor === botUser) {
                            logger.info(`[batch] SKIP (own post) @${postAuthor} ${permalink || ''}`);
                            if (session) {
                                session.postsSkippedOther++;
                                session.postsProcessed++;
                            }
                            continue;
                        }
                    } catch (e) { logger.debug(`[core] Processing check failed: ${formatError(e)}`); }
                }

                processedCount++;
                const result = await processPostWithRetry(post, page, trace, i);
                if (session) session.postsProcessed++;

                logger.info('Post processing result:', {
                    timestamp: new Date().toISOString(),
                    success: result.success,
                    error: result.error,
                    skipped: result.skipped,
                    component: 'Instagram-Core',
                    event: 'post_processing_result'
                });

                // Track in session and persistent tracker
                if (result.success && !result.skipped && result.metadata) {
                    const postMeta = result.metadata as any;
                    const commentText = postMeta.comment || '';
                    const verified = postMeta.commentVerified ?? false;

                    if (commentText && permalink) {
                        const tracked: TrackedComment = {
                            postUrl: permalink,
                            postUsername: postMeta.username || 'unknown',
                            commentText,
                            timestamp: new Date().toISOString(),
                            verified,
                            sessionId: session?.sessionId || 'unknown',
                            captionSnippet: (postMeta.caption || '').slice(0, 100),
                            liked: true
                        };
                        trackComment(tracked);

                        if (session) {
                            session.commentsPosted++;
                            if (verified) session.commentsVerified++;
                            session.likesPosted++;
                            session.comments.push(tracked);
                        }
                    }
                } else if (result.skipped) {
                    if (session) session.postsSkippedOther++;
                } else if (!result.success) {
                    if (session) {
                        session.commentsFailed++;
                        session.errors.push(result.error || 'Unknown error');
                    }
                }

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

                // Add delay between posts (human-like pacing)
                await delay(getRandomDelay(3000, 6000));
            } catch (error) {
                const errMsg = error instanceof Error ? error.message : String(error);
                logger.error('Error processing post:', {
                    error: errMsg,
                    timestamp: new Date().toISOString(),
                    component: 'Instagram-Core',
                    event: 'post_processing_error'
                });
                if (session) session.errors.push(errMsg);
            }
        }

        logger.info('Completed batch post processing', {
            timestamp: new Date().toISOString(),
            postCount: posts.length,
            processed: processedCount,
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
            // Look for profile links — Instagram profile hrefs are like "/username/" or "/username"
            const links = el.querySelectorAll('a[href]');
            for (const link of links) {
                const href = link.getAttribute('href') || '';
                // Match /<username>/ but skip /p/, /reel/, /stories/, /explore/, etc.
                const match = href.match(/^\/([a-zA-Z0-9._]+)\/?$/);
                if (match) {
                    const candidate = match[1];
                    const reserved = ['p', 'reel', 'reels', 'stories', 'explore', 'accounts', 'direct', 'tags'];
                    if (!reserved.includes(candidate.toLowerCase())) {
                        return candidate;
                    }
                }
            }
            return '';
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
            },
            // Method 4: Individual post page — caption in span[dir="auto"] inside div.html-div
            // This catches captions on /p/ and /reel/ pages where there's no <article>
            () => {
                const skipTexts = ['notifications', 'dashboard', 'also from meta', 'start the conversation', 'consumer health', 'log in', 'sign up'];
                const spans = $('span[dir="auto"]');
                for (let i = 0; i < spans.length; i++) {
                    const text = $(spans[i]).text().trim();
                    if (text.length > 20 && text.length < 3000) {
                        const lower = text.toLowerCase();
                        const isUI = skipTexts.some(s => lower.startsWith(s));
                        if (!isUI) {
                            return text;
                        }
                    }
                }
                return null;
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
            // Find "more" button using evaluate since :has-text() is Playwright-only
            const moreButton = await post.evaluateHandle(el => {
                const buttons = el.querySelectorAll('div[role="button"], button, span[role="link"]');
                for (const btn of buttons) {
                    const text = (btn.textContent || '').trim().toLowerCase();
                    if (text === 'more' || text === '… more' || text === '...more') {
                        return btn as HTMLElement;
                    }
                }
                return null;
            });

            if (moreButton && moreButton.asElement()) {
                await (moreButton as any).click();
                await delay(1000);

                // Get updated HTML after expansion and rebuild cheerio context
                const expandedHtml = await post.evaluate(el => el.outerHTML);
                const $expanded = cheerio.load(expandedHtml);

                // Re-run extraction methods with the expanded cheerio context
                const expandedMethods = [
                    () => {
                        const articleText = $expanded('article').text();
                        if (articleText) {
                            const textParts = articleText.split('\n').filter((part: string) => part.trim().length > 0);
                            if (textParts.length > 0) return textParts[0].trim();
                        }
                        return null;
                    },
                    () => {
                        const caption = $expanded('div._a9zs').text() ||
                            $expanded('h1._aacl').text() ||
                            $expanded('div[data-testid="post-content"] > div > span').text();
                        return caption ? caption.trim() : null;
                    },
                    () => {
                        const skipTexts = ['notifications', 'dashboard', 'also from meta', 'start the conversation', 'consumer health', 'log in', 'sign up'];
                        const spans = $expanded('span[dir="auto"]');
                        for (let i = 0; i < spans.length; i++) {
                            const text = $expanded(spans[i]).text().trim();
                            if (text.length > 20 && text.length < 3000) {
                                const lower = text.toLowerCase();
                                const isUI = skipTexts.some(s => lower.startsWith(s));
                                if (!isUI) return text;
                            }
                        }
                        return null;
                    }
                ];

                for (const method of expandedMethods) {
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
        let verified = false;
        for (let i = 0; i < verificationMethods.length; i++) {
            try {
                const ok = await verificationMethods[i]();
                logger.info(`[verify] like method ${i + 1} ${ok ? '✅' : '❌'}`);
                if (ok) {
                    logger.info('Like operation successful', { component: 'Instagram-Core', event: 'like_operation_success' });
                    verified = true;
                    break;
                }
            } catch (e) { logger.debug(`[core] Element eval failed: ${formatError(e)}`); }
        }

        if (!verified) {
            // Check if the post was already liked (Like button gone = already liked)
            const likeStillPresent = await post.$('svg[aria-label="Like"]');
            if (!likeStillPresent) {
                logger.info('Like button no longer present - post was likely already liked or like succeeded', {
                    component: 'Instagram-Core',
                    event: 'like_operation_assumed_success'
                });
                return true;
            }
            logger.warn('Like verification inconclusive - proceeding anyway (click was executed)', {
                component: 'Instagram-Core',
                event: 'like_operation_unverified_proceed'
            });
            // Return true to allow commenting to proceed even if we can't verify the like
            return true;
        }

        return true;

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

/**
 * Strip markdown formatting and meta-labels the AI sometimes wraps around comments.
 * e.g. "# Instagram Comment", "**great post**", "> nice work", "```comment```"
 */
function stripMarkdownFromComment(raw: string): string {
    let text = raw.trim();

    // Remove markdown headers (# Header, ## Header, etc.)
    text = text.replace(/^#{1,6}\s+/gm, '');

    // Remove meta-labels like "Instagram Comment:", "Comment:", "Here's a comment:"
    text = text.replace(/^(?:instagram\s+comment|twitter\s+comment|threads\s+comment|comment|here(?:'s| is) (?:a |my |the )?comment)\s*[:\-–—]\s*/gi, '');

    // Remove bold/italic markdown
    text = text.replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1');
    text = text.replace(/_{1,3}([^_]+)_{1,3}/g, '$1');

    // Remove blockquote markers
    text = text.replace(/^>\s*/gm, '');

    // Remove code blocks/backticks
    text = text.replace(/```[\s\S]*?```/g, '');
    text = text.replace(/`([^`]+)`/g, '$1');

    // Remove wrapping quotes the AI sometimes adds
    text = text.replace(/^["'](.+)["']$/s, '$1');

    return text.trim();
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
