/**
 * Twitter Likes Scraper — Scrapes your liked tweets, extracts topics,
 * and generates search terms for discovering similar content.
 *
 * Flow: navigate to /likes → scroll & collect → extract text → AI topic extraction → save
 */

import { Page } from 'puppeteer';
import { logger } from '../utils/logger';
import { formatError, safeReadJSON, safeWriteJSON } from '../utils/errors';
import { delay } from '../utils/delay';
import * as path from 'path';
import * as fs from 'fs';
import dotenv from 'dotenv';
import { chatCompletion } from '../utils/ai';

dotenv.config();

// OpenAI replaced by shared Anthropic wrapper (chatCompletion)

// ── Types ────────────────────────────────────────────────────────────

export interface LikedTweet {
    url: string;
    text: string;
    author: string;
    scrapedAt: string;
}

export interface LikesAnalysis {
    likedTweets: LikedTweet[];
    topics: TopicFrequency[];
    searchTerms: string[];
    analyzedAt: string;
    tweetCount: number;
}

export interface TopicFrequency {
    topic: string;
    count: number;
    confidence: number;
}

// ── File paths ───────────────────────────────────────────────────────

const LIKES_DATA_FILE = path.join(process.cwd(), 'logs', 'tracking', 'twitter', 'liked_tweets.json');
const LIKES_ANALYSIS_FILE = path.join(process.cwd(), 'logs', 'tracking', 'twitter', 'likes_analysis.json');

function ensureDir(filePath: string) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ── Scrape liked tweets ──────────────────────────────────────────────

/**
 * Navigate to the user's likes page and collect liked tweet data.
 * Scrolls through the page collecting text + author + URL.
 */
