/**
 * Twitter DM Scheduler — PM2 entry point
 * Monitors Twitter/X DMs for new messages, processes approved sends,
 * runs outreach pipeline, and updates feedback loop
 */

import { TwitterDM } from './client/Twitter-DM';
import { logger } from './utils/logger';
import { safeReadJSON, safeWriteJSON, formatError } from './utils/errors';
import * as path from 'path';

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

const CHECK_INTERVAL = parseInt(process.env.TWITTER_DM_CHECK_INTERVAL_MINUTES || '5', 10) * 60 * 1000;
const PIPELINE_INTERVAL = parseInt(process.env.TWITTER_DM_PIPELINE_INTERVAL_MINUTES || '30', 10) * 60 * 1000;
const TARGETS_FILE = path.join(process.cwd(), 'logs', 'tracking', 'twitter-dm', 'outreach_targets.json');
const MAX_DMS_PER_DAY = parseInt(process.env.TWITTER_DM_MAX_PER_DAY || '50', 10);
const AUTO_APPROVE = process.env.TWITTER_DM_AUTO_APPROVE === 'true';

interface PendingSend {
    recipientUsername: string;
    message: string;
    status: 'pending' | 'approved' | 'rejected' | 'sent' | 'failed';
    createdAt: string;
    sentAt?: string;
    error?: string;
}

const PENDING_SENDS_FILE = path.join(process.cwd(), 'logs', 'tracking', 'twitter-dm', 'pending_sends.json');
const DM_COUNTER_FILE = path.join(process.cwd(), 'logs', 'tracking', 'twitter-dm', 'daily_counter.json');

