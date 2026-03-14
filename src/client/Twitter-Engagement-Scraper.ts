/**
 * Twitter Engagement Scraper — Checks engagement metrics on our own posted tweets.
 * Used for check-back system: scrapes likes/retweets/replies/views at 1h, 6h, 24h.
 */

import { Page } from 'puppeteer';
import { logger } from '../utils/logger';
import { formatError } from '../utils/errors';
import { delay } from '../utils/delay';
import { parseMetricFromAriaLabel } from './Twitter-Core';
import {
    TweetEngagement,
    getCheckBacksDue,
    updateCheckBack,
    TrackedTweet,
    CheckBack,
} from '../tracking/twitterContentTracker';
import { syncTweetSnapshotToSupabase } from '../db/supabaseTwitterContent';

// ── Scrape own tweet engagement ─────────────────────────────────────

/**
 * Navigate to a tweet URL and extract engagement metrics.
 */
export async function scrapeOwnTweetEngagement(page: Page, tweetUrl: string): Promise<TweetEngagement | null> {
    try {
        await page.goto(tweetUrl, { waitUntil: 'networkidle2', timeout: 20000 });
        await delay(2000);

        const metrics = await page.evaluate(() => {
            const result = { likes: 0, retweets: 0, replies: 0, views: 0, bookmarks: 0 };

            // Try aria-label approach on action buttons
            const buttons = document.querySelectorAll('button[data-testid]');
            for (const btn of buttons) {
                const testId = btn.getAttribute('data-testid') || '';
                const ariaLabel = btn.getAttribute('aria-label') || '';
                const match = ariaLabel.match(/([\d,]+)/);
                const count = match ? parseInt(match[1].replace(/,/g, ''), 10) : 0;

                if (testId === 'like' || testId === 'unlike') result.likes = count;
                if (testId === 'retweet') result.retweets = count;
                if (testId === 'reply') result.replies = count;
                if (testId === 'bookmark' || testId === 'removeBookmark') result.bookmarks = count;
            }

            // Views: try analytics link or view count display
            const viewElements = document.querySelectorAll('a[href*="/analytics"]');
            for (const el of viewElements) {
                const text = el.textContent || '';
                const viewMatch = text.replace(/,/g, '').match(/([\d.]+[KMB]?)\s*(views?|Views?)/i);
                if (viewMatch) {
                    result.views = parseCompactNumber(viewMatch[1]);
                }
            }

            // Fallback: look for view count in span near bottom of tweet
            if (result.views === 0) {
                const spans = document.querySelectorAll('span');
                for (const span of spans) {
                    const text = span.textContent || '';
                    if (/^\d[\d,.]*[KMB]?\s*views?$/i.test(text.trim())) {
                        const numMatch = text.trim().match(/([\d,.]+[KMB]?)/);
                        if (numMatch) result.views = parseCompactNumber(numMatch[1]);
                    }
                }
            }

            function parseCompactNumber(str: string): number {
                const clean = str.replace(/,/g, '');
                const multipliers: Record<string, number> = { K: 1000, M: 1000000, B: 1000000000 };
                const match = clean.match(/^([\d.]+)([KMB])?$/i);
                if (!match) return parseInt(clean, 10) || 0;
                const num = parseFloat(match[1]);
                const mult = match[2] ? multipliers[match[2].toUpperCase()] || 1 : 1;
                return Math.round(num * mult);
            }

            return result;
        });

        logger.info(`[engagement-scraper] Scraped ${tweetUrl}: ${metrics.likes}L/${metrics.retweets}RT/${metrics.replies}R/${metrics.views}V`);
        return metrics;
    } catch (e) {
        logger.warn(`[engagement-scraper] Failed to scrape ${tweetUrl}: ${formatError(e)}`);
        return null;
    }
}

// ── Process due check-backs ─────────────────────────────────────────

/**
 * Get due check-backs, scrape engagement for each, update tracker + Supabase.
 * @param maxChecks Maximum check-backs to process per run (default 5 to avoid rate limits).
 */
export async function processCheckBacks(page: Page, maxChecks: number = 5): Promise<number> {
    const due = getCheckBacksDue();

    if (due.length === 0) {
        logger.info('[engagement-scraper] No check-backs due');
        return 0;
    }

    logger.info(`[engagement-scraper] ${due.length} check-backs due, processing up to ${maxChecks}`);
    let processed = 0;

    for (const { tweet, checkBack } of due.slice(0, maxChecks)) {
        if (!tweet.tweetUrl) {
            logger.warn(`[engagement-scraper] Skipping check-back for tweet ${tweet.id} — no URL`);
            continue;
        }

        const metrics = await scrapeOwnTweetEngagement(page, tweet.tweetUrl);
        if (!metrics) continue;

        updateCheckBack(tweet.id, checkBack.period, metrics);

        // Fire-and-forget Supabase sync
        syncTweetSnapshotToSupabase(tweet.id, {
            ...checkBack,
            metrics,
            completedAt: new Date().toISOString(),
        }).catch(e => logger.warn(`[engagement-scraper] Supabase snapshot sync failed: ${formatError(e)}`));

        processed++;
        await delay(3000 + Math.random() * 2000); // 3-5s between checks
    }

    logger.info(`[engagement-scraper] Processed ${processed}/${due.length} check-backs`);
    return processed;
}
