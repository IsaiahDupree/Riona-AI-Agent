/**
 * DM Scheduler — PM2 entry point
 * Monitors Instagram DMs for new messages, processes approved sends,
 * runs outreach pipeline, and updates feedback loop
 */

import { InstagramDM } from './client/Instagram-DM';
import { startDMWatcher, checkForNewDMs } from './client/Instagram-DM-Watcher';
import { DMPipeline, loadConfig, loadPendingSends, DMAutoReplyResult } from './client/Instagram-DM-Pipeline';
import { getTodayDMCount, cleanupOldDMs } from './tracking/dmTracker';
import { getTodayDMLimit, getDMLimitInfo } from './config/dm-limits';
import { isGoodSendingTime, analyzeFeedbackAndLearn } from './client/Instagram-DM-Analytics';
import { notifyStartup, notifyError, notifyNewDM } from './utils/telegram';
import { logger } from './utils/logger';
import { safeReadJSON, safeWriteJSON, formatError } from './utils/errors';
import * as path from 'path';

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

const CHECK_INTERVAL = parseInt(process.env.DM_CHECK_INTERVAL_MINUTES || '5', 10) * 60 * 1000;
const PIPELINE_INTERVAL = parseInt(process.env.DM_PIPELINE_INTERVAL_MINUTES || '30', 10) * 60 * 1000;
const TARGETS_FILE = path.join(process.cwd(), 'logs', 'tracking', 'dm', 'outreach_targets.json');
let pipelineRunCount = 0;

// Simple mutex to prevent watcher/pipeline from colliding on browser navigation
let navigating = false;
let navigatingOwner = '';

