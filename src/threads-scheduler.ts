/**
 * Threads Scheduler — mirrors scheduler.ts but for threads.net
 * Runs as a separate PM2 process with its own Chrome instance
 */

import { runThreadsBatch } from './client/Threads-AI';
import { logger } from './utils/logger';
import { notifyRunComplete, notifyDailyTargetReached, notifyError, notifyStartup } from './utils/telegram';
import { getTodayCommentCount, getTodayVerifiedCount, cleanupOldComments } from './tracking/threadsTracker';
import { safeReadJSON, safeWriteJSON, formatError } from './utils/errors';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

dotenv.config({ override: true });

// ── Configuration ──────────────────────────────────────────────────
const DAILY_TARGET    = parseInt(process.env.THREADS_DAILY_TARGET || '200', 10);
const POSTS_PER_RUN   = parseInt(process.env.THREADS_POSTS_PER_RUN || '10', 10);
const ACTIVE_START    = parseInt(process.env.ACTIVE_HOURS_START || '9', 10);
const ACTIVE_END      = parseInt(process.env.ACTIVE_HOURS_END || '22', 10);
const INTERVAL_MIN    = parseInt(process.env.THREADS_INTERVAL_MINUTES || '25', 10);
const BOT_USERNAME    = process.env.THREADS_BOT_USERNAME || 'unknown';

// ── Daily counter (persisted to disk) ──────────────────────────────
const COUNTER_FILE = path.join(process.cwd(), 'logs', 'threads_daily_comments.json');
const LOCK_FILE = path.join(process.cwd(), 'logs', '.threads-scheduler.lock');

interface DailyCounter {
    date: string;
    count: number;
    verified: number;
    runs: number;
    lastRun: string;
    errors: number;
    duplicatesSkipped: number;
}

function todayStr(): string {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function loadCounter(): DailyCounter {
    const data = safeReadJSON<DailyCounter | null>(COUNTER_FILE, null, 'threads_counter');
    if (data && data.date === todayStr()) {
        const trackerCount = getTodayCommentCount();
        if (trackerCount > (data.count || 0)) {
            data.count = trackerCount;
            data.verified = getTodayVerifiedCount();
        }
        data.verified = data.verified || 0;
        data.errors = data.errors || 0;
        data.duplicatesSkipped = data.duplicatesSkipped || 0;
        return data;
    }
    return {
        date: todayStr(),
        count: getTodayCommentCount(),
        verified: getTodayVerifiedCount(),
        runs: 0,
        lastRun: '',
        errors: 0,
        duplicatesSkipped: 0
    };
}

function saveCounter(counter: DailyCounter) {
    if (!safeWriteJSON(COUNTER_FILE, counter, 'threads_counter')) {
        logger.error('[threads-scheduler] Failed to persist counter — data may be lost on restart');
    }
}

function isWithinActiveHours(): boolean {
    const hour = new Date().getHours();
    return hour >= ACTIVE_START && hour < ACTIVE_END;
}

// ── File-based lock ────────────────────────────────────────────────
function acquireLock(): boolean {
    try {
        const dir = path.dirname(LOCK_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        if (fs.existsSync(LOCK_FILE)) {
            try {
                const lockData = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
                const lockAge = Date.now() - lockData.timestamp;
                if (lockAge < 15 * 60 * 1000) {
                    logger.info(`[threads-scheduler] Lock exists (age: ${Math.round(lockAge / 1000)}s). Skipping.`);
                    return false;
                }
                logger.warn(`[threads-scheduler] Stale lock (${Math.round(lockAge / 60000)}min). Removing.`);
                fs.unlinkSync(LOCK_FILE);
            } catch (e) {
                logger.warn(`[threads-scheduler] Unreadable lock file, removing: ${formatError(e)}`);
                try { fs.unlinkSync(LOCK_FILE); } catch (unlinkErr) {
                    logger.warn(`[threads-scheduler] Failed to remove corrupt lock: ${formatError(unlinkErr)}`);
                }
            }
        }

        const fd = fs.openSync(LOCK_FILE, 'wx');
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, timestamp: Date.now(), startedAt: new Date().toISOString() }));
        fs.closeSync(fd);
        logger.info(`[threads-scheduler] Lock acquired (pid: ${process.pid})`);
        return true;
    } catch (e: any) {
        if (e.code === 'EEXIST') {
            logger.info('[threads-scheduler] Lock race prevented. Skipping.');
            return false;
        }
        logger.error('[threads-scheduler] Lock error', e);
        return false;
    }
}

function releaseLock() {
    try {
        if (fs.existsSync(LOCK_FILE)) fs.unlinkSync(LOCK_FILE);
    } catch (e) {
        logger.error('[threads-scheduler] Failed to release lock', e);
    }
}

// ── Scheduled run ──────────────────────────────────────────────────
let isRunning = false;

function tryScheduledRun() {
    if (isRunning) {
        logger.info('[threads-scheduler] Previous run still active, skipping');
        return;
    }
    isRunning = true;
    scheduledRun().finally(() => {
        isRunning = false;
        releaseLock();
    });
}

