import { runSingleBatch, runNicheBatch } from './client/Instagram-AI';
import { logger } from './utils/logger';
import { notifyRunComplete, notifyDailyTargetReached, notifyError, notifyStartup } from './utils/telegram';
import { getTodayCommentCount, getTodayVerifiedCount, getDailyStats, cleanupOldComments } from './tracking/commentTracker';
import { safeReadJSON, safeWriteJSON, formatError } from './utils/errors';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

dotenv.config();

// ── Configuration (from .env) ──────────────────────────────────────
const DAILY_TARGET    = parseInt(process.env.DAILY_COMMENT_TARGET || '500', 10);
const POSTS_PER_RUN   = parseInt(process.env.POSTS_PER_RUN || '15', 10);
const ACTIVE_START    = parseInt(process.env.ACTIVE_HOURS_START || '9', 10);
const ACTIVE_END      = parseInt(process.env.ACTIVE_HOURS_END || '22', 10);
const INTERVAL_MIN    = parseInt(process.env.RUN_INTERVAL_MINUTES || '20', 10);
const BOT_USERNAME    = process.env.INSTAGRAM_BOT_USERNAME || 'unknown';

// ── Niche configuration ────────────────────────────────────────────
const NICHE_HASHTAGS  = (process.env.NICHE_HASHTAGS || '').split(',').map(h => h.trim()).filter(Boolean);
const NICHE_POSTS     = parseInt(process.env.NICHE_POSTS_PER_RUN || '10', 10);
const NICHE_FREQUENCY = parseInt(process.env.NICHE_RUN_FREQUENCY || '3', 10); // every Nth run is a niche run
let nicheIndex = 0; // rotates through NICHE_HASHTAGS

// ── Daily counter (persisted to disk so it survives restarts) ──────
const COUNTER_FILE = path.join(process.cwd(), 'logs', 'daily_comments.json');
const LOCK_FILE = path.join(process.cwd(), 'logs', '.scheduler.lock');

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
    const data = safeReadJSON<DailyCounter | null>(COUNTER_FILE, null, 'daily_counter');
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
    const trackerCount = getTodayCommentCount();
    return {
        date: todayStr(),
        count: trackerCount,
        verified: getTodayVerifiedCount(),
        runs: 0,
        lastRun: '',
        errors: 0,
        duplicatesSkipped: 0
    };
}

function saveCounter(counter: DailyCounter) {
    if (!safeWriteJSON(COUNTER_FILE, counter, 'daily_counter')) {
        logger.error('[scheduler] Failed to persist daily counter — data may be lost on restart');
    }
}

// ── Active hours check ─────────────────────────────────────────────
function isWithinActiveHours(): boolean {
    const hour = new Date().getHours();
    return hour >= ACTIVE_START && hour < ACTIVE_END;
}

