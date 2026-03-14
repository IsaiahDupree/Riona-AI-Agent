/**
 * Weekly Stats Aggregator — Persists daily totals and computes week-over-week trends.
 * Runs once per day (end of active hours) to snapshot the day's metrics.
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../utils/logger';
import { safeReadJSON, safeWriteJSON, formatError } from '../utils/errors';

// ── Interfaces ──────────────────────────────────────────────────────

export interface DailySnapshot {
    date: string; // YYYY-MM-DD
    instagram: {
        comments: number;
        verified: number;
        likes: number;
        sessions: number;
        uniqueUsers: number;
        dmsSent: number;
        dmsReceived: number;
    };
    twitter: {
        replies: number;
        verified: number;
        likes: number;
        sessions: number;
        uniqueUsers: number;
        dmsSent: number;
        dmsReceived: number;
        tweetsPosted: number;
    };
}

export interface WeeklyTrend {
    weekStart: string; // YYYY-MM-DD (Monday)
    weekEnd: string;
    instagram: {
        totalComments: number;
        totalDMs: number;
        avgCommentsPerDay: number;
        avgDMsPerDay: number;
        activeDays: number;
    };
    twitter: {
        totalReplies: number;
        totalDMs: number;
        totalTweets: number;
        avgRepliesPerDay: number;
        avgDMsPerDay: number;
        activeDays: number;
    };
}

export interface GrowthReport {
    currentWeek: WeeklyTrend;
    previousWeek: WeeklyTrend | null;
    growth: {
        igComments: { current: number; previous: number; changePercent: number | null };
        igDMs: { current: number; previous: number; changePercent: number | null };
        twReplies: { current: number; previous: number; changePercent: number | null };
        twDMs: { current: number; previous: number; changePercent: number | null };
        twTweets: { current: number; previous: number; changePercent: number | null };
    };
    generatedAt: string;
}

// ── File paths ──────────────────────────────────────────────────────

const STATS_DIR = path.join(process.cwd(), 'logs', 'tracking', 'weekly');
const SNAPSHOTS_FILE = path.join(STATS_DIR, 'daily_snapshots.json');
const TRENDS_FILE = path.join(STATS_DIR, 'weekly_trends.json');

function ensureDir() {
    if (!fs.existsSync(STATS_DIR)) fs.mkdirSync(STATS_DIR, { recursive: true });
}

// ── Capture daily snapshot ──────────────────────────────────────────

export async function captureDailySnapshot(): Promise<DailySnapshot> {
    const today = new Date().toISOString().split('T')[0];

    // Import trackers dynamically to avoid circular deps
    const { getDailyStats: getIGStats } = await import('./commentTracker');
    const { getDailyStats: getTWStats } = await import('./twitterTracker');
    const { getAllDMs } = await import('./dmTracker');
    const { getAllTwitterDMs } = await import('./twitterDMTracker');
    const { getAllTrackedTweets } = await import('./twitterContentTracker');

    const igStats = getIGStats();
    const twStats = getTWStats();
    const igDMs = getAllDMs();
    const twDMs = getAllTwitterDMs();
    const twTweets = getAllTrackedTweets();

    // Count today's DMs
    const todayStart = new Date(today).toISOString();
    const tomorrowStart = new Date(new Date(today).getTime() + 86400000).toISOString();

    const igDMsSentToday = igDMs.filter(dm =>
        dm.direction === 'outbound' && dm.timestamp >= todayStart && dm.timestamp < tomorrowStart
    ).length;
    const igDMsReceivedToday = igDMs.filter(dm =>
        dm.direction === 'inbound' && dm.timestamp >= todayStart && dm.timestamp < tomorrowStart
    ).length;
    const twDMsSentToday = twDMs.filter(dm =>
        dm.direction === 'outbound' && dm.timestamp >= todayStart && dm.timestamp < tomorrowStart
    ).length;
    const twDMsReceivedToday = twDMs.filter(dm =>
        dm.direction === 'inbound' && dm.timestamp >= todayStart && dm.timestamp < tomorrowStart
    ).length;

    // Count today's posted tweets
    const twTweetsToday = twTweets.filter(t =>
        t.postedAt >= todayStart && t.postedAt < tomorrowStart
    ).length;

    const snapshot: DailySnapshot = {
        date: today,
        instagram: {
            comments: igStats?.totalComments ?? 0,
            verified: igStats?.totalVerified ?? 0,
            likes: igStats?.totalLikes ?? 0,
            sessions: igStats?.totalSessions ?? 0,
            uniqueUsers: igStats?.uniqueUsersCommented?.length ?? 0,
            dmsSent: igDMsSentToday,
            dmsReceived: igDMsReceivedToday,
        },
        twitter: {
            replies: twStats?.totalReplies ?? 0,
            verified: twStats?.totalVerified ?? 0,
            likes: twStats?.totalLikes ?? 0,
            sessions: twStats?.totalSessions ?? 0,
            uniqueUsers: twStats?.uniqueUsersReplied?.length ?? 0,
            dmsSent: twDMsSentToday,
            dmsReceived: twDMsReceivedToday,
            tweetsPosted: twTweetsToday,
        },
    };

    // Save to snapshots file (append or update today's entry)
    ensureDir();
    const snapshots = safeReadJSON<DailySnapshot[]>(SNAPSHOTS_FILE, [], 'daily_snapshots');
    const existingIdx = snapshots.findIndex(s => s.date === today);
    if (existingIdx >= 0) {
        snapshots[existingIdx] = snapshot;
    } else {
        snapshots.push(snapshot);
    }

    // Keep last 90 days
    const cutoff = new Date(Date.now() - 90 * 86400000).toISOString().split('T')[0];
    const trimmed = snapshots.filter(s => s.date >= cutoff);
    safeWriteJSON(SNAPSHOTS_FILE, trimmed, 'daily_snapshots');

    logger.info(`[weekly-stats] Captured daily snapshot for ${today}: IG ${snapshot.instagram.comments} comments, ${snapshot.instagram.dmsSent} DMs | TW ${snapshot.twitter.replies} replies, ${snapshot.twitter.dmsSent} DMs, ${snapshot.twitter.tweetsPosted} tweets`);
    return snapshot;
}

// ── Compute weekly trend ────────────────────────────────────────────

function getMonday(date: Date): Date {
    const d = new Date(date);
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1);
    d.setDate(diff);
    d.setHours(0, 0, 0, 0);
    return d;
}

export function computeWeeklyTrend(weekStart: Date): WeeklyTrend {
    const snapshots = safeReadJSON<DailySnapshot[]>(SNAPSHOTS_FILE, [], 'daily_snapshots');
    const monday = getMonday(weekStart);
    const sunday = new Date(monday.getTime() + 6 * 86400000);
    const startStr = monday.toISOString().split('T')[0];
    const endStr = sunday.toISOString().split('T')[0];

    const weekSnaps = snapshots.filter(s => s.date >= startStr && s.date <= endStr);
    const days = weekSnaps.length || 1;

    const igComments = weekSnaps.reduce((s, d) => s + d.instagram.comments, 0);
    const igDMs = weekSnaps.reduce((s, d) => s + d.instagram.dmsSent, 0);
    const twReplies = weekSnaps.reduce((s, d) => s + d.twitter.replies, 0);
    const twDMs = weekSnaps.reduce((s, d) => s + d.twitter.dmsSent, 0);
    const twTweets = weekSnaps.reduce((s, d) => s + d.twitter.tweetsPosted, 0);

    return {
        weekStart: startStr,
        weekEnd: endStr,
        instagram: {
            totalComments: igComments,
            totalDMs: igDMs,
            avgCommentsPerDay: Math.round(igComments / days),
            avgDMsPerDay: Math.round(igDMs / days),
            activeDays: days,
        },
        twitter: {
            totalReplies: twReplies,
            totalDMs: twDMs,
            totalTweets: twTweets,
            avgRepliesPerDay: Math.round(twReplies / days),
            avgDMsPerDay: Math.round(twDMs / days),
            activeDays: days,
        },
    };
}

// ── Growth report ───────────────────────────────────────────────────

function pctChange(current: number, previous: number): number | null {
    if (previous === 0) return current > 0 ? 100 : null;
    return Math.round(((current - previous) / previous) * 100);
}

export function generateGrowthReport(): GrowthReport {
    const now = new Date();
    const thisMonday = getMonday(now);
    const lastMonday = new Date(thisMonday.getTime() - 7 * 86400000);

    const currentWeek = computeWeeklyTrend(thisMonday);
    const previousWeek = computeWeeklyTrend(lastMonday);
    const hasPrevious = previousWeek.instagram.totalComments > 0 || previousWeek.twitter.totalReplies > 0;

    const report: GrowthReport = {
        currentWeek,
        previousWeek: hasPrevious ? previousWeek : null,
        growth: {
            igComments: {
                current: currentWeek.instagram.totalComments,
                previous: previousWeek.instagram.totalComments,
                changePercent: pctChange(currentWeek.instagram.totalComments, previousWeek.instagram.totalComments),
            },
            igDMs: {
                current: currentWeek.instagram.totalDMs,
                previous: previousWeek.instagram.totalDMs,
                changePercent: pctChange(currentWeek.instagram.totalDMs, previousWeek.instagram.totalDMs),
            },
            twReplies: {
                current: currentWeek.twitter.totalReplies,
                previous: previousWeek.twitter.totalReplies,
                changePercent: pctChange(currentWeek.twitter.totalReplies, previousWeek.twitter.totalReplies),
            },
            twDMs: {
                current: currentWeek.twitter.totalDMs,
                previous: previousWeek.twitter.totalDMs,
                changePercent: pctChange(currentWeek.twitter.totalDMs, previousWeek.twitter.totalDMs),
            },
            twTweets: {
                current: currentWeek.twitter.totalTweets,
                previous: previousWeek.twitter.totalTweets,
                changePercent: pctChange(currentWeek.twitter.totalTweets, previousWeek.twitter.totalTweets),
            },
        },
        generatedAt: new Date().toISOString(),
    };

    // Save trends
    ensureDir();
    const trends = safeReadJSON<WeeklyTrend[]>(TRENDS_FILE, [], 'weekly_trends');
    const existingIdx = trends.findIndex(t => t.weekStart === currentWeek.weekStart);
    if (existingIdx >= 0) {
        trends[existingIdx] = currentWeek;
    } else {
        trends.push(currentWeek);
    }
    safeWriteJSON(TRENDS_FILE, trends, 'weekly_trends');

    return report;
}

// ── Pretty-print report ─────────────────────────────────────────────

function arrow(pct: number | null): string {
    if (pct === null) return '—';
    if (pct > 0) return `+${pct}%`;
    if (pct < 0) return `${pct}%`;
    return '0%';
}

export function formatGrowthReport(report: GrowthReport): string {
    const g = report.growth;
    const cw = report.currentWeek;
    const lines = [
        '╔══════════════════════════════════════════════════════════╗',
        '║              Weekly Growth Report                      ║',
        `║  Week: ${cw.weekStart} → ${cw.weekEnd}                  ║`,
        '╠══════════════════════════════════════════════════════════╣',
        '║  INSTAGRAM                                              ║',
        `║    Comments:  ${String(g.igComments.current).padStart(5)} (avg ${cw.instagram.avgCommentsPerDay}/day)  ${arrow(g.igComments.changePercent).padStart(8)} WoW  ║`,
        `║    DMs sent:  ${String(g.igDMs.current).padStart(5)} (avg ${cw.instagram.avgDMsPerDay}/day)  ${arrow(g.igDMs.changePercent).padStart(8)} WoW  ║`,
        '║                                                          ║',
        '║  TWITTER                                                 ║',
        `║    Replies:   ${String(g.twReplies.current).padStart(5)} (avg ${cw.twitter.avgRepliesPerDay}/day)  ${arrow(g.twReplies.changePercent).padStart(8)} WoW  ║`,
        `║    DMs sent:  ${String(g.twDMs.current).padStart(5)} (avg ${cw.twitter.avgDMsPerDay}/day)  ${arrow(g.twDMs.changePercent).padStart(8)} WoW  ║`,
        `║    Tweets:    ${String(g.twTweets.current).padStart(5)} (avg ${Math.round(cw.twitter.totalTweets / (cw.twitter.activeDays || 1))}/day)  ${arrow(g.twTweets.changePercent).padStart(8)} WoW  ║`,
        '║                                                          ║',
        `║  Active days: IG ${cw.instagram.activeDays}/7  |  TW ${cw.twitter.activeDays}/7               ║`,
        '╚══════════════════════════════════════════════════════════╝',
    ];
    return lines.join('\n');
}

// ── Get all snapshots (for external use) ────────────────────────────

export function getAllSnapshots(): DailySnapshot[] {
    return safeReadJSON<DailySnapshot[]>(SNAPSHOTS_FILE, [], 'daily_snapshots');
}

export function getSnapshotForDate(date: string): DailySnapshot | null {
    const snapshots = getAllSnapshots();
    return snapshots.find(s => s.date === date) || null;
}
