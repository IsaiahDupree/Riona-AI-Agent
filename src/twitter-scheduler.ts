import { logger } from './utils/logger';
import { notifyRunComplete, notifyDailyTargetReached, notifyError, notifyStartup } from './utils/telegram';
import { getTodayReplyCount, getTodayVerifiedCount, getDailyStats, cleanupOldReplies } from './tracking/twitterTracker';
import { safeReadJSON, safeWriteJSON, formatError } from './utils/errors';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

dotenv.config();

// ── Configuration (from .env) ──────────────────────────────────────
const DAILY_TARGET    = parseInt(process.env.TWITTER_DAILY_TARGET || '500', 10);
const POSTS_PER_RUN   = parseInt(process.env.TWITTER_POSTS_PER_RUN || '15', 10);
const ACTIVE_START    = parseInt(process.env.ACTIVE_HOURS_START || '9', 10);
const ACTIVE_END      = parseInt(process.env.ACTIVE_HOURS_END || '22', 10);
const INTERVAL_MIN    = parseInt(process.env.TWITTER_INTERVAL_MINUTES || '20', 10);
const BOT_USERNAME    = process.env.TWITTER_BOT_USERNAME || 'unknown';

// ── Niche configuration ────────────────────────────────────────────
const NICHE_SEARCH_TERMS = (process.env.TWITTER_NICHE_HASHTAGS || '').split(',').map(h => h.trim()).filter(Boolean);
const NICHE_POSTS     = parseInt(process.env.NICHE_POSTS_PER_RUN || '10', 10);
const NICHE_FREQUENCY = parseInt(process.env.NICHE_RUN_FREQUENCY || '3', 10); // every Nth run is a niche run
let nicheIndex = 0; // rotates through NICHE_SEARCH_TERMS

// ── Daily counter (persisted to disk so it survives restarts) ──────
const COUNTER_FILE = path.join(process.cwd(), 'logs', 'twitter_daily_comments.json');
const LOCK_FILE = path.join(process.cwd(), 'logs', '.twitter-scheduler.lock');

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
    const data = safeReadJSON<DailyCounter | null>(COUNTER_FILE, null, 'twitter_daily_counter');
    if (data && data.date === todayStr()) {
        const trackerCount = getTodayReplyCount();
        if (trackerCount > (data.count || 0)) {
            data.count = trackerCount;
            data.verified = getTodayVerifiedCount();
        }
        data.verified = data.verified || 0;
        data.errors = data.errors || 0;
        data.duplicatesSkipped = data.duplicatesSkipped || 0;
        return data;
    }
    const trackerCount = getTodayReplyCount();
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
    if (!safeWriteJSON(COUNTER_FILE, counter, 'twitter_daily_counter')) {
        logger.error('[twitter-scheduler] Failed to persist daily counter — data may be lost on restart');
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
                    logger.info(`[twitter-scheduler] Lock file exists (age: ${Math.round(lockAge / 1000)}s, pid: ${lockData.pid}). Skipping.`);
                    return false;
                }
                // Stale lock (> 15 min) - process probably crashed, remove it
                logger.warn(`[twitter-scheduler] Stale lock file (age: ${Math.round(lockAge / 60000)}min). Removing.`);
                fs.unlinkSync(LOCK_FILE);
            } catch (e) {
                logger.warn(`[twitter-scheduler] Unreadable lock file, removing: ${formatError(e)}`);
                try { fs.unlinkSync(LOCK_FILE); } catch (unlinkErr) {
                    logger.warn(`[twitter-scheduler] Failed to remove corrupt lock: ${formatError(unlinkErr)}`);
                }
            }
        }

        // ATOMIC lock creation using 'wx' flag (exclusive create - fails if file already exists)
        const fd = fs.openSync(LOCK_FILE, 'wx');
        fs.writeSync(fd, JSON.stringify({
            pid: process.pid,
            timestamp: Date.now(),
            startedAt: new Date().toISOString()
        }));
        fs.closeSync(fd);
        logger.info(`[twitter-scheduler] Lock acquired (pid: ${process.pid})`);
        return true;
    } catch (e: any) {
        if (e.code === 'EEXIST') {
            logger.info('[twitter-scheduler] Lock file already exists (race prevented). Skipping.');
            return false;
        }
        logger.error('[twitter-scheduler] Failed to acquire lock', e);
        return false;
    }
}

