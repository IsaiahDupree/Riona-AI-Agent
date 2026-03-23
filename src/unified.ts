/**
 * Unified Entry Point — replaces 5 PM2 processes with a single process.
 *
 * Registers one ServiceOrchestrator per service, wires each to the existing
 * scheduler logic via BrowserPool leases, starts the Express/WS server,
 * and hooks graceful shutdown.
 */

import dotenv from 'dotenv';
dotenv.config({ override: true });

import { ServiceOrchestrator, RunFunction } from './services/ServiceOrchestrator';
import { serviceRegistry } from './services/ServiceRegistry';
import { browserPool } from './browser/BrowserPool';
import { startServer } from './server/app';
import { attachWebSocket } from './server/wsHandler';
import { logger } from './utils/logger';
import { formatError } from './utils/errors';
import type { ServiceId, ServiceConfig, RunTrigger, RunResult } from './services/ServiceState';

// ── Helpers ──────────────────────────────────────────────────────────

function envInt(key: string, fallback: number): number {
    return parseInt(process.env[key] || String(fallback), 10);
}

// ── Service Configurations ───────────────────────────────────────────

const ACTIVE_START = envInt('ACTIVE_HOURS_START', 9);
const ACTIVE_END   = envInt('ACTIVE_HOURS_END', 22);

const configs: Record<ServiceId, ServiceConfig> = {
    'instagram-feed': {
        intervalMinutes: envInt('RUN_INTERVAL_MINUTES', 20),
        dailyTarget: envInt('DAILY_COMMENT_TARGET', 500),
        activeHoursStart: ACTIVE_START,
        activeHoursEnd: ACTIVE_END,
        postsPerRun: envInt('POSTS_PER_RUN', 15),
        browserProfile: 'chrome-profile',
    },
    'instagram-dm': {
        intervalMinutes: envInt('DM_CHECK_INTERVAL_MINUTES', 5),
        dailyTarget: envInt('DM_MAX_PER_DAY', 50),
        activeHoursStart: ACTIVE_START,
        activeHoursEnd: ACTIVE_END,
        postsPerRun: 0,
        browserProfile: 'chrome-profile-instagram-dm',
    },
    'threads': {
        intervalMinutes: envInt('THREADS_INTERVAL_MINUTES', 25),
        dailyTarget: envInt('THREADS_DAILY_TARGET', 200),
        activeHoursStart: ACTIVE_START,
        activeHoursEnd: ACTIVE_END,
        postsPerRun: envInt('THREADS_POSTS_PER_RUN', 10),
        browserProfile: 'chrome-profile-threads',
    },
    'twitter-feed': {
        intervalMinutes: envInt('TWITTER_INTERVAL_MINUTES', 20),
        dailyTarget: envInt('TWITTER_DAILY_TARGET', 500),
        activeHoursStart: ACTIVE_START,
        activeHoursEnd: ACTIVE_END,
        postsPerRun: envInt('TWITTER_POSTS_PER_RUN', 15),
        browserProfile: 'chrome-profile-twitter',
    },
    'twitter-dm': {
        intervalMinutes: envInt('TWITTER_DM_CHECK_INTERVAL_MINUTES', 5),
        dailyTarget: envInt('TWITTER_DM_MAX_PER_DAY', 50),
        activeHoursStart: ACTIVE_START,
        activeHoursEnd: ACTIVE_END,
        postsPerRun: 0,
        browserProfile: 'chrome-profile-twitter-dm',
    },
};

// ── Run Functions ────────────────────────────────────────────────────

/**
 * Instagram Feed — acquire browser, run batch, release
 */
