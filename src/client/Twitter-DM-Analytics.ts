/**
 * Twitter DM Analytics — Timing stats and learning context
 * Mirrors Instagram-DM-Analytics timing/learning features for Twitter DMs
 */

import { logger } from '../utils/logger';
import { formatError } from '../utils/errors';
import { MessageFeedback, getFeedbackStats } from './Twitter-DM-AI';
import * as fs from 'fs';
import * as path from 'path';

const ANALYTICS_DIR = path.join(process.cwd(), 'logs', 'tracking', 'twitter-dm', 'analytics');
const LEARNINGS_FILE = path.join(ANALYTICS_DIR, 'learnings.json');
const TIMING_FILE = path.join(ANALYTICS_DIR, 'timing_stats.json');

function ensureDir() {
    if (!fs.existsSync(ANALYTICS_DIR)) fs.mkdirSync(ANALYTICS_DIR, { recursive: true });
}

// ── Message Effectiveness Learnings ─────────────────────────────────

export interface MessageLearning {
    id: string;
    category: string;
    stage: string;
    approach: string;
    replyRate: number;
    positiveSentimentRate: number;
    sampleSize: number;
    recordedAt: string;
    active: boolean;
}

function loadLearnings(): MessageLearning[] {
    try {
        ensureDir();
        if (fs.existsSync(LEARNINGS_FILE)) {
            return JSON.parse(fs.readFileSync(LEARNINGS_FILE, 'utf8'));
        }
    } catch (e) { logger.warn('[twitter-dm-analytics] Failed to load learnings: ' + formatError(e)); }
    return [];
}

function saveLearnings(learnings: MessageLearning[]) {
    ensureDir();
    fs.writeFileSync(LEARNINGS_FILE, JSON.stringify(learnings, null, 2));
}

/**
 * Get a learning summary string for the AI prompt context.
 * Injected into the system prompt to inform message generation.
 */
export function getLearningContextForAI(category: string, stage: string): string {
    const learnings = loadLearnings();
    if (learnings.length === 0) return '';

    const relevant = learnings.filter(l =>
        l.active && (
            (l.category === category && l.stage === stage) ||
            (l.category === category && l.stage === 'all') ||
            l.category === 'overall'
        )
    );

    if (relevant.length === 0) return '';

    const lines: string[] = ['Based on past performance data:'];
    for (const l of relevant) {
        if (l.category === 'overall') {
            lines.push(`- Overall: ${l.replyRate}% reply rate across ${l.sampleSize} messages`);
        } else {
            lines.push(`- ${l.category}/${l.stage}: ${l.replyRate}% reply rate, ${l.positiveSentimentRate}% positive (n=${l.sampleSize}). ${l.approach}`);
        }
    }

    return lines.join('\n');
}

/**
 * Analyze feedback data and generate learnings about what works.
 * Call periodically (e.g., from pipeline loop) to update AI understanding.
 */
