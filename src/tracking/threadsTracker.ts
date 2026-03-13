/**
 * Threads comment tracker — mirrors commentTracker.ts but uses separate files
 * so Threads and Instagram tracking don't interfere with each other.
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../utils/logger';
import { formatError } from '../utils/errors';

// ── Types (same interface as Instagram tracker) ──────────────────────

export interface TrackedComment {
    postUrl: string;
    postUsername: string;
    commentText: string;
    timestamp: string;
    verified: boolean;
    sessionId: string;
    captionSnippet: string;
    liked: boolean;
}

export interface SessionLog {
    sessionId: string;
    startTime: string;
    endTime?: string;
    postsProcessed: number;
    commentsPosted: number;
    commentsVerified: number;
    commentsFailed: number;
    postsSkippedDuplicate: number;
    postsSkippedOther: number;
    likesPosted: number;
    errors: string[];
    comments: TrackedComment[];
}

export interface DailyStats {
    date: string;
    totalComments: number;
    totalVerified: number;
    totalFailed: number;
    totalLikes: number;
    totalSessions: number;
    totalPostsProcessed: number;
    totalDuplicatesSkipped: number;
    uniqueUsersCommented: string[];
}

// ── File paths (separate from Instagram) ─────────────────────────────

const DATA_DIR = path.join(process.cwd(), 'logs', 'threads-tracking');
const COMMENTS_FILE = path.join(DATA_DIR, 'comments.json');
const SESSIONS_DIR = path.join(process.cwd(), 'logs', 'threads-sessions');
const DAILY_STATS_FILE = path.join(DATA_DIR, 'daily_stats.json');

function ensureDirs() {
    for (const dir of [DATA_DIR, SESSIONS_DIR]) {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    }
}

// ── Comment persistence ──────────────────────────────────────────────

function loadComments(): TrackedComment[] {
    try {
        ensureDirs();
        if (fs.existsSync(COMMENTS_FILE)) {
            return JSON.parse(fs.readFileSync(COMMENTS_FILE, 'utf8'));
        }
    } catch (e) {
        logger.error('[threads-tracker] Failed to load comments file', e);
    }
    return [];
}

function saveComments(comments: TrackedComment[]) {
    try {
        ensureDirs();
        fs.writeFileSync(COMMENTS_FILE, JSON.stringify(comments, null, 2));
    } catch (e) {
        logger.error('[threads-tracker] Failed to save comments file', e);
    }
}

// ── Public API ───────────────────────────────────────────────────────

export function hasCommentedOnPost(postUrl: string): TrackedComment | null {
    if (!postUrl) return null;
    const comments = loadComments();
    const normalize = (url: string) => url.replace(/\/$/, '').split('?')[0].toLowerCase();
    const target = normalize(postUrl);
    return comments.find(c => normalize(c.postUrl) === target) || null;
}

export function trackComment(comment: TrackedComment) {
    const comments = loadComments();
    comments.push(comment);
    saveComments(comments);
    logger.info(`[threads-tracker] Recorded comment on ${comment.postUrl} by @${comment.postUsername}`);
}

export function getTodayCommentCount(): number {
    const today = todayStr();
    return loadComments().filter(c => c.timestamp.startsWith(today)).length;
}

export function getTodayVerifiedCount(): number {
    const today = todayStr();
    return loadComments().filter(c => c.timestamp.startsWith(today) && c.verified).length;
}

export function cleanupOldComments(daysToKeep = 30) {
    const cutoff = new Date(Date.now() - daysToKeep * 24 * 60 * 60 * 1000).toISOString();
    const comments = loadComments();
    const filtered = comments.filter(c => c.timestamp >= cutoff);
    if (filtered.length < comments.length) {
        saveComments(filtered);
        logger.info(`[threads-tracker] Cleaned up ${comments.length - filtered.length} old comments`);
    }
}

// ── Session logging ──────────────────────────────────────────────────

export function createSession(): SessionLog {
    const sessionId = `threads_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    return {
        sessionId,
        startTime: new Date().toISOString(),
        postsProcessed: 0,
        commentsPosted: 0,
        commentsVerified: 0,
        commentsFailed: 0,
        postsSkippedDuplicate: 0,
        postsSkippedOther: 0,
        likesPosted: 0,
        errors: [],
        comments: []
    };
}

export function saveSession(session: SessionLog) {
    try {
        ensureDirs();
        session.endTime = new Date().toISOString();

        const jsonPath = path.join(SESSIONS_DIR, `${session.sessionId}.json`);
        fs.writeFileSync(jsonPath, JSON.stringify(session, null, 2));

        const mdPath = path.join(SESSIONS_DIR, `${session.sessionId}.md`);
        fs.writeFileSync(mdPath, generateSessionMarkdown(session));

        logger.info(`[threads-tracker] Session saved: ${session.sessionId}`);
    } catch (e) {
        logger.error('[threads-tracker] Failed to save session', e);
    }
}

function generateSessionMarkdown(session: SessionLog): string {
    const duration = session.endTime
        ? Math.round((new Date(session.endTime).getTime() - new Date(session.startTime).getTime()) / 1000)
        : 0;

    const todayTotal = getTodayCommentCount();
    const todayVerified = getTodayVerifiedCount();
    const target = parseInt(process.env.THREADS_DAILY_TARGET || '200', 10);

    let md = `# Threads Session: ${session.sessionId}\n\n`;
    md += `## Overview\n`;
    md += `| Metric | Value |\n|--------|-------|\n`;
    md += `| Start | ${session.startTime} |\n`;
    md += `| End | ${session.endTime || 'N/A'} |\n`;
    md += `| Duration | ${duration}s |\n`;
    md += `| Posts Processed | ${session.postsProcessed} |\n`;
    md += `| Comments Posted | ${session.commentsPosted} |\n`;
    md += `| Comments Verified | ${session.commentsVerified} |\n`;
    md += `| Comments Failed | ${session.commentsFailed} |\n`;
    md += `| Duplicates Skipped | ${session.postsSkippedDuplicate} |\n`;
    md += `| Likes | ${session.likesPosted} |\n`;
    md += `\n## Daily Progress\n`;
    md += `| Metric | Value |\n|--------|-------|\n`;
    md += `| Total Comments Today | ${todayTotal} |\n`;
    md += `| Verified Today | ${todayVerified} |\n`;
    md += `| Target | ${target} |\n`;
    md += `| Progress | ${Math.round((todayTotal / target) * 100)}% |\n`;

    if (session.comments.length > 0) {
        md += `\n## Comments Detail\n\n`;
        for (const c of session.comments) {
            md += `### @${c.postUsername}\n`;
            md += `- **Post**: ${c.postUrl}\n`;
            md += `- **Text**: ${c.captionSnippet}\n`;
            md += `- **Reply**: "${c.commentText}"\n`;
            md += `- **Verified**: ${c.verified ? 'Yes' : 'No'}\n`;
            md += `- **Liked**: ${c.liked ? 'Yes' : 'No'}\n`;
            md += `- **Time**: ${c.timestamp}\n\n`;
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

        stats.totalComments += session.commentsPosted;
        stats.totalVerified += session.commentsVerified;
        stats.totalFailed += session.commentsFailed;
        stats.totalLikes += session.likesPosted;
        stats.totalSessions += 1;
        stats.totalPostsProcessed += session.postsProcessed;
        stats.totalDuplicatesSkipped += session.postsSkippedDuplicate;

        for (const c of session.comments) {
            if (!stats.uniqueUsersCommented.includes(c.postUsername)) {
                stats.uniqueUsersCommented.push(c.postUsername);
            }
        }

        fs.writeFileSync(DAILY_STATS_FILE, JSON.stringify(stats, null, 2));
    } catch (e) {
        logger.error('[threads-tracker] Failed to update daily stats', e);
    }
}

export function getDailyStats(): DailyStats | null {
    try {
        if (fs.existsSync(DAILY_STATS_FILE)) {
            const stats = JSON.parse(fs.readFileSync(DAILY_STATS_FILE, 'utf8'));
            if (stats.date === todayStr()) return stats;
        }
    } catch (e) {
        logger.warn(`[threads-tracker] Failed to read daily stats: ${e instanceof Error ? e.message : String(e)}`);
    }
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
        totalComments: 0,
        totalVerified: 0,
        totalFailed: 0,
        totalLikes: 0,
        totalSessions: 0,
        totalPostsProcessed: 0,
        totalDuplicatesSkipped: 0,
        uniqueUsersCommented: []
    };
}