(async () => {
    const config = loadConfig();
    const dailyLimit = getTodayDMLimit();
    const limitInfo = getDMLimitInfo();
    config.maxDMsPerDay = dailyLimit;
    config.autoApprove = true; // Enable outbound outreach
    console.log('');
    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log('║       Riona Instagram DM System v2.1                   ║');
    console.log('╠══════════════════════════════════════════════════════════╣');
    console.log(`║  DM check:       every ${String(CHECK_INTERVAL / 60000).padEnd(3)} minutes                        ║`);
    console.log(`║  Pipeline:       every ${String(PIPELINE_INTERVAL / 60000).padEnd(3)} minutes                       ║`);
    console.log(`║  Auto-approve:   ON                                       ║`);
    console.log(`║  Max DMs/day:    ${String(dailyLimit).padEnd(4)} (week ${limitInfo.weekNumber}, +10/wk)             ║`);
    console.log(`║  Bot account:    @${(process.env.INSTAGRAM_BOT_USERNAME || 'the_isaiah_dupree').padEnd(37)}║`);
    console.log('╚══════════════════════════════════════════════════════════╝');
    console.log('');
    await notifyStartup('Instagram DM', dailyLimit, 0, PIPELINE_INTERVAL / 60000).catch(() => {});

    const dm = new InstagramDM();

    try {
        await dm.initialize();
        logger.info('[dm-scheduler] Browser initialized');

        // ── One-time catch-up: reply to missed incoming DMs ──
        try {
            navigating = true;
            navigatingOwner = 'catch-up';
            const catchUpPipeline = new DMPipeline(dm, { autoApprove: true, maxDMsPerDay: getTodayDMLimit() });
            logger.info('[dm-scheduler] Running one-time catch-up for missed replies...');
            const catchUpResult = await catchUpPipeline.catchUpMissedReplies();
            if (catchUpResult.replied > 0) {
                logger.info(`[dm-scheduler] Catch-up: scheduled ${catchUpResult.replied} reply(ies), skipped ${catchUpResult.skipped}, failed ${catchUpResult.failed}`);
                for (const d of catchUpResult.details) {
                    logger.info(`[dm-scheduler]   @${d.username}: ${d.action} — ${d.reason || ''}`);
                }
            } else {
                logger.info(`[dm-scheduler] Catch-up: no missed replies to process (skipped ${catchUpResult.skipped})`);
            }
        } catch (e) {
            logger.error(`[dm-scheduler] Catch-up error (non-fatal): ${formatError(e)}`);
        } finally {
            navigating = false;
        }

        // ── DM Watcher Loop (check for new messages) ──
        async function watcherLoop() {
            while (true) {
                try {
                    if (navigating) {
                        logger.info(`[dm-scheduler] Watcher waiting — ${navigatingOwner} navigating`);
                        await delay(10000);
                        continue;
                    }
                    navigating = true;
                    navigatingOwner = 'watcher';

                    const pipeline = new DMPipeline(dm, { autoApprove: true, maxDMsPerDay: getTodayDMLimit() });

                    // Process any delayed replies that are ready (VI schedule)
                    try {
                        const delayedResult = await pipeline.processDelayedReplies();
                        if (delayedResult.sent > 0) {
                            logger.info(`[dm-scheduler] Sent ${delayedResult.sent} delayed reply(ies)`);
                        }
                    } catch (e) {
                        logger.error(`[dm-scheduler] Delayed reply error (non-fatal): ${formatError(e)}`);
                    }

                    const { newMessages } = await checkForNewDMs(dm);
                    if (newMessages.length > 0) {
                        logger.info(`[dm-scheduler] ${newMessages.length} new message(s) detected`);

                        // Notify Telegram for each new incoming DM
                        for (const msg of newMessages) {
                            await notifyNewDM(msg.from, msg.preview, 'Instagram').catch(() => {});
                        }

                        // Auto-reply to new incoming DMs (schedules via VI delays)
                        try {
                            const replyResult = await pipeline.processDMAutoReplies();
                            if (replyResult.replied > 0) {
                                logger.info(`[dm-scheduler] Scheduled ${replyResult.replied} reply(ies) via VI delay`);
                            }
                        } catch (e) {
                            logger.error(`[dm-scheduler] Auto-reply error (non-fatal): ${formatError(e)}`);
                        }
                    }
                } catch (e) {
                    logger.error(`[dm-scheduler] Watcher error: ${formatError(e)}`);
                } finally {
                    navigating = false;
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
                    // Wait for watcher to finish if it's navigating
                    while (navigating) {
                        await delay(5000);
                    }
                    navigating = true;
                    navigatingOwner = 'pipeline';

                    const dynamicLimit = getTodayDMLimit();
                    const pipeline = new DMPipeline(dm, { autoApprove: true, maxDMsPerDay: dynamicLimit });
                    const pConfig = { ...loadConfig(), maxDMsPerDay: dynamicLimit, autoApprove: true };
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
                            let targets = loadTargets();

                            // Auto-populate targets from today's commenters if empty
                            if (targets.length === 0) {
                                try {
                                    const statsFile = path.join(process.cwd(), 'logs', 'tracking', 'daily_stats.json');
                                    const stats = safeReadJSON<any>(statsFile, null, 'ig_daily_stats');
                                    if (stats && stats.uniqueUsersCommented && stats.uniqueUsersCommented.length > 0) {
                                        targets = stats.uniqueUsersCommented;
                                        saveTargets(targets);
                                        logger.info(`[dm-scheduler] Auto-populated ${targets.length} outreach targets from today's commenters`);
                                    }
                                } catch (e) {
                                    logger.warn(`[dm-scheduler] Failed to auto-populate targets: ${formatError(e)}`);
                                }
                            }

                            if (targets.length > 0) {
                                const batch = targets.slice(0, Math.min(3, remaining));
                                logger.info(`[dm-scheduler] Processing ${batch.length} outreach target(s)... (timing: ${timing.reason})`);
                                try {
                                    const stats = await pipeline.runBatchOutreach(batch);
                                    logger.info(`[dm-scheduler] Outreach: ${stats.sent} sent, ${stats.queued} queued, ${stats.skipped} skipped`);
                                } catch (e) {
                                    logger.error(`[dm-scheduler] Batch outreach error: ${formatError(e)}`);
                                }

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

                    // 5. Periodic DM log cleanup (runs every cycle, only writes if old entries exist)
                    try {
                        cleanupOldDMs(90);
                    } catch (e) {
                        logger.warn(`[dm-scheduler] DM cleanup error (non-fatal): ${formatError(e)}`);
                    }

                    // 6. Periodic bulk sync to Supabase (every 10th pipeline cycle)
                    pipelineRunCount++;
                    if (pipelineRunCount % 10 === 0) {
                        try {
                            const { bulkSyncToSupabase } = await import('./db/supabaseDM');
                            const syncResult = await bulkSyncToSupabase();
                            logger.info(`[dm-scheduler] IG DM bulk sync: ${syncResult.conversations} contacts, ${syncResult.messages} msgs`);
                        } catch (syncErr) {
                            logger.debug(`[dm-scheduler] Bulk sync failed (non-fatal): ${formatError(syncErr)}`);
                        }
                        try {
                            const { syncPendingSendsToSupabase, syncCommentsToSupabase } = await import('./db/supabaseSync');
                            await syncPendingSendsToSupabase('instagram');
                            await syncCommentsToSupabase('instagram');
                        } catch (syncErr) {
                            logger.debug(`[dm-scheduler] Periodic sync failed (non-fatal): ${formatError(syncErr)}`);
                        }
                    }

                } catch (e) {
                    logger.error(`[dm-scheduler] Pipeline error: ${formatError(e)}`);
                } finally {
                    navigating = false;
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
