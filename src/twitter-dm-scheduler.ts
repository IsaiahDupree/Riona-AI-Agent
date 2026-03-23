/**
 * Twitter DM Scheduler — PM2 entry point
 * Monitors Twitter/X DMs for new messages, processes approved sends,
 * runs outreach pipeline, and updates feedback loop
 */

import dotenv from 'dotenv';
dotenv.config({ override: true });

import { TwitterDM } from './client/Twitter-DM';
import { checkForNewTwitterDMs, initializeTwitterWatcherState } from './client/Twitter-DM-Watcher';
import { TwitterDMPipeline, loadConfig as loadPipelineConfig } from './client/Twitter-DM-Pipeline';
import { collectNicheProspects } from './client/Twitter-AI';
import { getTodayTwitterDMCount, cleanupOldTwitterDMs } from './tracking/twitterDMTracker';
import { getTodayDMLimit, getDMLimitInfo } from './config/dm-limits';
import { notifyNewDM, notifyError, notifyStartup } from './utils/telegram';
import { logger } from './utils/logger';
import { safeReadJSON, safeWriteJSON, formatError } from './utils/errors';
import * as path from 'path';

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

const CHECK_INTERVAL = parseInt(process.env.TWITTER_DM_CHECK_INTERVAL_MINUTES || '5', 10) * 60 * 1000;
const PIPELINE_INTERVAL = parseInt(process.env.TWITTER_DM_PIPELINE_INTERVAL_MINUTES || '30', 10) * 60 * 1000;
const TARGETS_FILE = path.join(process.cwd(), 'logs', 'tracking', 'twitter-dm', 'outreach_targets.json');
const AUTO_APPROVE = process.env.TWITTER_DM_AUTO_APPROVE === 'true';
let twitterDmPipelineRunCount = 0;
const NICHE_HASHTAGS = (process.env.TWITTER_NICHE_HASHTAGS || '').split(',').map(h => h.trim()).filter(Boolean);

// Simple mutex to prevent watcher/pipeline from colliding on navigation
let navigating = false;
let navigatingOwner = '';

function loadTargets(): string[] {
    return safeReadJSON<string[]>(TARGETS_FILE, [], 'twitter_outreach_targets');
}

function saveTargets(targets: string[]) {
    safeWriteJSON(TARGETS_FILE, targets, 'twitter_outreach_targets');
}