const instagramFeedRun: RunFunction = async (trigger) => {
    const lease = await browserPool.acquire('instagram-feed', 'instagram-feed-run');
    try {
        const { runSingleBatch, runNicheBatch } = await import('./client/Instagram-AI');

        const BOT_USERNAME = process.env.INSTAGRAM_BOT_USERNAME || 'unknown';
        const POSTS_PER_RUN = envInt('POSTS_PER_RUN', 15);

        // For unified mode, always run a feed batch (niche rotation can be added later)
        const result = await runSingleBatch(BOT_USERNAME, undefined, true);
        const { commentsPosted, session, instagramAI } = result;

        // Run nurture engagement if instagramAI is available
        if (instagramAI) {
            try {
                const page = instagramAI.getPage();
                if (page) {
                    const { runIGNurtureEngagement } = await import('./client/Instagram-Nurture');
                    const nurtureResult = await runIGNurtureEngagement(page, 2, 3);
                    if (nurtureResult.commentsPosted > 0) {
                        logger.info(`[unified:instagram-feed] Nurture: ${nurtureResult.commentsPosted} comments`);
                    }
                }
            } catch (e) {
                logger.warn(`[unified:instagram-feed] Nurture failed (non-fatal): ${formatError(e)}`);
            }

            try { await instagramAI.close(); } catch (_) { /* already closed */ }
        }

        const errors = session.commentsFailed || 0;
        return {
            posted: commentsPosted,
            skipped: session.postsSkippedDuplicate || 0,
            errors,
            verified: session.commentsVerified || 0,
            duplicatesSkipped: session.postsSkippedDuplicate || 0,
            result: errors > 0 && commentsPosted === 0 ? 'error' as RunResult : commentsPosted > 0 ? 'success' as RunResult : 'partial' as RunResult,
        };
    } finally {
        lease.release();
    }
};

/**
 * Threads — acquire browser, run batch, release
 */
const threadsRun: RunFunction = async (trigger) => {
    const lease = await browserPool.acquire('threads', 'threads-run');
    try {
        const { runThreadsBatch } = await import('./client/Threads-AI');

        const BOT_USERNAME = process.env.THREADS_BOT_USERNAME || 'unknown';
        const POSTS_PER_RUN = envInt('THREADS_POSTS_PER_RUN', 10);

        const result = await runThreadsBatch(BOT_USERNAME, POSTS_PER_RUN);
        const { commentsPosted, session } = result;

        const errors = session.commentsFailed || 0;
        return {
            posted: commentsPosted,
            skipped: session.postsSkippedDuplicate || 0,
            errors,
            verified: session.commentsVerified || 0,
            duplicatesSkipped: session.postsSkippedDuplicate || 0,
            result: errors > 0 && commentsPosted === 0 ? 'error' as RunResult : commentsPosted > 0 ? 'success' as RunResult : 'partial' as RunResult,
        };
    } finally {
        lease.release();
    }
};

/**
 * Twitter Feed — acquire browser, run batch + content/nurture/notif, release
 */
const twitterFeedRun: RunFunction = async (trigger) => {
    const lease = await browserPool.acquire('twitter-feed', 'twitter-feed-run');
    try {
        const { runTwitterBatch } = await import('./client/Twitter-AI');

        const BOT_USERNAME = process.env.TWITTER_BOT_USERNAME || 'unknown';

        const result = await runTwitterBatch(BOT_USERNAME);
        const { commentsPosted, session, twitterAI } = result;

        // Nurture engagement
        if (twitterAI) {
            try {
                const page = twitterAI.getPage();
                if (page) {
                    const { runNurtureEngagement } = await import('./client/Twitter-Nurture');
                    const nurtureResult = await runNurtureEngagement(page, 3, 5);
                    if (nurtureResult.commentsPosted > 0) {
                        logger.info(`[unified:twitter-feed] Nurture: ${nurtureResult.commentsPosted} comments`);
                    }
                }
            } catch (e) {
                logger.warn(`[unified:twitter-feed] Nurture failed (non-fatal): ${formatError(e)}`);
            }

            try { await twitterAI.close(); } catch (_) { /* already closed */ }
        }

        const errors = session.repliesFailed || 0;
        return {
            posted: commentsPosted,
            skipped: session.tweetsSkippedDuplicate || 0,
            errors,
            verified: session.repliesVerified || 0,
            duplicatesSkipped: session.tweetsSkippedDuplicate || 0,
            result: errors > 0 && commentsPosted === 0 ? 'error' as RunResult : commentsPosted > 0 ? 'success' as RunResult : 'partial' as RunResult,
        };
    } finally {
        lease.release();
    }
};

