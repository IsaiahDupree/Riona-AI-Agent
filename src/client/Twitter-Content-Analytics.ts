/**
 * Twitter Content Analytics — Learning loop for content quality improvement.
 * Analyzes tweet performance by type/style/topic and generates learnings for AI prompts.
 */

import { logger } from '../utils/logger';
import { safeReadJSON, safeWriteJSON, formatError } from '../utils/errors';
import {
    getAllTrackedTweets,
    TrackedTweet,
    TweetEngagement,
    getPerformanceByType,
    getTopPerformers,
    getBottomPerformers,
} from '../tracking/twitterContentTracker';
import * as path from 'path';
import * as fs from 'fs';

// ── Interfaces ──────────────────────────────────────────────────────

export interface ContentLearning {
    contentType: string;
    style: string;
    avgLikes: number;
    avgRetweets: number;
    avgViews: number;
    engagementRate: number;
    sampleSize: number;
    bestTopics: string[];
    worstTopics: string[];
    recordedAt: string;
}

export interface OfferPerformance {
    offerId: string;
    mentions: number;
    avgLikes: number;
    avgRetweets: number;
    avgViews: number;
    engagementRate: number;
}

// ── File paths ──────────────────────────────────────────────────────

const ANALYTICS_DIR = path.join(process.cwd(), 'logs', 'tracking', 'twitter', 'analytics');
const LEARNINGS_FILE = path.join(ANALYTICS_DIR, 'content_learnings.json');

function ensureDir() {
    if (!fs.existsSync(ANALYTICS_DIR)) fs.mkdirSync(ANALYTICS_DIR, { recursive: true });
}

// ── Main analysis ───────────────────────────────────────────────────

/**
 * Analyze tracked tweet performance, group by type/style, compute averages.
 * Requires minimum 3 samples per group to generate learnings.
 */
