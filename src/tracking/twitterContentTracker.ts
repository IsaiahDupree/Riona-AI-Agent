/**
 * Twitter Content Tracker — Tracks posted tweets with scheduled check-back periods.
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../utils/logger';
import { safeReadJSON, safeWriteJSON } from '../utils/errors';

// ── Interfaces ──────────────────────────────────────────────────────

export interface TweetEngagement {
    likes: number;
    retweets: number;
    replies: number;
    views: number;
    bookmarks: number;
}

export interface CheckBack {
    period: '1_hour' | '6_hours' | '24_hours';
    scheduledAt: string;
    completedAt?: string;
    metrics: TweetEngagement | null;
}

export interface TrackedTweet {
    id: string;
    tweetUrl: string;
    text: string;
    type: 'tweet' | 'thread' | 'quote';
    contentType: 'value' | 'engagement' | 'promotional' | 'personal';
    style: string;
    topic: string;
    niche: string;
    offerId?: string;
    postedAt: string;
    checkBacks: CheckBack[];
    threadTweets?: string[];
}

// ── File paths ──────────────────────────────────────────────────────

const DATA_DIR = path.join(process.cwd(), 'logs', 'tracking', 'twitter');
const POSTS_FILE = path.join(DATA_DIR, 'content_posts.json');

function ensureDir() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

// ── Persistence ─────────────────────────────────────────────────────

function loadTweets(): TrackedTweet[] {
    ensureDir();
    return safeReadJSON<TrackedTweet[]>(POSTS_FILE, [], 'content_posts');
}

function saveTweets(tweets: TrackedTweet[]) {
    ensureDir();
    if (!safeWriteJSON(POSTS_FILE, tweets, 'content_posts')) {
        logger.error('[content-tracker] Failed to save tracked tweets — data may be lost');
    }
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Track a posted tweet with auto-scheduled check-backs at 1h, 6h, 24h.
 */
export function trackTweet(tweet: Omit<TrackedTweet, 'id' | 'checkBacks'>): TrackedTweet {
    const now = new Date(tweet.postedAt || new Date().toISOString());
    const id = `tweet_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const tracked: TrackedTweet = {
        ...tweet,
        id,
        checkBacks: [
            {
                period: '1_hour',
                scheduledAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
                metrics: null,
            },
            {
                period: '6_hours',
                scheduledAt: new Date(now.getTime() + 6 * 60 * 60 * 1000).toISOString(),
                metrics: null,
            },
            {
                period: '24_hours',
                scheduledAt: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
                metrics: null,
            },
        ],
    };

    const tweets = loadTweets();
    tweets.push(tracked);
    saveTweets(tweets);
    logger.info(`[content-tracker] Tracked ${tweet.type} (${tweet.contentType}/${tweet.style}): "${tweet.text.slice(0, 60)}..."`);
    return tracked;
}

/**
 * Get check-backs that are past their scheduled time and not yet completed.
 */
export function getCheckBacksDue(): { tweet: TrackedTweet; checkBack: CheckBack }[] {
    const tweets = loadTweets();
    const now = new Date().toISOString();
    const due: { tweet: TrackedTweet; checkBack: CheckBack }[] = [];

    for (const tweet of tweets) {
        for (const cb of tweet.checkBacks) {
            if (!cb.completedAt && cb.scheduledAt <= now) {
                due.push({ tweet, checkBack: cb });
            }
        }
    }

    return due;
}

/**
 * Record engagement snapshot for a check-back period.
 */
export function updateCheckBack(tweetId: string, period: CheckBack['period'], metrics: TweetEngagement): void {
    const tweets = loadTweets();
    const tweet = tweets.find(t => t.id === tweetId);
    if (!tweet) {
        logger.warn(`[content-tracker] Tweet not found for check-back update: ${tweetId}`);
        return;
    }

    const cb = tweet.checkBacks.find(c => c.period === period);
    if (!cb) return;

    cb.metrics = metrics;
    cb.completedAt = new Date().toISOString();
    saveTweets(tweets);
    logger.info(`[content-tracker] Updated ${period} check-back for ${tweetId}: ${metrics.likes}L/${metrics.retweets}RT/${metrics.replies}R/${metrics.views}V`);
}

export function getAllTrackedTweets(): TrackedTweet[] {
    return loadTweets();
}

export function getTrackedTweet(id: string): TrackedTweet | undefined {
    return loadTweets().find(t => t.id === id);
}

/**
 * Top performers by engagement (likes + retweets + replies) from 24h check-back.
 */
export function getTopPerformers(n: number = 5): TrackedTweet[] {
    return loadTweets()
        .filter(t => t.checkBacks.some(cb => cb.period === '24_hours' && cb.metrics))
        .sort((a, b) => engagementScore(b) - engagementScore(a))
        .slice(0, n);
}

export function getBottomPerformers(n: number = 5): TrackedTweet[] {
    return loadTweets()
        .filter(t => t.checkBacks.some(cb => cb.period === '24_hours' && cb.metrics))
        .sort((a, b) => engagementScore(a) - engagementScore(b))
        .slice(0, n);
}

function engagementScore(tweet: TrackedTweet): number {
    const cb = tweet.checkBacks.find(c => c.period === '24_hours' && c.metrics);
    if (!cb?.metrics) return 0;
    return cb.metrics.likes + cb.metrics.retweets * 2 + cb.metrics.replies * 3;
}

/**
 * Cleanup old tracked tweets — keep tweets from the last N days.
 * Completed tweets older than the cutoff are removed to prevent unbounded growth.
 */
export function cleanupOldTweets(daysToKeep = 60) {
    const cutoff = new Date(Date.now() - daysToKeep * 24 * 60 * 60 * 1000).toISOString();
    const tweets = loadTweets();
    const filtered = tweets.filter(t => t.postedAt >= cutoff);
    if (filtered.length < tweets.length) {
        saveTweets(filtered);
        logger.info(`[content-tracker] Cleaned up ${tweets.length - filtered.length} old tracked tweets`);
    }
}

/**
 * Aggregate performance stats grouped by contentType, style, or topic.
 */
export function getPerformanceByType(): Record<string, { count: number; avgLikes: number; avgRetweets: number; avgViews: number }> {
    const tweets = loadTweets().filter(t => t.checkBacks.some(cb => cb.period === '24_hours' && cb.metrics));
    const groups: Record<string, { likes: number[]; retweets: number[]; views: number[] }> = {};

    for (const tweet of tweets) {
        const key = `${tweet.contentType}/${tweet.style}`;
        if (!groups[key]) groups[key] = { likes: [], retweets: [], views: [] };
        const cb = tweet.checkBacks.find(c => c.period === '24_hours' && c.metrics);
        if (cb?.metrics) {
            groups[key].likes.push(cb.metrics.likes);
            groups[key].retweets.push(cb.metrics.retweets);
            groups[key].views.push(cb.metrics.views);
        }
    }

    const result: Record<string, { count: number; avgLikes: number; avgRetweets: number; avgViews: number }> = {};
    for (const [key, data] of Object.entries(groups)) {
        const n = data.likes.length;
        result[key] = {
            count: n,
            avgLikes: Math.round(data.likes.reduce((a, b) => a + b, 0) / n),
            avgRetweets: Math.round(data.retweets.reduce((a, b) => a + b, 0) / n),
            avgViews: Math.round(data.views.reduce((a, b) => a + b, 0) / n),
        };
    }
    return result;
}