/**
 * Instagram DM — acquire browser, run watcher check + pipeline cycle, release
 */
const instagramDMRun: RunFunction = async (trigger) => {
    const lease = await browserPool.acquire('instagram-dm', 'instagram-dm-run');
    try {
        const { InstagramDM } = await import('./client/Instagram-DM');
        const { checkForNewDMs } = await import('./client/Instagram-DM-Watcher');
        const { DMPipeline, loadPendingSends } = await import('./client/Instagram-DM-Pipeline');
        const { getTodayDMCount } = await import('./tracking/dmTracker');
        const { getTodayDMLimit } = await import('./config/dm-limits');

        // Create a lightweight DM client that wraps the pooled page
        const dm = new InstagramDM();
        await dm.initialize();

        const pipeline = new DMPipeline(dm, { autoApprove: true, maxDMsPerDay: getTodayDMLimit() });

        let posted = 0;
        let skipped = 0;
        let errors = 0;

        // 1. Process delayed replies that are ready
        try {
            const delayedResult = await pipeline.processDelayedReplies();
            posted += delayedResult.sent || 0;
        } catch (e) {
            logger.warn(`[unified:instagram-dm] Delayed replies failed: ${formatError(e)}`);
            errors++;
        }

        // 2. Check for new DMs
        try {
            const { newMessages } = await checkForNewDMs(dm);
            if (newMessages.length > 0) {
                logger.info(`[unified:instagram-dm] ${newMessages.length} new message(s)`);
                const replyResult = await pipeline.processDMAutoReplies();
                posted += replyResult.replied || 0;
                skipped += replyResult.skipped || 0;
            }
        } catch (e) {
            logger.warn(`[unified:instagram-dm] Watcher check failed: ${formatError(e)}`);
            errors++;
        }

        // 3. Process approved sends
        try {
            const pendingSends = loadPendingSends();
            const approved = pendingSends.filter((s: any) => s.status === 'approved');
            if (approved.length > 0) {
                const results = await pipeline.processApprovedSends();
                posted += results.filter((r: any) => r.status === 'sent').length;
                errors += results.filter((r: any) => r.status === 'failed').length;
            }
        } catch (e) {
            logger.warn(`[unified:instagram-dm] Approved sends failed: ${formatError(e)}`);
            errors++;
        }

        // Close the DM browser (it manages its own)
        try { await dm.close(); } catch (_) {}

        return {
            posted,
            skipped,
            errors,
            result: errors > 0 && posted === 0 ? 'error' as RunResult : posted > 0 ? 'success' as RunResult : 'partial' as RunResult,
        };
    } finally {
        lease.release();
    }
};

/**
 * Twitter DM — acquire browser, run watcher check + pipeline cycle, release
 */
