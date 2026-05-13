import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../utils/logger';
import { safeReadJSON, safeWriteJSON } from '../utils/errors';

// ── Types ─────────────────────────────────────────────────────────────

export interface CommentEngagement {
    checkedAt: string;         // ISO 8601 — when we checked back
    likes: number;             // likes on our comment
    replies: number;           // replies to our comment
    followedBack: boolean;     // did the post author follow us?
}

export interface TrackedComment {
    postUrl: string;           // permalink (e.g. https://instagram.com/p/ABC123/)
    postUsername: string;       // who posted it
    commentText: string;       // what we commented
    timestamp: string;         // ISO 8601
    verified: boolean;         // did we verify it appeared in DOM?
    sessionId: string;         // which scheduler run
    captionSnippet: string;    // first 100 chars of caption
    liked: boolean;            // did we also like?
    platform?: 'instagram' | 'threads';  // which platform
    engagement?: CommentEngagement;       // 24h check-back results
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
    date: string;              // YYYY-MM-DD
    totalComments: number;
    totalVerified: number;
    totalFailed: number;
    totalLikes: number;
    totalSessions: number;
    totalPostsProcessed: number;
    totalDuplicatesSkipped: number;
    uniqueUsersCommented: string[];
}

// ── File paths ────────────────────────────────────────────────────────

const DATA_DIR = path.join(process.cwd(), 'logs', 'tracking');
const COMMENTS_FILE = path.join(DATA_DIR, 'comments.json');
const SESSIONS_DIR = path.join(process.cwd(), 'logs', 'sessions');
const DAILY_STATS_FILE = path.join(DATA_DIR, 'daily_stats.json');

function ensureDirs() {
    for (const dir of [DATA_DIR, SESSIONS_DIR]) {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    }
}

// ── Comment persistence ──────────────────────────────────────────────

function loadComments(): TrackedComment[] {
    ensureDirs();
    return safeReadJSON<TrackedComment[]>(COMMENTS_FILE, [], 'comments');
}