function releaseLock() {
    try {
        if (fs.existsSync(LOCK_FILE)) {
            fs.unlinkSync(LOCK_FILE);
        }
    } catch (e) {
        logger.error('[twitter-scheduler] Failed to release lock', e);
    }
}

// ── Single scheduled run ───────────────────────────────────────────
let isRunning = false;

function tryScheduledRun() {
    if (isRunning) {
        logger.info('[twitter-scheduler] Previous run still active, skipping');
        return;
    }
    isRunning = true;
    scheduledRun().finally(() => {
        isRunning = false;
        releaseLock();
    });
}

async function scheduledRun() {
    if (!acquireLock()) {
        return;
    }

    try {
        const counter = loadCounter();
        const trackerCount = getTodayReplyCount();
        const effectiveCount = Math.max(counter.count, trackerCount);

        if (effectiveCount >= DAILY_TARGET) {
            logger.info(`[twitter-scheduler] Daily target reached (${effectiveCount}/${DAILY_TARGET}). Skipping until tomorrow.`);
            return;
        }

        if (!isWithinActiveHours()) {
            logger.info(`[twitter-scheduler] Outside active hours (${ACTIVE_START}:00 - ${ACTIVE_END}:00). Skipping.`);
            return;
        }

        const remaining = DAILY_TARGET - effectiveCount;
        const runNumber = counter.runs + 1;
        const isNicheRun = NICHE_SEARCH_TERMS.length > 0 && NICHE_FREQUENCY > 0 && runNumber % NICHE_FREQUENCY === 0;
        const currentNiche = isNicheRun ? NICHE_SEARCH_TERMS[nicheIndex % NICHE_SEARCH_TERMS.length] : null;

        logger.info(`[twitter-scheduler] ── Starting run #${runNumber} ${isNicheRun ? `[NICHE: ${currentNiche}]` : '[FEED]'} ──────────────────────`);
        logger.info(`[twitter-scheduler] Today: ${effectiveCount}/${DAILY_TARGET} replies | ${remaining} remaining`);
        logger.info(`[twitter-scheduler] Verified: ${getTodayVerifiedCount()} | Targeting ${isNicheRun ? NICHE_POSTS : POSTS_PER_RUN} tweets`);

        const runStart = Date.now();

        // Import Twitter-AI dynamically to match the pattern
        const { runTwitterBatch, runTwitterNicheBatch, autoFollowProspects } = await import('./client/Twitter-AI');

        let repliesPosted: number;
        let session: any;
        let twitterAI: any;

        if (isNicheRun && currentNiche) {
            logger.info(`[twitter-scheduler] Running niche batch: ${currentNiche} (${NICHE_POSTS} tweets)`);
            const nicheResult = await runTwitterNicheBatch(currentNiche, NICHE_POSTS);
            repliesPosted = nicheResult.commentsPosted;
            session = nicheResult.session;
            twitterAI = nicheResult.twitterAI;
            nicheIndex++;
        } else {
            const result = await runTwitterBatch(BOT_USERNAME);
            repliesPosted = result.commentsPosted;
            session = result.session;
            twitterAI = result.twitterAI;
        }

        // ── Strategic content posting (calendar-driven) ─────────────────
        const FOLLOW_FREQUENCY = 4;
        const LAST_POST_RUN_FILE = path.join(process.cwd(), 'logs', 'config', 'last_post_run.json');

        if (twitterAI) {
            try {
                const page = twitterAI.getPage();
                if (page) {
                    const { shouldPostContent } = await import('./strategy/twitter-content-calendar');
                    const { postStrategicContent } = await import('./client/Twitter-AI');

                    const lastPostData = safeReadJSON<{ run: number }>(LAST_POST_RUN_FILE, { run: 0 }, 'last_post_run');
                    const lastPostRun = lastPostData.run;

                    if (shouldPostContent(runNumber, lastPostRun)) {
                        logger.info(`[twitter-scheduler] Run #${runNumber}: Posting strategic content`);
                        const contentResult = await postStrategicContent(page, runNumber);
                        if (contentResult.success) {
                            logger.info(`[twitter-scheduler] Strategic content posted successfully`);
                            safeWriteJSON(LAST_POST_RUN_FILE, { run: runNumber }, 'last_post_run');
                        }
                    }

                    // Auto-follow prospects periodically
                    if (runNumber % FOLLOW_FREQUENCY === 0) {
                        logger.info(`[twitter-scheduler] Run #${runNumber}: Auto-following prospects`);
                        const followResult = await autoFollowProspects(page, {
                            maxFollows: 3,
                            source: 'outreach_targets'
                        });
                        logger.info(`[twitter-scheduler] Followed ${followResult.followed.length} users`);
                    }

                    // Process engagement check-backs (max 5 per run)
                    try {
                        const { processCheckBacks } = await import('./client/Twitter-Engagement-Scraper');
                        await processCheckBacks(page, 5);
                    } catch (cbErr) {
                        logger.warn(`[twitter-scheduler] Check-back processing failed (non-fatal): ${formatError(cbErr)}`);
                    }

                    // Periodic learning analysis (every 10th run)
                    if (runNumber % 10 === 0) {
                        try {
                            const { analyzeContentPerformance } = await import('./client/Twitter-Content-Analytics');
                            analyzeContentPerformance();
                            logger.info(`[twitter-scheduler] Content performance analysis complete`);
                        } catch (analyticsErr) {
                            logger.warn(`[twitter-scheduler] Analytics failed (non-fatal): ${formatError(analyticsErr)}`);
                        }
                    }
                }
            } catch (contentErr) {
                logger.warn(`[twitter-scheduler] Content posting failed (non-fatal): ${formatError(contentErr)}`);
            }
        }

        // Close browser after content posting
        if (twitterAI) {
            try { await twitterAI.close(); } catch (e) { /* already closed */ }
        }

        counter.count = getTodayReplyCount();
        counter.verified = getTodayVerifiedCount();
        counter.runs += 1;
        counter.lastRun = new Date().toISOString();
        counter.duplicatesSkipped += session.tweetsSkippedDuplicate || 0;
        counter.errors += session.repliesFailed || 0;
        saveCounter(counter);

        const durationSec = Math.round((Date.now() - runStart) / 1000);
        logger.info(`[twitter-scheduler] ── Run #${counter.runs} complete ${isNicheRun ? `[NICHE: ${currentNiche}]` : '[FEED]'} ──────────────────────`);
        logger.info(`[twitter-scheduler] Duration: ${durationSec}s`);
        logger.info(`[twitter-scheduler] Replies this run: ${repliesPosted} (${session.repliesVerified || 0} verified)`);
        logger.info(`[twitter-scheduler] Duplicates skipped: ${session.tweetsSkippedDuplicate || 0}`);
        logger.info(`[twitter-scheduler] Errors: ${session.repliesFailed || 0}`);
        logger.info(`[twitter-scheduler] Today total: ${counter.count}/${DAILY_TARGET} | Verified: ${counter.verified}`);
        logger.info(`[twitter-scheduler] Session report: logs/sessions/twitter/${session.sessionId}.md`);
        logger.info(`[twitter-scheduler] ────────────────────────────────────────────`);

        // Telegram notification
        await notifyRunComplete({
            platform: 'Twitter',
            runNumber: counter.runs,
            commentsPosted: repliesPosted,
            commentsVerified: session.repliesVerified || 0,
            commentsFailed: session.repliesFailed || 0,
            duplicatesSkipped: session.tweetsSkippedDuplicate || 0,
            likesPosted: session.likesPosted || 0,
            durationSec,
            todayTotal: counter.count,
            todayVerified: counter.verified,
            dailyTarget: DAILY_TARGET,
            errors: session.errors || []
        });

        // Notify when target is reached
        if (counter.count >= DAILY_TARGET && (counter.count - repliesPosted) < DAILY_TARGET) {
            await notifyDailyTargetReached('Twitter', counter.count, DAILY_TARGET, counter.verified);
        }
    } catch (error) {
        logger.error('[twitter-scheduler] Run failed:', error);
        await notifyError('Twitter', error instanceof Error ? error.message : String(error));
        try {
            const counter = loadCounter();
            counter.errors += 1;
            counter.runs += 1;
            counter.lastRun = new Date().toISOString();
            saveCounter(counter);
        } catch (counterErr) {
            logger.error(`[twitter-scheduler] Failed to update error counter: ${formatError(counterErr)}`);
        }
    }
}

