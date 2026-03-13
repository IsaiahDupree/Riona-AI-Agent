import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../utils/logger';
import { safeReadJSON, safeWriteJSON } from '../utils/errors';

// ── Types ─────────────────────────────────────────────────────────────

export interface TrackedReply {
    tweetUrl: string;
    tweetAuthor: string;
    replyText: string;
    timestamp: string;
    verified: boolean;
    sessionId: string;
    tweetSnippet: string;
    liked: boolean;
    retweeted: boolean;
}

export interface SessionLog {
    sessionId: string;
    startTime: string;
    endTime?: string;
    tweetsProcessed: number;
    repliesPosted: number;
    repliesVerified: number;
    repliesFailed: number;
    tweetsSkippedDuplicate: number;
    tweetsSkippedOther: number;
    likesPosted: number;
    retweetsPosted: number;
    errors: string[];
    replies: TrackedReply[];
}

export interface DailyStats {
    date: string;
    totalReplies: number;
    totalVerified: number;
    totalFailed: number;
    totalLikes: number;
    totalRetweets: number;
    totalSessions: number;
    totalTweetsProcessed: number;
    totalDuplicatesSkipped: number;
    uniqueUsersReplied: string[];
}

// ── File paths ────────────────────────────────────────────────────────

const DATA_DIR = path.join(process.cwd(), 'logs', 'tracking', 'twitter');
const REPLIES_FILE = path.join(DATA_DIR, 'replies.json');
const SESSIONS_DIR = path.join(process.cwd(), 'logs', 'sessions', 'twitter');
const DAILY_STATS_FILE = path.join(DATA_DIR, 'daily_stats.json');

function ensureDirs() {
    for (const dir of [DATA_DIR, SESSIONS_DIR]) {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    }
}

// ── Reply persistence ──────────────────────────────────────────────

function loadReplies(): TrackedReply[] {
    ensureDirs();
    return safeReadJSON<TrackedReply[]>(REPLIES_FILE, [], 'twitter_replies');
}