const twitterDMRun: RunFunction = async (trigger) => {
    const lease = await browserPool.acquire('twitter-dm', 'twitter-dm-run');
    try {
        const { TwitterDM } = await import('./client/Twitter-DM');
        const { checkForNewTwitterDMs } = await import('./client/Twitter-DM-Watcher');
        const { TwitterDMPipeline, loadConfig: loadPipelineConfig } = await import('./client/Twitter-DM-Pipeline');
        const { getTodayTwitterDMCount } = await import('./tracking/twitterDMTracker');
        const { getTodayDMLimit } = await import('./config/dm-limits');

        const dm = new TwitterDM();
        await dm.initialize();

        const pipelineConfig = loadPipelineConfig();
        pipelineConfig.autoApprove = process.env.TWITTER_DM_AUTO_APPROVE === 'true';
        pipelineConfig.maxDMsPerDay = getTodayDMLimit();

        const pipeline = new TwitterDMPipeline(dm, pipelineConfig);

        let posted = 0;
        let skipped = 0;
        let errors = 0;

        // 1. Process delayed replies
        try {
            const delayedResult = await pipeline.processDelayedReplies();
            posted += delayedResult.sent || 0;
        } catch (e) {
            logger.warn(`[unified:twitter-dm] Delayed replies failed: ${formatError(e)}`);
            errors++;
        }

        // 2. Check for new DMs
        try {
            const detected = await checkForNewTwitterDMs(dm);
            if (detected.newMessages.length > 0) {
                logger.info(`[unified:twitter-dm] ${detected.newMessages.length} new message(s)`);
                const replyResult = await pipeline.processDMAutoReplies();
                posted += replyResult.replied || 0;
                skipped += replyResult.skipped || 0;
            }
        } catch (e) {
            logger.warn(`[unified:twitter-dm] Watcher check failed: ${formatError(e)}`);
            errors++;
        }

        // 3. Process approved sends
        try {
            const approvedResults = await pipeline.processApprovedSends();
            if (approvedResults.length > 0) {
                posted += approvedResults.filter((r: any) => r.status === 'sent').length;
                errors += approvedResults.filter((r: any) => r.status === 'failed').length;
            }
        } catch (e) {
            logger.warn(`[unified:twitter-dm] Approved sends failed: ${formatError(e)}`);
            errors++;
        }

        // Close the DM browser
        try { await dm.close(); } catch (_) {}

        return {
            posted,
            skipped,
            errors,
            result: errors > 0 && posted === 0 ? 'error' as RunResult : posted > 0 ? 'success' as RunResult : 'partial' as RunResult,
        };
    } finally {
        lease.release();
    }
};

// ── Bootstrap ────────────────────────────────────────────────────────

async function main() {
    logger.info('');
    logger.info('╔══════════════════════════════════════════════════════════╗');
    logger.info('║        Riona Unified Agent — All Services v1.0         ║');
    logger.info('╚══════════════════════════════════════════════════════════╝');
    logger.info('');

    // 1. Create and configure orchestrators
    const runFunctions: Record<ServiceId, RunFunction> = {
        'instagram-feed': instagramFeedRun,
        'instagram-dm': instagramDMRun,
        'threads': threadsRun,
        'twitter-feed': twitterFeedRun,
        'twitter-dm': twitterDMRun,
    };

    const serviceIds: ServiceId[] = ['instagram-feed', 'instagram-dm', 'threads', 'twitter-feed', 'twitter-dm'];

    for (const id of serviceIds) {
        const orchestrator = new ServiceOrchestrator(id, configs[id]);
        orchestrator.setRunFunction(runFunctions[id]);
        serviceRegistry.register(orchestrator);
        logger.info(`[unified] Registered service: ${id} (every ${configs[id].intervalMinutes}min)`);
    }

    // 2. Start Express server
    const server = await startServer();
    logger.info('[unified] Express server started');

    // 3. Attach WebSocket
    attachWebSocket(server);
    logger.info('[unified] WebSocket attached');

    // 4. Start all service schedulers
    serviceRegistry.startAll();
    logger.info('[unified] All services started');

    // 5. Graceful shutdown
    const shutdown = async (signal: string) => {
        logger.info(`[unified] ${signal} received — shutting down gracefully...`);

        try {
            await serviceRegistry.stopAll();
            logger.info('[unified] All services stopped');
        } catch (e) {
            logger.error(`[unified] Error stopping services: ${formatError(e)}`);
        }

        try {
            await browserPool.shutdownAll();
            logger.info('[unified] All browsers closed');
        } catch (e) {
            logger.error(`[unified] Error closing browsers: ${formatError(e)}`);
        }

        process.exit(0);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    // Keep alive — log unhandled errors but don't crash
    process.on('uncaughtException', (error) => {
        logger.error(`[unified] Uncaught Exception: ${formatError(error)}`);
    });
    process.on('unhandledRejection', (reason) => {
        logger.error(`[unified] Unhandled Rejection: ${formatError(reason)}`);
    });
}

main().catch((e) => {
    logger.error(`[unified] Fatal startup error: ${formatError(e)}`);
    process.exit(1);
});