(async () => {
    console.log('');
    const MAX_DMS_PER_DAY = getTodayDMLimit();
    const limitInfo = getDMLimitInfo();
    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log('║       Riona Twitter DM System v2.1                     ║');
    console.log('╠══════════════════════════════════════════════════════════╣');
    console.log(`║  DM check:       every ${String(CHECK_INTERVAL / 60000).padEnd(3)} minutes                    ║`);
    console.log(`║  Pipeline:       every ${String(PIPELINE_INTERVAL / 60000).padEnd(3)} minutes                    ║`);
    console.log(`║  Auto-approve:   ${AUTO_APPROVE ? 'ON ' : 'OFF'}                                     ║`);
    console.log(`║  Max DMs/day:    ${String(MAX_DMS_PER_DAY).padEnd(4)} (week ${limitInfo.weekNumber}, +10/wk)             ║`);
    console.log(`║  Bot account:    @${(process.env.TWITTER_BOT_USERNAME || 'unknown').padEnd(37)}║`);
    console.log('╚══════════════════════════════════════════════════════════╝');
    console.log('');

    const dm = new TwitterDM();

    try {
        await dm.initialize();
        logger.info('[twitter-dm-scheduler] Browser initialized');
        await notifyStartup('Twitter DM', MAX_DMS_PER_DAY, 0, PIPELINE_INTERVAL / 60000).catch(() => {});

        const pipelineConfig = loadPipelineConfig();
        pipelineConfig.autoApprove = AUTO_APPROVE;
        pipelineConfig.maxDMsPerDay = getTodayDMLimit();

        const pipeline = new TwitterDMPipeline(dm, pipelineConfig);

        // Initialize watcher state on first run (establishes baseline without triggering replies)
        try {
            await initializeTwitterWatcherState(dm);
            logger.info('[twitter-dm-scheduler] Watcher state initialized');
        } catch (e) {
            logger.warn(`[twitter-dm-scheduler] Watcher state init failed (non-fatal): ${formatError(e)}`);
        }

        // ── One-time catch-up: reply to missed incoming DMs ──
        try {
            navigating = true;
            navigatingOwner = 'catch-up';
            const catchUpResult = await pipeline.catchUpMissedReplies();
            if (catchUpResult.replied > 0) {
                logger.info(`[twitter-dm-scheduler] Catch-up: scheduled ${catchUpResult.replied} reply(ies)`);
            } else {
                logger.info('[twitter-dm-scheduler] Catch-up: no missed replies to process');
            }
        } catch (e) {
            logger.warn(`[twitter-dm-scheduler] Catch-up failed (non-fatal): ${formatError(e)}`);
        } finally {
            navigating = false;
        }

        // ── DM Watcher Loop (check for new messages) ──
        async function watcherLoop() {
            while (true) {
                try {
                    if (navigating) {
                        logger.info(`[twitter-dm-scheduler] Watcher waiting — ${navigatingOwner} navigating`);
                        await delay(10000);
                        continue;
                    }
                    navigating = true;
                    navigatingOwner = 'watcher';

                    // Quick badge check before full inbox scrape
                    let page;
                    try { page = await dm.ensurePage(); } catch (_) { page = null; }
                    if (page) {
                        try {
                            const { readTwitterBadges } = await import('./client/NotificationBadgeReader');
                            const badges = await readTwitterBadges(page);
                            if (badges.dms > 0) {
                                logger.info(`[twitter-dm-scheduler] Badge: ${badges.dms} unread DMs detected`);
                            }
                        } catch (_) { /* non-fatal */ }
                    }

                    // Process any delayed replies that are ready (VI schedule)
                    try {
                        const delayedResult = await pipeline.processDelayedReplies();
                        if (delayedResult.sent > 0) {
                            logger.info(`[twitter-dm-scheduler] Sent ${delayedResult.sent} delayed reply(ies)`);
                        }
                    } catch (e) {
                        logger.error(`[twitter-dm-scheduler] Delayed reply error (non-fatal): ${formatError(e)}`);
                    }

                    // Check for new messages using dual detection (DOM unread + state comparison)
                    logger.info('[twitter-dm-scheduler] Checking inbox for new messages...');
                    const detected = await checkForNewTwitterDMs(dm);

                    if (detected.newMessages.length > 0) {
                        logger.info(`[twitter-dm-scheduler] ${detected.newMessages.length} new message(s) detected (DOM: ${detected.unreadFromDOM}, state: ${detected.detectedByState})`);
                        for (const msg of detected.newMessages) {
                            logger.info(`[twitter-dm-scheduler] New from: ${msg.from} — "${msg.preview.slice(0, 50)}"`);
                            await notifyNewDM(msg.from, msg.preview, 'Twitter').catch(() => {});
                        }

                        // Auto-reply to new DMs (schedules via VI delays)
                        try {
                            const replyResult = await pipeline.processDMAutoReplies();
                            if (replyResult.replied > 0) {
                                logger.info(`[twitter-dm-scheduler] Scheduled ${replyResult.replied} reply(ies) via VI delay`);
                            }
                        } catch (e) {
                            logger.error(`[twitter-dm-scheduler] Auto-reply error (non-fatal): ${formatError(e)}`);
                        }
                    } else {
                        logger.info('[twitter-dm-scheduler] No new messages');
                    }
                } catch (e) {
                    logger.error(`[twitter-dm-scheduler] Watcher error: ${formatError(e)}`);
                    await notifyError('Twitter DM Watcher', formatError(e)).catch(() => {});
                } finally {
                    navigating = false;
                }
                await delay(CHECK_INTERVAL);
            }
        }

        // ── Pipeline Loop (process approved sends + outreach + feedback) ──
        async function pipelineLoop() {
            // Wait a bit before starting pipeline to let watcher settle
            await delay(30000);

            let nicheIndex = 0;

            while (true) {
                try {
                    // Wait for watcher to finish if it's navigating
                    while (navigating) {
                        await delay(5000);
                    }
                    navigating = true;
                    navigatingOwner = 'pipeline';

                    // Re-fetch dynamic limit each cycle (auto-increments weekly)
                    const MAX_DMS_PER_DAY = getTodayDMLimit();
                    const todayCount = getTodayTwitterDMCount();

                    // 1. Process approved sends via pipeline
                    try {
                        const approvedResults = await pipeline.processApprovedSends();
                        if (approvedResults.length > 0) {
                            const sent = approvedResults.filter(r => r.status === 'sent').length;
                            const failed = approvedResults.filter(r => r.status === 'failed').length;
                            logger.info(`[twitter-dm-scheduler] Approved sends: ${sent} sent, ${failed} failed`);
                        }
                    } catch (e) {
                        logger.error(`[twitter-dm-scheduler] Approved sends error: ${formatError(e)}`);
                    }

                    // 2. Run outreach on queued targets (if under daily limit)
                    if (todayCount < MAX_DMS_PER_DAY) {
                        const hour = new Date().getHours();
                        const isGoodTime = hour >= 9 && hour < 21;
                        if (isGoodTime) {
                            let targets = loadTargets();

                            // Auto-populate targets if empty and we have niche hashtags
                            if (targets.length === 0 && NICHE_HASHTAGS.length > 0) {
                                const searchTerm = NICHE_HASHTAGS[nicheIndex % NICHE_HASHTAGS.length];
                                nicheIndex++;
                                logger.info(`[twitter-dm-scheduler] Auto-collecting prospects for "${searchTerm}"`);
                                try {
                                    let prospectPage;
                                    try { prospectPage = await dm.ensurePage(); } catch (_) { prospectPage = null; }
                                    if (prospectPage) {
                                        await collectNicheProspects(prospectPage, searchTerm, 20);
                                        targets = loadTargets();
                                    }
                                } catch (e) {
                                    logger.error(`[twitter-dm-scheduler] Prospect collection failed: ${formatError(e)}`);
                                }
                            }

                            if (targets.length > 0) {
                                const remaining = MAX_DMS_PER_DAY - getTodayTwitterDMCount();
                                const batch = targets.slice(0, Math.min(5, remaining));
                                logger.info(`[twitter-dm-scheduler] Running batch outreach: ${batch.length} targets`);

                                try {
                                    const stats = await pipeline.runBatchOutreach(batch);
                                    logger.info(`[twitter-dm-scheduler] Outreach: ${stats.sent} sent, ${stats.queued} queued, ${stats.skipped} skipped, ${stats.failed} failed`);
                                } catch (e) {
                                    logger.error(`[twitter-dm-scheduler] Batch outreach error: ${formatError(e)}`);
                                }

                                // Remove processed targets
                                const remainingTargets = targets.filter(t => !batch.includes(t));
                                saveTargets(remainingTargets);
                            }
                        } else {
                            logger.info(`[twitter-dm-scheduler] Skipping outreach — outside optimal hours (9:00-21:00)`);
                        }
                    } else {
                        logger.info(`[twitter-dm-scheduler] Daily DM limit reached (${todayCount}/${MAX_DMS_PER_DAY})`);
                    }

                    // 3. Check replies and update feedback loop
                    try {
                        const repliesFound = await pipeline.checkRepliesAndUpdateFeedback();
                        if (repliesFound > 0) {
                            logger.info(`[twitter-dm-scheduler] Found ${repliesFound} new replies`);
                        }
                    } catch (e) {
                        logger.error(`[twitter-dm-scheduler] Feedback check error: ${formatError(e)}`);
                    }

                    // 4. Process proactive check-ins for warm contacts
                    try {
                        const { processDueCheckIns } = await import('./nurture/check-ins');
                        const checkInsSent = await processDueCheckIns('twitter', async (username, message) => {
                            try {
                                const stats = await pipeline.runBatchOutreach([username]);
                                return stats.sent > 0;
                            } catch { return false; }
                        }, 3);
                        if (checkInsSent > 0) {
                            logger.info(`[twitter-dm-scheduler] Sent ${checkInsSent} proactive check-ins`);
                        }
                    } catch (e) {
                        logger.warn(`[twitter-dm-scheduler] Check-ins error (non-fatal): ${formatError(e)}`);
                    }

                    // 5. Periodic tier evaluation (every pipeline run)
                    try {
                        const { runTierEvaluation } = await import('./nurture/tiers');
                        const { promoted, demoted } = runTierEvaluation('twitter');
                        if (promoted.length > 0) logger.info(`[twitter-dm-scheduler] Tier promotions: ${promoted.join(', ')}`);
                        if (demoted.length > 0) logger.info(`[twitter-dm-scheduler] Tier demotions: ${demoted.join(', ')}`);
                    } catch (e) {
                        logger.warn(`[twitter-dm-scheduler] Tier evaluation error (non-fatal): ${formatError(e)}`);
                    }

                    // 6. Periodic DM log cleanup
                    try {
                        cleanupOldTwitterDMs(90);
                    } catch (e) {
                        logger.warn(`[twitter-dm-scheduler] DM cleanup error (non-fatal): ${formatError(e)}`);
                    }

                    // 7. Periodic bulk sync to Supabase (every 10th pipeline cycle)
                    twitterDmPipelineRunCount++;
                    if (twitterDmPipelineRunCount % 10 === 0) {
                        try {
                            const { bulkSyncTwitterToSupabase } = await import('./db/supabaseTwitterDM');
                            const syncResult = await bulkSyncTwitterToSupabase();
                            logger.info(`[twitter-dm-scheduler] Bulk sync: ${syncResult.conversations} contacts, ${syncResult.messages} msgs`);
                        } catch (syncErr) {
                            logger.debug(`[twitter-dm-scheduler] Bulk sync failed (non-fatal): ${formatError(syncErr)}`);
                        }
                        try {
                            const { syncPendingSendsToSupabase } = await import('./db/supabaseSync');
                            await syncPendingSendsToSupabase('twitter');
                        } catch (syncErr) {
                            logger.debug(`[twitter-dm-scheduler] Pending sends sync failed (non-fatal): ${formatError(syncErr)}`);
                        }
                    }

                } catch (e) {
                    logger.error(`[twitter-dm-scheduler] Pipeline error: ${formatError(e)}`);
                    await notifyError('Twitter DM Pipeline', formatError(e)).catch(() => {});
                } finally {
                    navigating = false;
                }

                await delay(PIPELINE_INTERVAL);
            }
        }

        // Run both loops concurrently with error isolation.
        const watcherPromise = watcherLoop().catch(e => {
            logger.error(`[twitter-dm-scheduler] Watcher loop crashed fatally: ${formatError(e)}`);
        });
        const pipelinePromise = pipelineLoop().catch(e => {
            logger.error(`[twitter-dm-scheduler] Pipeline loop crashed fatally: ${formatError(e)}`);
        });

        await Promise.allSettled([watcherPromise, pipelinePromise]);

    } catch (e) {
        logger.error(`[twitter-dm-scheduler] Fatal error: ${formatError(e)}`);
        await notifyError('Twitter DM Scheduler', formatError(e)).catch(() => {});
        await dm.close();
        process.exit(1);
    }
})();

// Catch unhandled errors to prevent silent crashes
process.on('uncaughtException', (error) => {
    logger.error(`[twitter-dm-scheduler] Uncaught Exception: ${formatError(error)}`);
});
process.on('unhandledRejection', (reason) => {
    logger.error(`[twitter-dm-scheduler] Unhandled Rejection: ${formatError(reason)}`);
});