function saveReplies(replies: TrackedReply[]) {
    ensureDirs();
    if (!safeWriteJSON(REPLIES_FILE, replies, 'twitter_replies')) {
        logger.error('[twitter-tracker] Reply data may be lost — write failed');
    }
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Check if we've already replied to a tweet URL (persistent check).
 * Returns the existing reply if found, null otherwise.
 */
export function hasRepliedToTweet(tweetUrl: string): TrackedReply | null {
    if (!tweetUrl) return null;
    const replies = loadReplies();
    const normalize = (url: string) => url.replace(/\/$/, '').split('?')[0].toLowerCase();
    const normalizedTarget = normalize(tweetUrl);
    return replies.find(r => normalize(r.tweetUrl) === normalizedTarget) || null;
}

/**
 * Check if we've replied to a tweet by a specific user in the last N hours.
 * Prevents double-replying on same user's different tweets too quickly.
 */
export function recentReplyToUser(username: string, withinHours = 2): TrackedReply | null {
    if (!username) return null;
    const replies = loadReplies();
    const cutoff = new Date(Date.now() - withinHours * 60 * 60 * 1000).toISOString();
    return replies.find(r =>
        r.tweetAuthor.toLowerCase() === username.toLowerCase() &&
        r.timestamp > cutoff
    ) || null;
}

/**
 * Record a reply that was posted.
 */
export function trackReply(reply: TrackedReply) {
    const replies = loadReplies();
    replies.push(reply);
    saveReplies(replies);
    logger.info(`[twitter-tracker] Recorded reply on ${reply.tweetUrl} by @${reply.tweetAuthor}`);
}

/**
 * Get today's reply count from the tracker.
 */
export function getTodayReplyCount(): number {
    const today = todayStr();
    const replies = loadReplies();
    return replies.filter(r => r.timestamp.startsWith(today)).length;
}

/**
 * Get today's verified reply count.
 */
export function getTodayVerifiedCount(): number {
    const today = todayStr();
    const replies = loadReplies();
    return replies.filter(r => r.timestamp.startsWith(today) && r.verified).length;
}

/**
 * Get all replies for today.
 */
export function getTodayReplies(): TrackedReply[] {
    const today = todayStr();
    const replies = loadReplies();
    return replies.filter(r => r.timestamp.startsWith(today));
}

/**
 * Cleanup old replies (keep last 30 days).
 */
export function cleanupOldReplies(daysToKeep = 30) {
    const cutoff = new Date(Date.now() - daysToKeep * 24 * 60 * 60 * 1000).toISOString();
    const replies = loadReplies();
    const filtered = replies.filter(r => r.timestamp >= cutoff);
    if (filtered.length < replies.length) {
        saveReplies(filtered);
        logger.info(`[twitter-tracker] Cleaned up ${replies.length - filtered.length} old replies`);
    }
}

// ── Session logging ──────────────────────────────────────────────────

export function createSession(): SessionLog {
    const sessionId = `twitter_session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    return {
        sessionId,
        startTime: new Date().toISOString(),
        tweetsProcessed: 0,
        repliesPosted: 0,
        repliesVerified: 0,
        repliesFailed: 0,
        tweetsSkippedDuplicate: 0,
        tweetsSkippedOther: 0,
        likesPosted: 0,
        retweetsPosted: 0,
        errors: [],
        replies: []
    };
}

export function saveSession(session: SessionLog) {
    try {
        ensureDirs();
        session.endTime = new Date().toISOString();

        // Save JSON
        const jsonPath = path.join(SESSIONS_DIR, `${session.sessionId}.json`);
        fs.writeFileSync(jsonPath, JSON.stringify(session, null, 2));

        // Save markdown report
        const mdPath = path.join(SESSIONS_DIR, `${session.sessionId}.md`);
        fs.writeFileSync(mdPath, generateSessionMarkdown(session));

        logger.info(`[twitter-tracker] Session saved: ${session.sessionId}`);
    } catch (e) {
        logger.error('[twitter-tracker] Failed to save session', e);
    }
}

function generateSessionMarkdown(session: SessionLog): string {
    const duration = session.endTime
        ? Math.round((new Date(session.endTime).getTime() - new Date(session.startTime).getTime()) / 1000)
        : 0;

    const todayTotal = getTodayReplyCount();
    const todayVerified = getTodayVerifiedCount();

    let md = `# Twitter Session Report: ${session.sessionId}\n\n`;
    md += `## Overview\n`;
    md += `| Metric | Value |\n|--------|-------|\n`;
    md += `| Start | ${session.startTime} |\n`;
    md += `| End | ${session.endTime || 'N/A'} |\n`;
    md += `| Duration | ${duration}s |\n`;
    md += `| Tweets Processed | ${session.tweetsProcessed} |\n`;
    md += `| Replies Posted | ${session.repliesPosted} |\n`;
    md += `| Replies Verified | ${session.repliesVerified} |\n`;
    md += `| Replies Failed | ${session.repliesFailed} |\n`;
    md += `| Duplicates Skipped | ${session.tweetsSkippedDuplicate} |\n`;
    md += `| Other Skips | ${session.tweetsSkippedOther} |\n`;
    md += `| Likes | ${session.likesPosted} |\n`;
    md += `| Retweets | ${session.retweetsPosted} |\n`;
    md += `\n## Daily Progress\n`;
    md += `| Metric | Value |\n|--------|-------|\n`;
    md += `| Total Replies Today | ${todayTotal} |\n`;
    md += `| Verified Today | ${todayVerified} |\n`;
    const target = parseInt(process.env.TWITTER_DAILY_TARGET || '500', 10);
    md += `| Target | ${target} |\n`;
    md += `| Progress | ${Math.round((todayTotal / target) * 100)}% |\n`;

    if (session.replies.length > 0) {
        md += `\n## Replies Detail\n\n`;
        for (const r of session.replies) {
            md += `### @${r.tweetAuthor}\n`;
            md += `- **Tweet**: ${r.tweetUrl}\n`;
            md += `- **Snippet**: ${r.tweetSnippet}\n`;
            md += `- **Reply**: "${r.replyText}"\n`;
            md += `- **Verified**: ${r.verified ? 'Yes' : 'No'}\n`;
            md += `- **Liked**: ${r.liked ? 'Yes' : 'No'}\n`;
            md += `- **Retweeted**: ${r.retweeted ? 'Yes' : 'No'}\n`;
            md += `- **Time**: ${r.timestamp}\n\n`;
        }
    }

    if (session.errors.length > 0) {
        md += `\n## Errors\n\n`;
        for (const e of session.errors) {
            md += `- ${e}\n`;
        }
    }

    return md;
}

// ── Daily stats ──────────────────────────────────────────────────────

export function updateDailyStats(session: SessionLog) {
    try {
        ensureDirs();
        const today = todayStr();
        let stats: DailyStats;

        if (fs.existsSync(DAILY_STATS_FILE)) {
            const existing = JSON.parse(fs.readFileSync(DAILY_STATS_FILE, 'utf8'));
            if (existing.date === today) {
                stats = existing;
            } else {
                stats = freshDailyStats(today);
            }
        } else {
            stats = freshDailyStats(today);
        }

        stats.totalReplies += session.repliesPosted;
        stats.totalVerified += session.repliesVerified;
        stats.totalFailed += session.repliesFailed;
        stats.totalLikes += session.likesPosted;
        stats.totalRetweets += session.retweetsPosted;
        stats.totalSessions += 1;
        stats.totalTweetsProcessed += session.tweetsProcessed;
        stats.totalDuplicatesSkipped += session.tweetsSkippedDuplicate;

        // Track unique users
        for (const r of session.replies) {
            if (!stats.uniqueUsersReplied.includes(r.tweetAuthor)) {
                stats.uniqueUsersReplied.push(r.tweetAuthor);
            }
        }

        fs.writeFileSync(DAILY_STATS_FILE, JSON.stringify(stats, null, 2));
    } catch (e) {
        logger.error('[twitter-tracker] Failed to update daily stats', e);
    }
}

export function getDailyStats(): DailyStats | null {
    const stats = safeReadJSON<DailyStats | null>(DAILY_STATS_FILE, null, 'twitter_daily_stats');
    if (stats && stats.date === todayStr()) return stats;
    return null;
}

// ── Helpers ──────────────────────────────────────────────────────────

function todayStr(): string {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function freshDailyStats(date: string): DailyStats {
    return {
        date,
        totalReplies: 0,
        totalVerified: 0,
        totalFailed: 0,
        totalLikes: 0,
        totalRetweets: 0,
        totalSessions: 0,
        totalTweetsProcessed: 0,
        totalDuplicatesSkipped: 0,
        uniqueUsersReplied: []
    };
}
