/**
 * DM Scheduler — PM2 entry point
 * Monitors Instagram DMs for new messages, processes approved sends,
 * runs outreach pipeline, and updates feedback loop
 */

import { InstagramDM } from './client/Instagram-DM';
import { startDMWatcher, checkForNewDMs } from './client/Instagram-DM-Watcher';
import { DMPipeline, loadConfig, loadPendingSends } from './client/Instagram-DM-Pipeline';
import { getTodayDMCount } from './tracking/dmTracker';
import { isGoodSendingTime, analyzeFeedbackAndLearn } from './client/Instagram-DM-Analytics';
import { logger } from './utils/logger';
import { safeReadJSON, safeWriteJSON, formatError } from './utils/errors';
import * as path from 'path';

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

const CHECK_INTERVAL = parseInt(process.env.DM_CHECK_INTERVAL_MINUTES || '5', 10) * 60 * 1000;
const PIPELINE_INTERVAL = parseInt(process.env.DM_PIPELINE_INTERVAL_MINUTES || '30', 10) * 60 * 1000;
const TARGETS_FILE = path.join(process.cwd(), 'logs', 'tracking', 'dm', 'outreach_targets.json');

(async () => {
    const config = loadConfig();
    console.log('');
    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log('║       Riona Instagram DM System v2.0                   ║');
    console.log('╠══════════════════════════════════════════════════════════╣');
    console.log(`║  DM check:       every ${CHECK_INTERVAL / 60000} minutes                        ║`);
    console.log(`║  Pipeline:       every ${PIPELINE_INTERVAL / 60000} minutes                       ║`);
    console.log(`║  Auto-approve:   ${config.autoApprove ? 'ON' : 'OFF'}                              ║`);
    console.log(`║  Max DMs/day:    ${config.maxDMsPerDay}                                ║`);
    console.log(`║  Bot account:    @${process.env.INSTAGRAM_BOT_USERNAME || 'the_isaiah_dupree'}                    ║`);
    console.log('╚══════════════════════════════════════════════════════════╝');
    console.log('');

    const dm = new InstagramDM();

    try {
        await dm.initialize();
        logger.info('[dm-scheduler] Browser initialized');

        // ── DM Watcher Loop (check for new messages) ──
        async function watcherLoop() {
            while (true) {
                try {
                    const { newMessages } = await checkForNewDMs(dm);
                    if (newMessages.length > 0) {
                        logger.info(`[dm-scheduler] ${newMessages.length} new message(s) detected`);
                    }
                } catch (e) {
                    logger.error(`[dm-scheduler] Watcher error: ${formatError(e)}`);
                }
                await delay(CHECK_INTERVAL);
            }
        }

        // ── Pipeline Loop (process approved sends + outreach) ──
        async function pipelineLoop() {
            // Wait a bit before starting pipeline to let watcher settle
            await delay(30000);

            while (true) {
                try {
                    const pipeline = new DMPipeline(dm);
                    const pConfig = loadConfig();
                    const todayCount = getTodayDMCount();

                    // 1. Process approved sends first
                    const pendingSends = loadPendingSends();
                    const approved = pendingSends.filter(s => s.status === 'approved');
                    if (approved.length > 0) {
                        logger.info(`[dm-scheduler] Processing ${approved.length} approved send(s)...`);
                        const results = await pipeline.processApprovedSends();
                        const sent = results.filter(r => r.status === 'sent').length;
                        const failed = results.filter(r => r.status === 'failed').length;
                        logger.info(`[dm-scheduler] Approved sends: ${sent} sent, ${failed} failed`);
                    }

                    // 2. Run outreach on queued targets (if under daily limit + good timing)
                    if (todayCount < pConfig.maxDMsPerDay) {
                        const timing = isGoodSendingTime();
                        if (timing.good) {
                            const remaining = pConfig.maxDMsPerDay - todayCount;
                            const targets = loadTargets();
                            if (targets.length > 0) {
                                const batch = targets.slice(0, Math.min(5, remaining));
                                logger.info(`[dm-scheduler] Processing ${batch.length} outreach target(s)... (timing: ${timing.reason})`);
                                const stats = await pipeline.runBatchOutreach(batch);
                                logger.info(`[dm-scheduler] Outreach: ${stats.sent} sent, ${stats.queued} queued, ${stats.skipped} skipped`);

                                const remainingTargets = targets.filter(t => !batch.includes(t));
                                saveTargets(remainingTargets);
                            }
                        } else {
                            logger.info(`[dm-scheduler] Skipping outreach — ${timing.reason}`);
                        }
                    } else {
                        logger.info(`[dm-scheduler] Daily DM limit reached (${todayCount}/${pConfig.maxDMsPerDay})`);
                    }

                    // 3. Check for replies and update feedback
                    try {
                        const replies = await pipeline.checkRepliesAndUpdateFeedback();
                        if (replies > 0) {
                            logger.info(`[dm-scheduler] ${replies} new reply feedback(s) recorded`);
                        }
                    } catch (e) {
                        logger.error(`[dm-scheduler] Feedback check error: ${formatError(e)}`);
                    }

                    // 4. Periodic learning analysis (every cycle, lightweight)
                    try {
                        const learnings = analyzeFeedbackAndLearn();
                        if (learnings.length > 0) {
                            logger.info(`[dm-scheduler] Updated ${learnings.length} AI learning(s) from feedback`);
                        }
                    } catch (e) {
                        logger.error(`[dm-scheduler] Learning analysis error: ${formatError(e)}`);
                    }

                } catch (e) {
                    logger.error(`[dm-scheduler] Pipeline error: ${formatError(e)}`);
                }

                await delay(PIPELINE_INTERVAL);
            }
        }

        // Run both loops concurrently with error isolation.
        // Each loop catches its own errors, but if one crashes fatally,
        // we log it and keep the other running.
        const watcherPromise = watcherLoop().catch(e => {
            logger.error(`[dm-scheduler] Watcher loop crashed fatally: ${formatError(e)}`);
        });
        const pipelinePromise = pipelineLoop().catch(e => {
            logger.error(`[dm-scheduler] Pipeline loop crashed fatally: ${formatError(e)}`);
        });

        await Promise.all([watcherPromise, pipelinePromise]);

    } catch (e) {
        logger.error(`[dm-scheduler] Fatal error: ${formatError(e)}`);
        await dm.close();
        process.exit(1);
    }
})();

// Catch unhandled errors to prevent silent crashes
process.on('uncaughtException', (error) => {
    logger.error(`[dm-scheduler] Uncaught Exception: ${formatError(error)}`);
});
process.on('unhandledRejection', (reason) => {
    logger.error(`[dm-scheduler] Unhandled Rejection: ${formatError(reason)}`);
});

function loadTargets(): string[] {
    return safeReadJSON<string[]>(TARGETS_FILE, [], 'outreach_targets');
}

function saveTargets(targets: string[]) {
    safeWriteJSON(TARGETS_FILE, targets, 'outreach_targets');
}
