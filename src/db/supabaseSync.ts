/**
 * Supabase Consolidated Sync — Syncs daily stats, comments, pending sends,
 * and cross-platform identities to Supabase.
 *
 * Combines previously un-synced local data sources into cloud tables.
 * Fire-and-forget pattern matching other supabase*.ts modules.
 */

import { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseClient } from './supabaseClient';
import { logger } from '../utils/logger';
import { formatError } from '../utils/errors';
import { safeReadJSON } from '../utils/errors';
import type { DailySnapshot, WeeklyTrend } from '../tracking/weeklyStats';
import * as fs from 'fs';
import * as path from 'path';

function getClient(): SupabaseClient | null {
    return getSupabaseClient();
}

// ── Sync daily snapshot to Supabase ─────────────────────────────────

export async function syncDailySnapshotToSupabase(snapshot: DailySnapshot): Promise<void> {
    const sb = getClient();
    if (!sb) return;

    try {
        await sb.from('daily_snapshots').upsert({
            date: snapshot.date,
            ig_comments: snapshot.instagram.comments,
            ig_verified: snapshot.instagram.verified,
            ig_likes: snapshot.instagram.likes,
            ig_sessions: snapshot.instagram.sessions,
            ig_unique_users: snapshot.instagram.uniqueUsers,
            ig_dms_sent: snapshot.instagram.dmsSent,
            ig_dms_received: snapshot.instagram.dmsReceived,
            tw_replies: snapshot.twitter.replies,
            tw_verified: snapshot.twitter.verified,
            tw_likes: snapshot.twitter.likes,
            tw_sessions: snapshot.twitter.sessions,
            tw_unique_users: snapshot.twitter.uniqueUsers,
            tw_dms_sent: snapshot.twitter.dmsSent,
            tw_dms_received: snapshot.twitter.dmsReceived,
            tw_tweets_posted: snapshot.twitter.tweetsPosted,
            synced_at: new Date().toISOString(),
        }, { onConflict: 'date' });

        logger.info(`[supabase-sync] Synced daily snapshot for ${snapshot.date}`);
    } catch (e) {
        logger.warn(`[supabase-sync] Daily snapshot sync failed: ${formatError(e)}`);
    }
}

// ── Sync weekly trend to Supabase ───────────────────────────────────

export async function syncWeeklyTrendToSupabase(trend: WeeklyTrend): Promise<void> {
    const sb = getClient();
    if (!sb) return;

    try {
        await sb.from('weekly_trends').upsert({
            week_start: trend.weekStart,
            week_end: trend.weekEnd,
            ig_total_comments: trend.instagram.totalComments,
            ig_total_dms: trend.instagram.totalDMs,
            ig_avg_comments_per_day: trend.instagram.avgCommentsPerDay,
            ig_avg_dms_per_day: trend.instagram.avgDMsPerDay,
            ig_active_days: trend.instagram.activeDays,
            tw_total_replies: trend.twitter.totalReplies,
            tw_total_dms: trend.twitter.totalDMs,
            tw_total_tweets: trend.twitter.totalTweets,
            tw_avg_replies_per_day: trend.twitter.avgRepliesPerDay,
            tw_avg_dms_per_day: trend.twitter.avgDMsPerDay,
            tw_active_days: trend.twitter.activeDays,
            synced_at: new Date().toISOString(),
        }, { onConflict: 'week_start' });

        logger.info(`[supabase-sync] Synced weekly trend for ${trend.weekStart}`);
    } catch (e) {
        logger.warn(`[supabase-sync] Weekly trend sync failed: ${formatError(e)}`);
    }
}

// ── Sync comments to Supabase ───────────────────────────────────────

interface TrackedComment {
    postUrl: string;
    postUsername: string;
    commentText: string;
    timestamp: string;
    verified: boolean;
    sessionId: string;
    captionSnippet: string;
    liked: boolean;
}

export async function syncCommentsToSupabase(platform: 'instagram' | 'twitter'): Promise<number> {
    const sb = getClient();
    if (!sb) return 0;

    const commentsFile = platform === 'instagram'
        ? path.join(process.cwd(), 'logs', 'tracking', 'comments.json')
        : path.join(process.cwd(), 'logs', 'tracking', 'twitter_comments.json');

    if (!fs.existsSync(commentsFile)) return 0;

    try {
        const comments = safeReadJSON<TrackedComment[]>(commentsFile, [], 'comments_sync');
        if (comments.length === 0) return 0;

        // Only sync last 24h of comments to avoid re-syncing everything
        const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const recentComments = comments.filter(c => c.timestamp > cutoff);
        if (recentComments.length === 0) return 0;

        let synced = 0;
        for (const comment of recentComments) {
            try {
                await sb.from('tracked_comments').upsert({
                    platform,
                    post_url: comment.postUrl,
                    post_username: comment.postUsername,
                    comment_text: comment.commentText,
                    posted_at: comment.timestamp,
                    verified: comment.verified,
                    session_id: comment.sessionId,
                    caption_snippet: comment.captionSnippet?.slice(0, 500),
                    liked: comment.liked,
                }, { onConflict: 'platform,post_url,posted_at' });
                synced++;
            } catch (e) {
                // Skip individual failures
                logger.debug(`[supabase-sync] Comment sync failed for ${comment.postUrl}: ${formatError(e)}`);
            }
        }

        if (synced > 0) {
            logger.info(`[supabase-sync] Synced ${synced}/${recentComments.length} ${platform} comments`);
        }
        return synced;
    } catch (e) {
        logger.warn(`[supabase-sync] Comments batch sync failed: ${formatError(e)}`);
        return 0;
    }
}