function todayStr(): string {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function getTodayDMCount(): number {
    const data = safeReadJSON<{ date: string; count: number } | null>(DM_COUNTER_FILE, null, 'twitter_dm_counter');
    if (data && data.date === todayStr()) return data.count;
    return 0;
}

function incrementDMCount() {
    const today = todayStr();
    const data = safeReadJSON<{ date: string; count: number } | null>(DM_COUNTER_FILE, null, 'twitter_dm_counter');
    const count = (data && data.date === today) ? data.count + 1 : 1;
    safeWriteJSON(DM_COUNTER_FILE, { date: today, count }, 'twitter_dm_counter');
}

function loadPendingSends(): PendingSend[] {
    return safeReadJSON<PendingSend[]>(PENDING_SENDS_FILE, [], 'twitter_pending_sends');
}

function savePendingSends(sends: PendingSend[]) {
    safeWriteJSON(PENDING_SENDS_FILE, sends, 'twitter_pending_sends');
}

function loadTargets(): string[] {
    return safeReadJSON<string[]>(TARGETS_FILE, [], 'twitter_outreach_targets');
}

function saveTargets(targets: string[]) {
    safeWriteJSON(TARGETS_FILE, targets, 'twitter_outreach_targets');
}

(async () => {
    console.log('');
    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log('║       Riona Twitter DM System v1.0                     ║');
    console.log('╠══════════════════════════════════════════════════════════╣');
    console.log(`║  DM check:       every ${String(CHECK_INTERVAL / 60000).padEnd(3)} minutes                    ║`);
    console.log(`║  Pipeline:       every ${String(PIPELINE_INTERVAL / 60000).padEnd(3)} minutes                    ║`);
    console.log(`║  Auto-approve:   ${AUTO_APPROVE ? 'ON ' : 'OFF'}                                     ║`);
    console.log(`║  Max DMs/day:    ${String(MAX_DMS_PER_DAY).padEnd(4)}                                    ║`);
    console.log(`║  Bot account:    @${(process.env.TWITTER_BOT_USERNAME || 'unknown').padEnd(37)}║`);
    console.log('╚══════════════════════════════════════════════════════════╝');
    console.log('');

    const dm = new TwitterDM();

    try {
        await dm.initialize();
        logger.info('[twitter-dm-scheduler] Browser initialized');

        // ── DM Watcher Loop (check for new messages) ──
        async function watcherLoop() {
            while (true) {
                try {
                    logger.info('[twitter-dm-scheduler] Checking inbox for new messages...');
                    const conversations = await dm.scrapeInbox();
                    const unread = conversations.filter(c => c.unread);
                    if (unread.length > 0) {
                        logger.info(`[twitter-dm-scheduler] ${unread.length} unread conversation(s) detected`);
                        for (const conv of unread) {
                            logger.info(`[twitter-dm-scheduler] Unread from: ${conv.username} — "${conv.lastMessage.slice(0, 50)}"`);
                        }
                    } else {
                        logger.info(`[twitter-dm-scheduler] No new messages (${conversations.length} conversations total)`);
                    }
                } catch (e) {
                    logger.error(`[twitter-dm-scheduler] Watcher error: ${formatError(e)}`);
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
                    const todayCount = getTodayDMCount();

                    // 1. Process approved sends first
                    const pendingSends = loadPendingSends();
                    const approved = pendingSends.filter(s => s.status === 'approved');
                    if (approved.length > 0) {
                        logger.info(`[twitter-dm-scheduler] Processing ${approved.length} approved send(s)...`);
                        let sentCount = 0;
                        let failedCount = 0;

                        for (const send of approved) {
                            if (getTodayDMCount() >= MAX_DMS_PER_DAY) {
                                logger.info(`[twitter-dm-scheduler] Daily DM limit reached, stopping sends`);
                                break;
                            }
                            try {
                                const result = await dm.sendDM(send.recipientUsername, send.message);
                                if (result.success) {
                                    send.status = 'sent';
                                    send.sentAt = new Date().toISOString();
                                    incrementDMCount();
                                    sentCount++;
                                } else {
                                    send.status = 'failed';
                                    send.error = result.error || 'Unknown error';
                                    failedCount++;
                                }
                            } catch (e) {
                                send.status = 'failed';
                                send.error = formatError(e);
                                failedCount++;
                                logger.error(`[twitter-dm-scheduler] Send to ${send.recipientUsername} failed: ${formatError(e)}`);
                            }
                            await delay(5000); // Rate limiting between sends
                        }
                        savePendingSends(pendingSends);
                        logger.info(`[twitter-dm-scheduler] Approved sends: ${sentCount} sent, ${failedCount} failed`);
                    }

                    // 2. Run outreach on queued targets (if under daily limit)
                    if (todayCount < MAX_DMS_PER_DAY) {
                        const hour = new Date().getHours();
                        const isGoodTime = hour >= 9 && hour < 21;
                        if (isGoodTime) {
                            const remaining = MAX_DMS_PER_DAY - getTodayDMCount();
                            const targets = loadTargets();
                            if (targets.length > 0) {
                                const batch = targets.slice(0, Math.min(5, remaining));
                                logger.info(`[twitter-dm-scheduler] Processing ${batch.length} outreach target(s)...`);
                                let sentCount = 0;
                                let skippedCount = 0;

                                for (const target of batch) {
                                    if (getTodayDMCount() >= MAX_DMS_PER_DAY) break;
                                    try {
                                        // For outreach, we need a message — this would come from AI generation
                                        // For now, log that the target needs a message
                                        logger.info(`[twitter-dm-scheduler] Outreach target: @${target} — needs message generation`);
                                        skippedCount++;
                                    } catch (e) {
                                        logger.error(`[twitter-dm-scheduler] Outreach to @${target} failed: ${formatError(e)}`);
                                        skippedCount++;
                                    }
                                    await delay(3000);
                                }

                                const remainingTargets = targets.filter(t => !batch.includes(t));
                                saveTargets(remainingTargets);
                                logger.info(`[twitter-dm-scheduler] Outreach: ${sentCount} sent, ${skippedCount} skipped`);
                            }
                        } else {
                            logger.info(`[twitter-dm-scheduler] Skipping outreach — outside optimal hours (9:00-21:00)`);
                        }
                    } else {
                        logger.info(`[twitter-dm-scheduler] Daily DM limit reached (${todayCount}/${MAX_DMS_PER_DAY})`);
                    }

                } catch (e) {
                    logger.error(`[twitter-dm-scheduler] Pipeline error: ${formatError(e)}`);
                }

                await delay(PIPELINE_INTERVAL);
            }
        }

        // Run both loops concurrently with error isolation.
        // Each loop catches its own errors, but if one crashes fatally,
        // we log it and keep the other running.
        const watcherPromise = watcherLoop().catch(e => {
            logger.error(`[twitter-dm-scheduler] Watcher loop crashed fatally: ${formatError(e)}`);
        });
        const pipelinePromise = pipelineLoop().catch(e => {
            logger.error(`[twitter-dm-scheduler] Pipeline loop crashed fatally: ${formatError(e)}`);
        });

        await Promise.all([watcherPromise, pipelinePromise]);

    } catch (e) {
        logger.error(`[twitter-dm-scheduler] Fatal error: ${formatError(e)}`);
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