function saveComments(comments: TrackedComment[]) {
    ensureDirs();
    if (!safeWriteJSON(COMMENTS_FILE, comments, 'comments')) {
        logger.error('[tracker] Comment data may be lost — write failed');
    }
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Check if we've already commented on a post URL (persistent check).
 * Returns the existing comment if found, null otherwise.
 */
export function hasCommentedOnPost(postUrl: string): TrackedComment | null {
    if (!postUrl) return null;
    const comments = loadComments();
    // Normalize URL: strip trailing slash, query params
    const normalize = (url: string) => url.replace(/\/$/, '').split('?')[0].toLowerCase();
    const normalizedTarget = normalize(postUrl);
    return comments.find(c => normalize(c.postUrl) === normalizedTarget) || null;
}

/**
 * Check if we've commented on a post by a specific user in the last N hours.
 * Prevents double-commenting on same user's different posts too quickly.
 */
export function recentCommentOnUser(username: string, withinHours = 2): TrackedComment | null {
    if (!username) return null;
    const comments = loadComments();
    const cutoff = new Date(Date.now() - withinHours * 60 * 60 * 1000).toISOString();
    return comments.find(c =>
        c.postUsername.toLowerCase() === username.toLowerCase() &&
        c.timestamp > cutoff
    ) || null;
}

/**
 * Record a comment that was posted.
 */
let trackCallCount = 0;

export function trackComment(comment: TrackedComment) {
    const comments = loadComments();
    comments.push(comment);
    saveComments(comments);
    logger.info(`[tracker] Recorded comment on ${comment.postUrl} by @${comment.postUsername}`);

    // Auto-cleanup every 100 tracked comments to prevent unbounded file growth
    trackCallCount++;
    if (trackCallCount % 100 === 0) {
        cleanupOldComments(30);
    }
}

/**
 * Get today's comment count from the tracker.
 */
export function getTodayCommentCount(): number {
    const today = todayStr();
    const comments = loadComments();
    return comments.filter(c => c.timestamp.startsWith(today)).length;
}

/**
 * Get today's verified comment count.
 */
export function getTodayVerifiedCount(): number {
    const today = todayStr();
    const comments = loadComments();
    return comments.filter(c => c.timestamp.startsWith(today) && c.verified).length;
}

/**
 * Get all comments for today.
 */
export function getTodayComments(): TrackedComment[] {
    const today = todayStr();
    const comments = loadComments();
    return comments.filter(c => c.timestamp.startsWith(today));
}

/**
 * Cleanup old comments (keep last 30 days).
 */
export function cleanupOldComments(daysToKeep = 30) {
    const cutoff = new Date(Date.now() - daysToKeep * 24 * 60 * 60 * 1000).toISOString();
    const comments = loadComments();
    const filtered = comments.filter(c => c.timestamp >= cutoff);
    if (filtered.length < comments.length) {
        saveComments(filtered);
        logger.info(`[tracker] Cleaned up ${comments.length - filtered.length} old comments`);
    }
}

// ── Comment Engagement Check-backs ──────────────────────────────────

/**
 * Get comments that are due for a 24h engagement check-back.
 * Returns comments posted 22-48h ago that haven't been checked yet.
 */
export function getCommentsNeedingCheckBack(platform?: 'instagram' | 'threads'): TrackedComment[] {
    const comments = loadComments();
    const now = Date.now();
    const minAge = 22 * 60 * 60 * 1000;  // 22h (slight buffer before 24h)
    const maxAge = 48 * 60 * 60 * 1000;  // 48h (don't bother after 2 days)

    return comments.filter(c => {
        if (c.engagement) return false; // already checked
        if (!c.verified) return false;  // unverified comments may not exist
        const age = now - new Date(c.timestamp).getTime();
        if (age < minAge || age > maxAge) return false;
        if (platform && c.platform && c.platform !== platform) return false;
        return true;
    });
}

/**
 * Record engagement results for a comment.
 */
export function updateCommentEngagement(postUrl: string, engagement: CommentEngagement): void {
    const comments = loadComments();
    const normalize = (url: string) => url.replace(/\/$/, '').split('?')[0].toLowerCase();
    const target = normalize(postUrl);
    const comment = comments.find(c => normalize(c.postUrl) === target);
    if (comment) {
        comment.engagement = engagement;
        saveComments(comments);
        logger.info(
            `[tracker] Engagement check-back for @${comment.postUsername}: ` +
            `${engagement.likes}L/${engagement.replies}R` +
            (engagement.followedBack ? ' +FOLLOW' : '')
        );
    }
}

/**
 * Get engagement performance summary for the last N days.
 * Useful for learning which niches/styles generate the most engagement.
 */
export function getEngagementSummary(daysBack = 7): {
    totalChecked: number;
    avgLikes: number;
    avgReplies: number;
    followRate: number;
    topPerformers: TrackedComment[];
} {
    const cutoff = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString();
    const comments = loadComments().filter(c =>
        c.engagement && c.timestamp >= cutoff
    );

    if (comments.length === 0) {
        return { totalChecked: 0, avgLikes: 0, avgReplies: 0, followRate: 0, topPerformers: [] };
    }

    const totalLikes = comments.reduce((s, c) => s + (c.engagement?.likes || 0), 0);
    const totalReplies = comments.reduce((s, c) => s + (c.engagement?.replies || 0), 0);
    const follows = comments.filter(c => c.engagement?.followedBack).length;

    // Top performers: comments that got the most engagement
    const sorted = [...comments].sort((a, b) =>
        ((b.engagement?.likes || 0) + (b.engagement?.replies || 0) * 3) -
        ((a.engagement?.likes || 0) + (a.engagement?.replies || 0) * 3)
    );

    return {
        totalChecked: comments.length,
        avgLikes: Math.round((totalLikes / comments.length) * 100) / 100,
        avgReplies: Math.round((totalReplies / comments.length) * 100) / 100,
        followRate: Math.round((follows / comments.length) * 100) / 100,
        topPerformers: sorted.slice(0, 5),
    };
}

// ── Session logging ──────────────────────────────────────────────────

export function createSession(): SessionLog {
    const sessionId = `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
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

        // Save JSON
        const jsonPath = path.join(SESSIONS_DIR, `${session.sessionId}.json`);
        fs.writeFileSync(jsonPath, JSON.stringify(session, null, 2));

        // Save markdown report
        const mdPath = path.join(SESSIONS_DIR, `${session.sessionId}.md`);
        fs.writeFileSync(mdPath, generateSessionMarkdown(session));

        logger.info(`[tracker] Session saved: ${session.sessionId}`);
    } catch (e) {
        logger.error('[tracker] Failed to save session', e);
    }
}

function generateSessionMarkdown(session: SessionLog): string {
    const duration = session.endTime
        ? Math.round((new Date(session.endTime).getTime() - new Date(session.startTime).getTime()) / 1000)
        : 0;

    const todayTotal = getTodayCommentCount();
    const todayVerified = getTodayVerifiedCount();

    let md = `# Session Report: ${session.sessionId}\n\n`;
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
    md += `| Other Skips | ${session.postsSkippedOther} |\n`;
    md += `| Likes | ${session.likesPosted} |\n`;
    md += `\n## Daily Progress\n`;
    md += `| Metric | Value |\n|--------|-------|\n`;
    md += `| Total Comments Today | ${todayTotal} |\n`;
    md += `| Verified Today | ${todayVerified} |\n`;
    const target = parseInt(process.env.DAILY_COMMENT_TARGET || '500', 10);
    md += `| Target | ${target} |\n`;
    md += `| Progress | ${Math.round((todayTotal / target) * 100)}% |\n`;

    if (session.comments.length > 0) {
        md += `\n## Comments Detail\n\n`;
        for (const c of session.comments) {
            md += `### @${c.postUsername}\n`;
            md += `- **Post**: ${c.postUrl}\n`;
            md += `- **Caption**: ${c.captionSnippet}\n`;
            md += `- **Comment**: "${c.commentText}"\n`;
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

        // Track unique users
        for (const c of session.comments) {
            if (!stats.uniqueUsersCommented.includes(c.postUsername)) {
                stats.uniqueUsersCommented.push(c.postUsername);
            }
        }

        fs.writeFileSync(DAILY_STATS_FILE, JSON.stringify(stats, null, 2));
    } catch (e) {
        logger.error('[tracker] Failed to update daily stats', e);
    }
}

export function getDailyStats(): DailyStats | null {
    const stats = safeReadJSON<DailyStats | null>(DAILY_STATS_FILE, null, 'daily_stats');
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