export function analyzeContentPerformance(): ContentLearning[] {
    const tweets = getAllTrackedTweets().filter(t =>
        t.checkBacks.some(cb => cb.period === '24_hours' && cb.metrics)
    );

    if (tweets.length < 3) {
        logger.info(`[content-analytics] Only ${tweets.length} tweets with 24h data — need 3+ to analyze`);
        return [];
    }

    // Group by contentType/style
    const groups = new Map<string, TrackedTweet[]>();
    for (const tweet of tweets) {
        const key = `${tweet.contentType}/${tweet.style}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(tweet);
    }

    const learnings: ContentLearning[] = [];

    for (const [key, groupTweets] of groups.entries()) {
        if (groupTweets.length < 3) continue;

        const [contentType, style] = key.split('/');
        const metricsArr = groupTweets
            .map(t => t.checkBacks.find(cb => cb.period === '24_hours' && cb.metrics)?.metrics)
            .filter((m): m is TweetEngagement => m !== null && m !== undefined);

        const n = metricsArr.length;
        if (n === 0) continue;
        const avgLikes = Math.round(metricsArr.reduce((s, m) => s + m.likes, 0) / n);
        const avgRetweets = Math.round(metricsArr.reduce((s, m) => s + m.retweets, 0) / n);
        const avgViews = Math.round(metricsArr.reduce((s, m) => s + m.views, 0) / n);
        const totalEngagement = metricsArr.reduce((s, m) => s + m.likes + m.retweets + m.replies, 0);
        const totalViews = metricsArr.reduce((s, m) => s + m.views, 0);
        const engagementRate = totalViews > 0 ? totalEngagement / totalViews : 0;

        // Best/worst topics by engagement score
        const topicScores = new Map<string, number[]>();
        for (const tweet of groupTweets) {
            if (!tweet.topic) continue;
            if (!topicScores.has(tweet.topic)) topicScores.set(tweet.topic, []);
            const cb = tweet.checkBacks.find(c => c.period === '24_hours' && c.metrics);
            if (cb?.metrics) {
                topicScores.get(tweet.topic)!.push(
                    cb.metrics.likes + cb.metrics.retweets * 2 + cb.metrics.replies * 3
                );
            }
        }

        const topicAvgs = [...topicScores.entries()]
            .map(([topic, scores]) => ({
                topic,
                avg: scores.reduce((a, b) => a + b, 0) / scores.length,
            }))
            .sort((a, b) => b.avg - a.avg);

        learnings.push({
            contentType,
            style,
            avgLikes,
            avgRetweets,
            avgViews,
            engagementRate: Math.round(engagementRate * 10000) / 100, // percentage with 2 decimals
            sampleSize: n,
            bestTopics: topicAvgs.slice(0, 3).map(t => t.topic),
            worstTopics: topicAvgs.slice(-3).map(t => t.topic),
            recordedAt: new Date().toISOString(),
        });
    }

    // Save learnings
    ensureDir();
    safeWriteJSON(LEARNINGS_FILE, learnings, 'content_learnings');
    logger.info(`[content-analytics] Generated ${learnings.length} content learnings from ${tweets.length} tweets`);
    return learnings;
}

// ── Learning context for AI prompts ─────────────────────────────────

/**
 * Returns formatted string for AI prompt injection based on past performance.
 * Includes aggregate stats + top/bottom tweet examples for concrete guidance.
 */
export function getContentLearningContext(contentType?: string, style?: string): string {
    const learnings = safeReadJSON<ContentLearning[]>(LEARNINGS_FILE, [], 'content_learnings');

    const parts: string[] = [];

    // Aggregate stats from learnings
    if (learnings.length > 0) {
        if (contentType && style) {
            const specific = learnings.find(l => l.contentType === contentType && l.style === style);
            if (specific) {
                parts.push(`Your ${style} ${contentType} tweets avg ${specific.avgLikes} likes, ${specific.avgRetweets} RTs (${specific.sampleSize} samples, ${specific.engagementRate}% engagement rate).`);
                if (specific.bestTopics.length > 0) {
                    parts.push(`Best topics: ${specific.bestTopics.join(', ')}.`);
                }
            }
        }

        // Compare across types
        const sorted = [...learnings].sort((a, b) => b.engagementRate - a.engagementRate);
        if (sorted.length >= 2) {
            const best = sorted[0];
            const worst = sorted[sorted.length - 1];
            if (best.engagementRate > worst.engagementRate * 1.5) {
                parts.push(`${best.style} ${best.contentType} tweets outperform ${worst.style} ${worst.contentType} (${best.engagementRate}% vs ${worst.engagementRate}% engagement).`);
            }
        }

        // Highlight question tweets if they drive replies
        const questionLearning = learnings.find(l => l.style === 'question');
        if (questionLearning && contentType !== 'engagement') {
            parts.push(`Questions get ${questionLearning.avgLikes} likes avg — consider ending with a question.`);
        }
    }

    // Top performer examples — show the AI what worked
    try {
        const top = getTopPerformers(3);
        if (top.length > 0) {
            parts.push('\nYour best-performing tweets (study and emulate the tone/structure):');
            for (const tweet of top) {
                const cb = tweet.checkBacks.find(c => c.period === '24_hours' && c.metrics);
                if (cb?.metrics) {
                    const text = tweet.text.slice(0, 200);
                    parts.push(`- "${text}" (${cb.metrics.likes}L, ${cb.metrics.retweets}RT, ${cb.metrics.replies}R, ${cb.metrics.views}V)`);
                }
            }
        }
    } catch (_) { /* tracker not populated yet */ }

    // Bottom performer examples — show the AI what to avoid
    try {
        const bottom = getBottomPerformers(3);
        if (bottom.length > 0) {
            // Only show bottom if they're meaningfully worse than top
            const topScore = (() => {
                try { const t = getTopPerformers(1); return t[0] ? engagementScoreFromTweet(t[0]) : 0; } catch { return 0; }
            })();
            const bottomScore = engagementScoreFromTweet(bottom[0]);

            if (topScore > 0 && bottomScore < topScore * 0.3) {
                parts.push('\nYour worst-performing tweets (avoid this style/structure):');
                for (const tweet of bottom) {
                    const cb = tweet.checkBacks.find(c => c.period === '24_hours' && c.metrics);
                    if (cb?.metrics) {
                        const text = tweet.text.slice(0, 200);
                        parts.push(`- "${text}" (${cb.metrics.likes}L, ${cb.metrics.retweets}RT, ${cb.metrics.replies}R, ${cb.metrics.views}V)`);
                    }
                }
            }
        }
    } catch (_) { /* tracker not populated yet */ }

    return parts.length > 0 ? `Performance insights: ${parts.join(' ')}` : '';
}

/** Helper to compute engagement score from a TrackedTweet */
function engagementScoreFromTweet(tweet: TrackedTweet): number {
    const cb = tweet.checkBacks.find(c => c.period === '24_hours' && c.metrics);
    if (!cb?.metrics) return 0;
    return cb.metrics.likes + cb.metrics.retweets * 2 + cb.metrics.replies * 3;
}

// ── Offer performance ───────────────────────────────────────────────

export function getOfferPerformance(): OfferPerformance[] {
    const tweets = getAllTrackedTweets().filter(t =>
        t.offerId && t.checkBacks.some(cb => cb.period === '24_hours' && cb.metrics)
    );

    const groups = new Map<string, TweetEngagement[]>();
    for (const tweet of tweets) {
        if (!groups.has(tweet.offerId!)) groups.set(tweet.offerId!, []);
        const cb = tweet.checkBacks.find(c => c.period === '24_hours' && c.metrics);
        if (cb?.metrics) groups.get(tweet.offerId!)!.push(cb.metrics);
    }

    return [...groups.entries()].map(([offerId, metricsArr]) => {
        const n = metricsArr.length;
        const totalEng = metricsArr.reduce((s, m) => s + m.likes + m.retweets + m.replies, 0);
        const totalViews = metricsArr.reduce((s, m) => s + m.views, 0);
        return {
            offerId,
            mentions: n,
            avgLikes: Math.round(metricsArr.reduce((s, m) => s + m.likes, 0) / n),
            avgRetweets: Math.round(metricsArr.reduce((s, m) => s + m.retweets, 0) / n),
            avgViews: Math.round(metricsArr.reduce((s, m) => s + m.views, 0) / n),
            engagementRate: totalViews > 0 ? Math.round((totalEng / totalViews) * 10000) / 100 : 0,
        };
    });
}

// ── Best posting hours ──────────────────────────────────────────────

export function getBestPostingHours(): { hour: number; avgEngagement: number }[] {
    const tweets = getAllTrackedTweets().filter(t =>
        t.checkBacks.some(cb => cb.period === '24_hours' && cb.metrics)
    );

    const hourBuckets = new Map<number, number[]>();

    for (const tweet of tweets) {
        const hour = new Date(tweet.postedAt).getHours();
        if (!hourBuckets.has(hour)) hourBuckets.set(hour, []);
        const cb = tweet.checkBacks.find(c => c.period === '24_hours' && c.metrics);
        if (cb?.metrics) {
            hourBuckets.get(hour)!.push(
                cb.metrics.likes + cb.metrics.retweets * 2 + cb.metrics.replies * 3
            );
        }
    }

    return [...hourBuckets.entries()]
        .filter(([, scores]) => scores.length > 0)
        .map(([hour, scores]) => ({
            hour,
            avgEngagement: Math.round(scores.reduce((a, b) => a + b, 0) / scores.length),
        }))
        .sort((a, b) => b.avgEngagement - a.avgEngagement);
}

// ── Reply performance ───────────────────────────────────────────────

export function getReplyPerformance(): Record<string, { count: number; avgLikes: number }> {
    // This analyzes reply styles from the main tracker — placeholder for now
    // Will integrate with twitterTracker reply data when reply engagement tracking is added
    const perfByType = getPerformanceByType();
    const result: Record<string, { count: number; avgLikes: number }> = {};

    for (const [key, data] of Object.entries(perfByType)) {
        result[key] = { count: data.count, avgLikes: data.avgLikes };
    }

    return result;
}