// ── Sync pending sends to Supabase ──────────────────────────────────

interface PendingSend {
    id: string;
    recipientUsername: string;
    message: string;
    context: {
        relationship: any;
        offer?: any;
        objective: string;
    };
    status: 'pending' | 'approved' | 'rejected' | 'sent' | 'failed';
    createdAt: string;
    reviewedAt?: string;
    sentAt?: string;
    error?: string;
}

export async function syncPendingSendsToSupabase(platform: 'instagram' | 'twitter'): Promise<number> {
    const sb = getClient();
    if (!sb) return 0;

    const pendingFile = platform === 'instagram'
        ? path.join(process.cwd(), 'logs', 'tracking', 'dm', 'pending_sends.json')
        : path.join(process.cwd(), 'logs', 'tracking', 'twitter-dm', 'pending_sends.json');

    if (!fs.existsSync(pendingFile)) return 0;

    try {
        const sends = safeReadJSON<PendingSend[]>(pendingFile, [], 'pending_sends_sync');
        if (sends.length === 0) return 0;

        let synced = 0;
        for (const send of sends) {
            try {
                await sb.from('pending_sends').upsert({
                    send_id: send.id,
                    platform,
                    recipient_username: send.recipientUsername,
                    message_preview: send.message.slice(0, 500),
                    objective: send.context?.objective || '',
                    status: send.status,
                    created_at: send.createdAt,
                    reviewed_at: send.reviewedAt || null,
                    sent_at: send.sentAt || null,
                    error: send.error || null,
                    synced_at: new Date().toISOString(),
                }, { onConflict: 'send_id' });
                synced++;
            } catch (e) {
                logger.debug(`[supabase-sync] Pending send sync failed for ${send.id}: ${formatError(e)}`);
            }
        }

        if (synced > 0) {
            logger.info(`[supabase-sync] Synced ${synced}/${sends.length} ${platform} pending sends`);
        }
        return synced;
    } catch (e) {
        logger.warn(`[supabase-sync] Pending sends batch sync failed: ${formatError(e)}`);
        return 0;
    }
}

// ── Sync all cross-platform identities to Supabase ──────────────────

export async function syncAllIdentitiesToSupabase(): Promise<number> {
    const sb = getClient();
    if (!sb) return 0;

    try {
        const { loadIdentities } = await import('../nurture/cross-platform');
        const { syncCrossIdentityToSupabase } = await import('./supabaseNurture');
        const identities = loadIdentities();
        let synced = 0;

        for (const identity of identities) {
            try {
                await syncCrossIdentityToSupabase(identity);
                synced++;
            } catch (e) {
                logger.debug(`[supabase-sync] Identity sync failed for ${identity.id}: ${formatError(e)}`);
            }
        }

        if (synced > 0) {
            logger.info(`[supabase-sync] Synced ${synced} cross-platform identities`);
        }
        return synced;
    } catch (e) {
        logger.warn(`[supabase-sync] Identity batch sync failed: ${formatError(e)}`);
        return 0;
    }
}

// ── Full periodic sync (called from schedulers) ─────────────────────

export async function runPeriodicSync(): Promise<{
    comments: { instagram: number; twitter: number };
    pendingSends: { instagram: number; twitter: number };
    identities: number;
}> {
    const results = {
        comments: { instagram: 0, twitter: 0 },
        pendingSends: { instagram: 0, twitter: 0 },
        identities: 0,
    };

    try {
        // Run all syncs concurrently
        const [igComments, twComments, igPending, twPending, identities] = await Promise.all([
            syncCommentsToSupabase('instagram').catch(() => 0),
            syncCommentsToSupabase('twitter').catch(() => 0),
            syncPendingSendsToSupabase('instagram').catch(() => 0),
            syncPendingSendsToSupabase('twitter').catch(() => 0),
            syncAllIdentitiesToSupabase().catch(() => 0),
        ]);

        results.comments.instagram = igComments;
        results.comments.twitter = twComments;
        results.pendingSends.instagram = igPending;
        results.pendingSends.twitter = twPending;
        results.identities = identities;

        const total = igComments + twComments + igPending + twPending + identities;
        if (total > 0) {
            logger.info(`[supabase-sync] Periodic sync: ${total} records synced`);
        }
    } catch (e) {
        logger.warn(`[supabase-sync] Periodic sync error: ${formatError(e)}`);
    }

    return results;
}