export function analyzeFeedbackAndLearn(): MessageLearning[] {
    const feedbackFile = path.join(process.cwd(), 'logs', 'tracking', 'twitter-dm', 'feedback.json');
    let feedbacks: MessageFeedback[] = [];
    try {
        if (fs.existsSync(feedbackFile)) {
            feedbacks = JSON.parse(fs.readFileSync(feedbackFile, 'utf8'));
        }
    } catch (e) { logger.warn('[twitter-dm-analytics] Failed to load feedback file: ' + formatError(e)); }

    if (feedbacks.length < 5) {
        logger.info('[twitter-dm-analytics] Not enough feedback data to generate learnings (need 5+)');
        return [];
    }

    // Load relationship data to correlate with feedback
    const relDir = path.join(process.cwd(), 'logs', 'tracking', 'twitter-dm', 'relationships');
    const relationships: Record<string, any> = {};
    try {
        if (fs.existsSync(relDir)) {
            for (const f of fs.readdirSync(relDir).filter(f => f.endsWith('.json'))) {
                const username = f.replace('.json', '');
                relationships[username] = JSON.parse(fs.readFileSync(path.join(relDir, f), 'utf8'));
            }
        }
    } catch (e) { logger.warn('[twitter-dm-analytics] Failed to load relationships dir: ' + formatError(e)); }

    // Group feedbacks by category+stage
    const groups: Record<string, MessageFeedback[]> = {};
    for (const fb of feedbacks) {
        const rel = relationships[fb.recipientUsername.toLowerCase()];
        const key = rel ? `${rel.category}|${rel.stage}` : 'unknown|unknown';
        if (!groups[key]) groups[key] = [];
        groups[key].push(fb);
    }

    const learnings: MessageLearning[] = [];
    for (const [key, group] of Object.entries(groups)) {
        if (group.length < 3) continue;

        const [category, stage] = key.split('|');
        const gotReply = group.filter(f => f.gotReply).length;
        const positive = group.filter(f => f.replySentiment === 'positive').length;
        const replyRate = Math.round((gotReply / group.length) * 100);
        const posRate = gotReply > 0 ? Math.round((positive / gotReply) * 100) : 0;

        let approach = 'standard outreach';
        if (replyRate >= 50) approach = 'high-performing approach';
        else if (replyRate >= 30) approach = 'moderate engagement';
        else approach = 'low engagement — consider adjusting tone/content';

        const responseTimes = group.filter(f => f.replyWithinHours).map(f => f.replyWithinHours!);
        if (responseTimes.length > 0) {
            const avgResponseTime = responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length;
            if (avgResponseTime < 2) approach += ' (fast responses — high interest)';
            else if (avgResponseTime > 24) approach += ' (slow responses — lukewarm interest)';
        }

        learnings.push({
            id: `learn_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            category,
            stage,
            approach,
            replyRate,
            positiveSentimentRate: posRate,
            sampleSize: group.length,
            recordedAt: new Date().toISOString(),
            active: true
        });
    }

    // Overall stats
    const overallReplyRate = feedbacks.length > 0
        ? Math.round((feedbacks.filter(f => f.gotReply).length / feedbacks.length) * 100)
        : 0;

    learnings.push({
        id: `learn_overall_${Date.now()}`,
        category: 'overall',
        stage: 'all',
        approach: `Overall reply rate: ${overallReplyRate}% across ${feedbacks.length} messages`,
        replyRate: overallReplyRate,
        positiveSentimentRate: feedbacks.length > 0
            ? Math.round((feedbacks.filter(f => f.replySentiment === 'positive').length / feedbacks.length) * 100)
            : 0,
        sampleSize: feedbacks.length,
        recordedAt: new Date().toISOString(),
        active: true
    });

    saveLearnings(learnings);
    logger.info(`[twitter-dm-analytics] Generated ${learnings.length} learnings from ${feedbacks.length} feedback entries`);
    return learnings;
}

// ── Timing Analytics ────────────────────────────────────────────────

interface TimingEntry {
    hour: number;       // 0-23
    dayOfWeek: number;  // 0=Sun, 6=Sat
    sent: number;
    gotReply: number;
}

function loadTimingStats(): TimingEntry[] {
    try {
        ensureDir();
        if (fs.existsSync(TIMING_FILE)) {
            return JSON.parse(fs.readFileSync(TIMING_FILE, 'utf8'));
        }
    } catch (e) { logger.warn('[twitter-dm-analytics] Failed to load timing stats: ' + formatError(e)); }
    // Initialize with empty slots
    const entries: TimingEntry[] = [];
    for (let day = 0; day < 7; day++) {
        for (let hour = 0; hour < 24; hour++) {
            entries.push({ hour, dayOfWeek: day, sent: 0, gotReply: 0 });
        }
    }
    return entries;
}

function saveTimingStats(stats: TimingEntry[]) {
    ensureDir();
    fs.writeFileSync(TIMING_FILE, JSON.stringify(stats, null, 2));
}

export function recordTimingStat(sentAt: Date, gotReply: boolean) {
    const stats = loadTimingStats();
    const hour = sentAt.getHours();
    const day = sentAt.getDay();
    const entry = stats.find(e => e.hour === hour && e.dayOfWeek === day);
    if (entry) {
        entry.sent++;
        if (gotReply) entry.gotReply++;
    }
    saveTimingStats(stats);
}

/**
 * Get the best hours to send DMs based on historical reply rates.
 */
export function getBestSendingHours(): Array<{ hour: number; replyRate: number; sampleSize: number }> {
    const stats = loadTimingStats();

    const byHour: Record<number, { sent: number; replied: number }> = {};
    for (const entry of stats) {
        if (!byHour[entry.hour]) byHour[entry.hour] = { sent: 0, replied: 0 };
        byHour[entry.hour].sent += entry.sent;
        byHour[entry.hour].replied += entry.gotReply;
    }

    return Object.entries(byHour)
        .filter(([_, v]) => v.sent >= 3)
        .map(([hour, v]) => ({
            hour: parseInt(hour),
            replyRate: Math.round((v.replied / v.sent) * 100),
            sampleSize: v.sent
        }))
        .sort((a, b) => b.replyRate - a.replyRate);
}

/**
 * Check if now is a good time to send DMs based on historical data.
 */
export function isGoodSendingTime(): { good: boolean; reason: string } {
    const now = new Date();
    const hour = now.getHours();

    const activeStart = parseInt(process.env.ACTIVE_HOURS_START || '9');
    const activeEnd = parseInt(process.env.ACTIVE_HOURS_END || '22');
    if (hour < activeStart || hour >= activeEnd) {
        return { good: false, reason: `Outside active hours (${activeStart}-${activeEnd})` };
    }

    const bestHours = getBestSendingHours();
    if (bestHours.length === 0) {
        return { good: true, reason: 'No historical data — within active hours' };
    }

    const currentHourData = bestHours.find(h => h.hour === hour);
    if (currentHourData && currentHourData.replyRate >= 30) {
        return { good: true, reason: `Hour ${hour} has ${currentHourData.replyRate}% reply rate` };
    }

    const nextGood = bestHours.find(h => h.hour > hour && h.replyRate >= 30);
    if (nextGood) {
        return { good: false, reason: `Better to wait for hour ${nextGood.hour} (${nextGood.replyRate}% reply rate)` };
    }

    return { good: true, reason: 'Within active hours, no strong timing signal' };
}