// ── File-based lock (prevents concurrent runs even across restarts) ──
function acquireLock(): boolean {
    try {
        const dir = path.dirname(LOCK_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        // Check if lock file exists and is recent (< 15 min old = still running)
        if (fs.existsSync(LOCK_FILE)) {
            try {
                const lockData = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
                const lockAge = Date.now() - lockData.timestamp;
                if (lockAge < 15 * 60 * 1000) {
                    logger.info(`[scheduler] Lock file exists (age: ${Math.round(lockAge / 1000)}s, pid: ${lockData.pid}). Skipping.`);
                    return false;
                }
                // Stale lock (> 15 min) - process probably crashed, remove it
                logger.warn(`[scheduler] Stale lock file (age: ${Math.round(lockAge / 60000)}min). Removing.`);
                fs.unlinkSync(LOCK_FILE);
            } catch (e) {
                // Can't read lock file, try to remove and continue
                logger.warn(`[scheduler] Unreadable lock file, removing: ${formatError(e)}`);
                try { fs.unlinkSync(LOCK_FILE); } catch (unlinkErr) {
                    logger.warn(`[scheduler] Failed to remove corrupt lock: ${formatError(unlinkErr)}`);
                }
            }
        }

        // ATOMIC lock creation using 'wx' flag (exclusive create - fails if file already exists)
        // This is the ONLY way to prevent two processes from both creating the lock
        const fd = fs.openSync(LOCK_FILE, 'wx');
        fs.writeSync(fd, JSON.stringify({
            pid: process.pid,
            timestamp: Date.now(),
            startedAt: new Date().toISOString()
        }));
        fs.closeSync(fd);
        logger.info(`[scheduler] Lock acquired (pid: ${process.pid})`);
        return true;
    } catch (e: any) {
        if (e.code === 'EEXIST') {
            // Another process already created the lock between our check and create
            logger.info('[scheduler] Lock file already exists (race prevented). Skipping.');
            return false;
        }
        logger.error('[scheduler] Failed to acquire lock', e);
        return false;
    }
}

function releaseLock() {
    try {
        if (fs.existsSync(LOCK_FILE)) {
            fs.unlinkSync(LOCK_FILE);
        }
    } catch (e) {
        logger.error('[scheduler] Failed to release lock', e);
    }
}

// ── Single scheduled run ───────────────────────────────────────────
let isRunning = false;

function tryScheduledRun() {
    // Synchronous guard — checked BEFORE entering async function
    // This is the ONLY place isRunning is checked, ensuring single-threaded safety
    if (isRunning) {
        logger.info('[scheduler] Previous run still active, skipping');
        return;
    }
    isRunning = true; // Set SYNCHRONOUSLY before any async work
    scheduledRun().finally(() => {
        isRunning = false;
        releaseLock();
    });
}

async function scheduledRun() {
    // File-based lock (cross-process / cross-restart)
    if (!acquireLock()) {
        return;
    }

    try {
        const counter = loadCounter();
        const trackerCount = getTodayCommentCount();
        const effectiveCount = Math.max(counter.count, trackerCount);

        if (effectiveCount >= DAILY_TARGET) {
            logger.info(`[scheduler] Daily target reached (${effectiveCount}/${DAILY_TARGET}). Skipping until tomorrow.`);
            return;
        }

        if (!isWithinActiveHours()) {
            logger.info(`[scheduler] Outside active hours (${ACTIVE_START}:00 - ${ACTIVE_END}:00). Skipping.`);
            return;
        }

        const remaining = DAILY_TARGET - effectiveCount;
        const runNumber = counter.runs + 1;
        const isNicheRun = NICHE_HASHTAGS.length > 0 && NICHE_FREQUENCY > 0 && runNumber % NICHE_FREQUENCY === 0;
        const currentNiche = isNicheRun ? NICHE_HASHTAGS[nicheIndex % NICHE_HASHTAGS.length] : null;

        logger.info(`[scheduler] ── Starting run #${runNumber} ${isNicheRun ? `[NICHE: #${currentNiche}]` : '[FEED]'} ──────────────────────`);
        logger.info(`[scheduler] Today: ${effectiveCount}/${DAILY_TARGET} comments | ${remaining} remaining`);
        logger.info(`[scheduler] Verified: ${getTodayVerifiedCount()} | Targeting ${isNicheRun ? NICHE_POSTS : POSTS_PER_RUN} posts`);

        const runStart = Date.now();
        let commentsPosted: number;
        let session: any;

        if (isNicheRun && currentNiche) {
            logger.info(`[scheduler] Running niche batch: #${currentNiche} (${NICHE_POSTS} posts)`);
            const nicheResult = await runNicheBatch(currentNiche, NICHE_POSTS);
            commentsPosted = nicheResult.commentsPosted;
            session = nicheResult.session;
            nicheIndex++; // rotate to next hashtag for next niche run
        } else {
            const result = await runSingleBatch(BOT_USERNAME);
            commentsPosted = result.commentsPosted;
            session = result.session;
        }

        counter.count = getTodayCommentCount();
        counter.verified = getTodayVerifiedCount();
        counter.runs += 1;
        counter.lastRun = new Date().toISOString();
        counter.duplicatesSkipped += session.postsSkippedDuplicate || 0;
        counter.errors += session.commentsFailed || 0;
        saveCounter(counter);

        const durationSec = Math.round((Date.now() - runStart) / 1000);
        logger.info(`[scheduler] ── Run #${counter.runs} complete ${isNicheRun ? `[NICHE: #${currentNiche}]` : '[FEED]'} ──────────────────────`);
        logger.info(`[scheduler] Duration: ${durationSec}s`);
        logger.info(`[scheduler] Comments this run: ${commentsPosted} (${session.commentsVerified || 0} verified)`);
        logger.info(`[scheduler] Duplicates skipped: ${session.postsSkippedDuplicate || 0}`);
        logger.info(`[scheduler] Errors: ${session.commentsFailed || 0}`);
        logger.info(`[scheduler] Today total: ${counter.count}/${DAILY_TARGET} | Verified: ${counter.verified}`);
        logger.info(`[scheduler] Session report: logs/sessions/${session.sessionId}.md`);
        logger.info(`[scheduler] ────────────────────────────────────────────`);

        // Telegram notification
        await notifyRunComplete({
            platform: 'Instagram',
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

        // Notify when target is reached
        if (counter.count >= DAILY_TARGET && (counter.count - commentsPosted) < DAILY_TARGET) {
            await notifyDailyTargetReached('Instagram', counter.count, DAILY_TARGET, counter.verified);
        }
    } catch (error) {
        logger.error('[scheduler] Run failed:', error);
        await notifyError('Instagram', error instanceof Error ? error.message : String(error));
        try {
            const counter = loadCounter();
            counter.errors += 1;
            counter.runs += 1;
            counter.lastRun = new Date().toISOString();
            saveCounter(counter);
        } catch (counterErr) {
            logger.error(`[scheduler] Failed to update error counter: ${formatError(counterErr)}`);
        }
    }
}

// ── Schedule ──────────────────────────────────────────────────────
// Using setInterval instead of node-cron to avoid double-fire bug in node-cron 3.x
const intervalMs = INTERVAL_MIN * 60 * 1000;

// Cleanup old tracking data and stale locks on startup
cleanupOldComments(30);
releaseLock(); // Clear any stale lock from previous crash

logger.info('');
logger.info('╔══════════════════════════════════════════════════════════╗');
logger.info('║       Riona Instagram Agent - Scheduler v3.1           ║');
logger.info('╠══════════════════════════════════════════════════════════╣');
logger.info(`║  Daily target:   ${String(DAILY_TARGET).padEnd(4)} comments                          ║`);
logger.info(`║  Posts per run:  ${String(POSTS_PER_RUN).padEnd(4)} (feed) / ${String(NICHE_POSTS).padEnd(4)} (niche)              ║`);
logger.info(`║  Active hours:   ${String(ACTIVE_START).padStart(2, '0')}:00 - ${String(ACTIVE_END).padStart(2, '0')}:00                         ║`);
logger.info(`║  Run interval:   every ${String(INTERVAL_MIN).padEnd(3)} minutes                     ║`);
logger.info(`║  Niche runs:     every ${NICHE_FREQUENCY}${NICHE_FREQUENCY === 1 ? 'st' : NICHE_FREQUENCY === 2 ? 'nd' : NICHE_FREQUENCY === 3 ? 'rd' : 'th'} run (${NICHE_HASHTAGS.length} hashtags)             ║`);
logger.info(`║  Bot account:    @${BOT_USERNAME.padEnd(37)}║`);
logger.info(`║  Tracking:       logs/tracking/ + logs/sessions/       ║`);
logger.info('╚══════════════════════════════════════════════════════════╝');
if (NICHE_HASHTAGS.length > 0) {
    logger.info(`[scheduler] Niche hashtags: ${NICHE_HASHTAGS.map(h => '#' + h).join(', ')}`);
}
logger.info('');

const counter = loadCounter();
const trackerCount = getTodayCommentCount();
logger.info(`[scheduler] Today's progress: ${trackerCount}/${DAILY_TARGET} comments in ${counter.runs} runs (${getTodayVerifiedCount()} verified)`);

// Notify startup
notifyStartup('Instagram', DAILY_TARGET, POSTS_PER_RUN, INTERVAL_MIN);

// Start initial run after a 5-second delay
setTimeout(() => {
    logger.info('[scheduler] Starting initial run (5s post-startup)');
    tryScheduledRun();
}, 5000);

// Schedule subsequent runs via setInterval (fires exactly once per interval)
setInterval(() => {
    logger.info(`[scheduler] Timer triggered (every ${INTERVAL_MIN} min)`);
    tryScheduledRun();
}, intervalMs);

// Keep alive
process.on('uncaughtException', (error) => {
    logger.error('[scheduler] Uncaught Exception:', error);
});
process.on('unhandledRejection', (reason, promise) => {
    logger.error('[scheduler] Unhandled Rejection:', reason);
});