async function scheduledRun() {
    if (!acquireLock()) return;

    try {
        const counter = loadCounter();
        const trackerCount = getTodayCommentCount();
        const effectiveCount = Math.max(counter.count, trackerCount);

        if (effectiveCount >= DAILY_TARGET) {
            logger.info(`[threads-scheduler] Daily target reached (${effectiveCount}/${DAILY_TARGET}). Skipping.`);
            return;
        }

        if (!isWithinActiveHours()) {
            logger.info(`[threads-scheduler] Outside active hours (${ACTIVE_START}:00 - ${ACTIVE_END}:00). Skipping.`);
            return;
        }

        const remaining = DAILY_TARGET - effectiveCount;
        logger.info(`[threads-scheduler] ── Starting run #${counter.runs + 1} ──────────────────────`);
        logger.info(`[threads-scheduler] Today: ${effectiveCount}/${DAILY_TARGET} | ${remaining} remaining`);
        logger.info(`[threads-scheduler] Verified: ${getTodayVerifiedCount()} | Targeting ${POSTS_PER_RUN} posts`);

        const runStart = Date.now();
        const result = await runThreadsBatch(BOT_USERNAME, POSTS_PER_RUN);
        const { commentsPosted, session } = result;

        counter.count = getTodayCommentCount();
        counter.verified = getTodayVerifiedCount();
        counter.runs += 1;
        counter.lastRun = new Date().toISOString();
        counter.duplicatesSkipped += session.postsSkippedDuplicate;
        counter.errors += session.commentsFailed;
        saveCounter(counter);

        const durationSec = Math.round((Date.now() - runStart) / 1000);
        logger.info(`[threads-scheduler] ── Run #${counter.runs} complete ──────────────────────`);
        logger.info(`[threads-scheduler] Duration: ${durationSec}s`);
        logger.info(`[threads-scheduler] Comments: ${commentsPosted} (${session.commentsVerified} verified)`);
        logger.info(`[threads-scheduler] Duplicates skipped: ${session.postsSkippedDuplicate}`);
        logger.info(`[threads-scheduler] Errors: ${session.commentsFailed}`);
        logger.info(`[threads-scheduler] Today total: ${counter.count}/${DAILY_TARGET} | Verified: ${counter.verified}`);
        logger.info(`[threads-scheduler] Session: logs/threads-sessions/${session.sessionId}.md`);
        logger.info(`[threads-scheduler] ────────────────────────────────────────────`);

        // Telegram notification
        await notifyRunComplete({
            platform: 'Threads',
            runNumber: counter.runs,
            commentsPosted,
            commentsVerified: session.commentsVerified || 0,
            commentsFailed: session.commentsFailed || 0,
            duplicatesSkipped: session.postsSkippedDuplicate || 0,
            likesPosted: session.likesPosted || 0,
            durationSec,
            todayTotal: counter.count,
            todayVerified: counter.verified,
            dailyTarget: DAILY_TARGET,
            errors: session.errors || []
        });

        if (counter.count >= DAILY_TARGET && (counter.count - commentsPosted) < DAILY_TARGET) {
            await notifyDailyTargetReached('Threads', counter.count, DAILY_TARGET, counter.verified);
        }
    } catch (error) {
        logger.error('[threads-scheduler] Run failed:', error);
        await notifyError('Threads', error instanceof Error ? error.message : String(error));
        try {
            const counter = loadCounter();
            counter.errors += 1;
            counter.runs += 1;
            counter.lastRun = new Date().toISOString();
            saveCounter(counter);
        } catch (counterErr) {
            logger.error(`[threads-scheduler] Failed to update error counter: ${formatError(counterErr)}`);
        }
    }
}

// ── Startup ────────────────────────────────────────────────────────
const intervalMs = INTERVAL_MIN * 60 * 1000;

cleanupOldComments(30);
releaseLock();

logger.info('');
logger.info('╔══════════════════════════════════════════════════════════╗');
logger.info('║       Riona Threads Agent - Scheduler v1.0             ║');
logger.info('╠══════════════════════════════════════════════════════════╣');
logger.info(`║  Daily target:   ${String(DAILY_TARGET).padEnd(4)} comments                          ║`);
logger.info(`║  Posts per run:  ${String(POSTS_PER_RUN).padEnd(4)}                                   ║`);
logger.info(`║  Active hours:   ${String(ACTIVE_START).padStart(2, '0')}:00 - ${String(ACTIVE_END).padStart(2, '0')}:00                         ║`);
logger.info(`║  Run interval:   every ${String(INTERVAL_MIN).padEnd(3)} minutes                     ║`);
logger.info(`║  Bot account:    @${BOT_USERNAME.padEnd(37)}║`);
logger.info(`║  Chrome profile: chrome-profile-threads/               ║`);
logger.info(`║  Tracking:       logs/threads-tracking/                ║`);
logger.info('╚══════════════════════════════════════════════════════════╝');
logger.info('');

const counter = loadCounter();
const trackerCount = getTodayCommentCount();
logger.info(`[threads-scheduler] Today's progress: ${trackerCount}/${DAILY_TARGET} in ${counter.runs} runs (${getTodayVerifiedCount()} verified)`);

// Notify startup
notifyStartup('Threads', DAILY_TARGET, POSTS_PER_RUN, INTERVAL_MIN);

// Start initial run after 10s delay (offset from Instagram scheduler)
setTimeout(() => {
    logger.info('[threads-scheduler] Starting initial run (10s post-startup)');
    tryScheduledRun();
}, 10000);

// Schedule subsequent runs
setInterval(() => {
    logger.info(`[threads-scheduler] Timer triggered (every ${INTERVAL_MIN} min)`);
    tryScheduledRun();
}, intervalMs);

// Keep alive
process.on('uncaughtException', (error) => {
    logger.error('[threads-scheduler] Uncaught Exception:', error);
});
process.on('unhandledRejection', (reason) => {
    logger.error('[threads-scheduler] Unhandled Rejection:', reason);
});
