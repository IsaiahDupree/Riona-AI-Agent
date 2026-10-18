/**
 * Supabase Twitter Content Sync — Syncs tweet posts and engagement snapshots to Supabase.
 * Fire-and-forget pattern matching supabaseTwitterDM.ts.
 */

import { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseClient } from './supabaseClient';
import { logger } from '../utils/logger';
import { withRetry, formatError } from '../utils/errors';
import { TrackedTweet, CheckBack } from '../tracking/twitterContentTracker';

function getClient(): SupabaseClient | null {
    return getSupabaseClient();
}

// ── Sync a posted tweet to Supabase ─────────────────────────────────

export async function syncTweetToSupabase(tweet: TrackedTweet): Promise<void> {
    const sb = getClient();
    if (!sb) return;

    try {
        await withRetry(async () => {
            const { error } = await sb.from('twitter_posts').upsert({
                tweet_url: tweet.tweetUrl,
                tweet_text: tweet.text,
                content_type: tweet.contentType,
                style: tweet.style,
                topic: tweet.topic,
                niche: tweet.niche,
                is_thread: tweet.type === 'thread',
                thread_count: tweet.threadTweets ? tweet.threadTweets.length : 1,
                offer_id: tweet.offerId || null,
                posted_at: tweet.postedAt,
                metadata: {
                    tracker_id: tweet.id,
                    thread_tweets: tweet.threadTweets || null,
                },
            }, { onConflict: 'tweet_url' });

            if (error) throw error;
        }, { maxRetries: 2, baseDelay: 1000, label: 'syncTweetToSupabase' });

        logger.info(`[supabase-twitter-content] Synced tweet: ${tweet.tweetUrl}`);
    } catch (e) {
        logger.warn(`[supabase-twitter-content] Failed to sync tweet: ${formatError(e)}`);
    }
}

// ── Sync engagement snapshot to Supabase ────────────────────────────

export async function syncTweetSnapshotToSupabase(
    tweetId: string,
    checkBack: CheckBack & { completedAt: string }
): Promise<void> {
    const sb = getClient();
    if (!sb) return;

    if (!checkBack.metrics) return;

    try {
        // Look up the Supabase tweet ID by tracker ID in metadata
        const { data: tweetRow } = await sb
            .from('twitter_posts')
            .select('id')
            .contains('metadata', { tracker_id: tweetId })
            .limit(1)
            .single();

        if (!tweetRow) {
            logger.warn(`[supabase-twitter-content] Tweet not found in Supabase for snapshot: ${tweetId}`);
            return;
        }

        const totalEngagement = checkBack.metrics.likes + checkBack.metrics.retweets + checkBack.metrics.replies;
        const engagementRate = checkBack.metrics.views > 0 ? totalEngagement / checkBack.metrics.views : 0;

        await sb.from('twitter_post_snapshots').upsert({
            tweet_id: tweetRow.id,
            check_period: checkBack.period,
            likes: checkBack.metrics.likes,
            retweets: checkBack.metrics.retweets,
            replies: checkBack.metrics.replies,
            views: checkBack.metrics.views,
            bookmarks: checkBack.metrics.bookmarks,
            engagement_rate: Math.round(engagementRate * 10000) / 10000,
            checked_at: checkBack.completedAt,
        }, { onConflict: 'tweet_id,check_period' });

        // Update latest metrics on the tweet row
        await sb.from('twitter_posts').update({
            latest_likes: checkBack.metrics.likes,
            latest_retweets: checkBack.metrics.retweets,
            latest_replies: checkBack.metrics.replies,
            latest_views: checkBack.metrics.views,
            engagement_score: Math.round(engagementRate * 10000) / 10000,
        }).eq('id', tweetRow.id);

        logger.info(`[supabase-twitter-content] Synced ${checkBack.period} snapshot for tweet ${tweetId}`);
    } catch (e) {
        logger.warn(`[supabase-twitter-content] Failed to sync snapshot: ${formatError(e)}`);
    }
}

// ── Sync reply performance (placeholder for tracked replies) ────────

export async function syncReplyPerformanceToSupabase(
    replyUrl: string,
    engagement: { likes: number; retweets: number; replies: number }
): Promise<void> {
    const sb = getClient();
    if (!sb) return;

    try {
        await sb.from('twitter_posts').update({
            latest_likes: engagement.likes,
            latest_retweets: engagement.retweets,
            latest_replies: engagement.replies,
        }).eq('tweet_url', replyUrl);
    } catch (e) {
        logger.warn(`[supabase-twitter-content] Failed to sync reply performance: ${formatError(e)}`);
    }
}