// ── Schedule ──────────────────────────────────────────────────────
const intervalMs = INTERVAL_MIN * 60 * 1000;

// Cleanup old tracking data and stale locks on startup
cleanupOldReplies(30);
releaseLock();

logger.info('');
logger.info('╔══════════════════════════════════════════════════════════╗');
logger.info('║       Riona Twitter Agent - Scheduler v1.0             ║');
logger.info('╠══════════════════════════════════════════════════════════╣');
logger.info(`║  Daily target:   ${String(DAILY_TARGET).padEnd(4)} replies                           ║`);
logger.info(`║  Tweets per run: ${String(POSTS_PER_RUN).padEnd(4)} (feed) / ${String(NICHE_POSTS).padEnd(4)} (niche)              ║`);
logger.info(`║  Active hours:   ${String(ACTIVE_START).padStart(2, '0')}:00 - ${String(ACTIVE_END).padStart(2, '0')}:00                         ║`);
logger.info(`║  Run interval:   every ${String(INTERVAL_MIN).padEnd(3)} minutes                     ║`);
logger.info(`║  Niche runs:     every ${NICHE_FREQUENCY}${NICHE_FREQUENCY === 1 ? 'st' : NICHE_FREQUENCY === 2 ? 'nd' : NICHE_FREQUENCY === 3 ? 'rd' : 'th'} run (${NICHE_SEARCH_TERMS.length} search terms)          ║`);
logger.info(`║  Bot account:    @${BOT_USERNAME.padEnd(37)}║`);
logger.info(`║  Tracking:       logs/tracking/twitter/ + sessions/     ║`);
logger.info('╚══════════════════════════════════════════════════════════╝');
if (NICHE_SEARCH_TERMS.length > 0) {
    logger.info(`[twitter-scheduler] Niche search terms: ${NICHE_SEARCH_TERMS.join(', ')}`);
}
logger.info('');

const counter = loadCounter();
const trackerCount = getTodayReplyCount();
logger.info(`[twitter-scheduler] Today's progress: ${trackerCount}/${DAILY_TARGET} replies in ${counter.runs} runs (${getTodayVerifiedCount()} verified)`);

// Notify startup
notifyStartup('Twitter', DAILY_TARGET, POSTS_PER_RUN, INTERVAL_MIN);

// Start initial run after a 5-second delay
setTimeout(() => {
    logger.info('[twitter-scheduler] Starting initial run (5s post-startup)');
    tryScheduledRun();
}, 5000);

// Schedule subsequent runs via setInterval
setInterval(() => {
    logger.info(`[twitter-scheduler] Timer triggered (every ${INTERVAL_MIN} min)`);
    tryScheduledRun();
}, intervalMs);

// Keep alive
process.on('uncaughtException', (error) => {
    logger.error('[twitter-scheduler] Uncaught Exception:', error);
});
process.on('unhandledRejection', (reason, promise) => {
    logger.error('[twitter-scheduler] Unhandled Rejection:', reason);
});