export async function scrapeLikedTweets(
    page: Page,
    maxTweets: number = 100,
): Promise<LikedTweet[]> {
    const username = process.env.TWITTER_BOT_USERNAME || '';
    if (!username) {
        logger.warn('[likes-scraper] No TWITTER_BOT_USERNAME set, cannot scrape likes');
        return [];
    }

    const likesUrl = `https://x.com/${username}/likes`;
    logger.info(`[likes-scraper] Navigating to ${likesUrl}`);

    await page.goto(likesUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    await delay(3000);

    // Dismiss popups
    try {
        await page.evaluate(() => {
            const buttons = document.querySelectorAll('button, [role="button"]');
            for (const btn of buttons) {
                const text = (btn.textContent || '').trim().toLowerCase();
                if (['not now', 'maybe later', 'dismiss', 'close'].includes(text)) {
                    (btn as HTMLElement).click();
                    return;
                }
            }
        });
    } catch (_) { /* no popup */ }

    await delay(2000);

    // Scroll and collect
    const collected = new Map<string, LikedTweet>();
    let scrollAttempts = 0;
    const maxScrolls = 30;
    let noNewCount = 0;

    while (collected.size < maxTweets && scrollAttempts < maxScrolls) {
        const tweets = await page.evaluate(() => {
            const articles = document.querySelectorAll('article[data-testid="tweet"]');
            const results: { url: string; text: string; author: string }[] = [];

            for (const article of articles) {
                // Extract text
                const textEl = article.querySelector('div[data-testid="tweetText"]');
                const text = textEl?.textContent?.trim() || '';
                if (!text) continue;

                // Extract URL
                const timeEl = article.querySelector('time');
                let url = '';
                if (timeEl) {
                    const link = timeEl.closest('a');
                    if (link) {
                        const href = link.getAttribute('href');
                        if (href && href.match(/\/[^/]+\/status\/\d+/)) {
                            url = `https://x.com${href}`;
                        }
                    }
                }

                // Extract author
                let author = 'unknown';
                const userNameEl = article.querySelector('div[data-testid="User-Name"]');
                if (userNameEl) {
                    const handleMatch = (userNameEl.textContent || '').match(/@([a-zA-Z0-9_]+)/);
                    if (handleMatch) author = handleMatch[1];
                }

                if (url) {
                    results.push({ url, text, author });
                }
            }

            return results;
        });

        const prevSize = collected.size;
        for (const tweet of tweets) {
            if (!collected.has(tweet.url)) {
                collected.set(tweet.url, {
                    ...tweet,
                    scrapedAt: new Date().toISOString(),
                });
            }
        }

        if (collected.size === prevSize) {
            noNewCount++;
            if (noNewCount >= 5) {
                logger.info(`[likes-scraper] No new tweets after ${noNewCount} scrolls, stopping at ${collected.size}`);
                break;
            }
        } else {
            noNewCount = 0;
        }

        logger.info(`[likes-scraper] Scroll ${scrollAttempts + 1}: ${collected.size}/${maxTweets} liked tweets collected`);

        await page.evaluate(() => window.scrollBy(0, 1500));
        await delay(2000 + Math.random() * 1500);
        scrollAttempts++;
    }

    const result = [...collected.values()];
    logger.info(`[likes-scraper] Scraped ${result.length} liked tweets total`);

    // Save raw data
    ensureDir(LIKES_DATA_FILE);
    safeWriteJSON(LIKES_DATA_FILE, result, 'liked_tweets');

    return result;
}

// ── Analyze liked tweets → extract topics ────────────────────────────

/**
 * Take liked tweet texts and use AI to extract recurring themes/topics.
 * Then generate search terms for finding similar content.
 */
export async function analyzeLikedContent(
    likedTweets?: LikedTweet[],
): Promise<LikesAnalysis> {
    // Load from file if not provided
    if (!likedTweets) {
        likedTweets = safeReadJSON<LikedTweet[]>(LIKES_DATA_FILE, [], 'liked_tweets');
    }

    if (likedTweets.length === 0) {
        logger.warn('[likes-scraper] No liked tweets to analyze');
        return {
            likedTweets: [],
            topics: [],
            searchTerms: [],
            analyzedAt: new Date().toISOString(),
            tweetCount: 0,
        };
    }

    // Sample tweets for AI analysis (spread evenly across the collection)
    const sampleSize = Math.min(40, likedTweets.length);
    const step = Math.max(1, Math.floor(likedTweets.length / sampleSize));
    const sampled = likedTweets.filter((_, i) => i % step === 0).slice(0, sampleSize);

    const sampleTexts = sampled.map(t => t.text).join('\n---\n');

    logger.info(`[likes-scraper] Analyzing ${sampled.length} liked tweets for topics...`);

    try {
        const raw = await chatCompletion({
            messages: [
                {
                    role: 'system',
                    content: 'You analyze social media content patterns. Extract recurring themes, topics, and interests from liked tweets. Be specific — not generic categories.',
                },
                {
                    role: 'user',
                    content: `These are tweets a user liked on Twitter/X. Analyze them and return:

1. "topics" — array of objects with "topic" (specific theme), "count" (estimated frequency 1-10), "confidence" (0-1)
2. "searchTerms" — array of 10-15 Twitter search terms that would find SIMILAR content. Use specific phrases, not single words. Mix keywords and phrases people actually tweet about.

Tweets:
${sampleTexts}

Return ONLY valid JSON:
{
  "topics": [{"topic": "...", "count": N, "confidence": 0.X}, ...],
  "searchTerms": ["term1", "term2", ...]
}`,
                },
            ],
            max_tokens: 800,
            temperature: 0.4,
        }) || '{}';
        // Strip markdown code blocks if present
        const cleaned = raw.replace(/^```json?\n?/i, '').replace(/\n?```$/i, '').trim();
        const parsed = JSON.parse(cleaned);

        const topics: TopicFrequency[] = Array.isArray(parsed.topics) ? parsed.topics : [];
        const searchTerms: string[] = Array.isArray(parsed.searchTerms) ? parsed.searchTerms : [];

        const analysis: LikesAnalysis = {
            likedTweets: likedTweets,
            topics: topics.sort((a, b) => b.count - a.count),
            searchTerms,
            analyzedAt: new Date().toISOString(),
            tweetCount: likedTweets.length,
        };

        // Save analysis
        ensureDir(LIKES_ANALYSIS_FILE);
        safeWriteJSON(LIKES_ANALYSIS_FILE, analysis, 'likes_analysis');

        logger.info(`[likes-scraper] Analysis complete: ${topics.length} topics, ${searchTerms.length} search terms`);
        for (const t of topics.slice(0, 5)) {
            logger.info(`[likes-scraper]   ${t.topic} (count: ${t.count}, confidence: ${t.confidence})`);
        }

        return analysis;
    } catch (e) {
        logger.error(`[likes-scraper] AI analysis failed: ${formatError(e)}`);
        return {
            likedTweets,
            topics: [],
            searchTerms: [],
            analyzedAt: new Date().toISOString(),
            tweetCount: likedTweets.length,
        };
    }
}

// ── Get search terms from likes (cached) ─────────────────────────────

/**
 * Returns search terms derived from liked tweets.
 * Uses cached analysis if less than 24h old, otherwise returns empty.
 * Call refreshLikesAnalysis() to update.
 */
export function getLikesSearchTerms(): string[] {
    const analysis = safeReadJSON<LikesAnalysis | null>(LIKES_ANALYSIS_FILE, null, 'likes_analysis');
    if (!analysis || !analysis.searchTerms) return [];

    // Check freshness — analysis older than 7 days is stale
    const age = Date.now() - new Date(analysis.analyzedAt).getTime();
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    if (age > sevenDays) {
        logger.info('[likes-scraper] Likes analysis is stale (>7 days), returning empty');
        return [];
    }

    return analysis.searchTerms;
}

/**
 * Get the full likes analysis (topics + search terms).
 */
export function getLikesAnalysis(): LikesAnalysis | null {
    return safeReadJSON<LikesAnalysis | null>(LIKES_ANALYSIS_FILE, null, 'likes_analysis');
}

// ── Full refresh: scrape + analyze ───────────────────────────────────

/**
 * Full pipeline: scrape likes page → AI analysis → save search terms.
 * Call this periodically (e.g., weekly) or on demand.
 */
export async function refreshLikesAnalysis(
    page: Page,
    maxTweets: number = 100,
): Promise<LikesAnalysis> {
    logger.info('[likes-scraper] Starting full likes refresh...');
    const tweets = await scrapeLikedTweets(page, maxTweets);
    const analysis = await analyzeLikedContent(tweets);
    return analysis;
}
