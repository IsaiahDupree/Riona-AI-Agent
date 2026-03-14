/**
 * Supabase Nurture Sync — Fire-and-forget sync for friendship nurture data.
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { logger } from '../utils/logger';
import { withRetry, formatError } from '../utils/errors';
import {
    NurtureProfile, InterestProfile, CheckInRecord,
    CrossPlatformIdentity, ConversationDepthMetrics,
} from '../types/nurture';

let client: SupabaseClient | null = null;

function getClient(): SupabaseClient | null {
    if (client) return client;
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_KEY;
    if (!url || !key) return null;

    try {
        client = createClient(url, key);
        return client;
    } catch (e) {
        logger.warn(`[supabase-nurture] Client creation failed: ${formatError(e)}`);
        return null;
    }
}

export async function syncNurtureProfileToSupabase(profile: NurtureProfile): Promise<void> {
    const sb = getClient();
    if (!sb) return;

    try {
        await withRetry(async () => {
            const { error } = await sb.from('nurture_profiles').upsert({
                username: profile.username,
                platform: profile.platform,
                person_id: profile.personId || null,
                tier: profile.tier,
                tier_promoted_at: profile.tierPromotedAt || null,
                depth_score: profile.depth.conversationQualityScore,
                exchange_count: profile.depth.exchangeCount,
                interest_count: profile.interests.interests.length,
                last_check_in: profile.lastCheckIn || null,
                next_check_in_due: profile.nextCheckInDue || null,
                created_at: profile.createdAt,
                metadata: {
                    tier_history: profile.tierHistory,
                    interest_performance: profile.interestMessagePerformance,
                },
            }, { onConflict: 'username,platform' });

            if (error) throw error;
        }, { maxRetries: 2, baseDelay: 1000, label: 'syncNurtureProfile' });
    } catch (e) {
        logger.warn(`[supabase-nurture] Profile sync failed: ${formatError(e)}`);
    }
}

export async function syncInterestProfileToSupabase(profile: InterestProfile): Promise<void> {
    const sb = getClient();
    if (!sb) return;

    try {
        await sb.from('interest_profiles').upsert({
            username: profile.username,
            platform: profile.platform,
            interests: profile.interests,
            last_updated: profile.lastUpdated,
        }, { onConflict: 'username,platform' });
    } catch (e) {
        logger.warn(`[supabase-nurture] Interest sync failed: ${formatError(e)}`);
    }
}

export async function syncCheckInToSupabase(record: CheckInRecord): Promise<void> {
    const sb = getClient();
    if (!sb) return;

    try {
        await sb.from('check_in_records').insert({
            username: record.username,
            platform: record.platform,
            check_in_type: record.type,
            scheduled_for: record.scheduledFor,
            sent_at: record.sentAt || null,
            content_reference: record.contentReference || null,
            message_used: record.messageUsed || null,
            got_reply: record.gotReply || null,
        });
    } catch (e) {
        logger.warn(`[supabase-nurture] Check-in sync failed: ${formatError(e)}`);
    }
}

export async function syncCrossIdentityToSupabase(identity: CrossPlatformIdentity): Promise<void> {
    const sb = getClient();
    if (!sb) return;

    try {
        await sb.from('cross_platform_identities').upsert({
            id: identity.id,
            twitter_handle: identity.twitterHandle || null,
            instagram_handle: identity.instagramHandle || null,
            linked_at: identity.linkedAt,
            link_confidence: identity.linkConfidence,
            link_evidence: identity.linkEvidence,
        }, { onConflict: 'id' });
    } catch (e) {
        logger.warn(`[supabase-nurture] Cross-identity sync failed: ${formatError(e)}`);
    }
}

export async function syncDepthMetricsToSupabase(metrics: ConversationDepthMetrics): Promise<void> {
    const sb = getClient();
    if (!sb) return;

    try {
        await sb.from('conversation_depth_metrics').upsert({
            username: metrics.username,
            platform: metrics.platform,
            avg_message_length: metrics.avgMessageLength,
            topic_variety: metrics.topicVariety,
            personal_disclosure_level: metrics.personalDisclosureLevel,
            question_asking_ratio: metrics.questionAskingRatio,
            conversation_quality_score: metrics.conversationQualityScore,
            exchange_count: metrics.exchangeCount,
            last_calculated: metrics.lastCalculated,
        }, { onConflict: 'username,platform' });
    } catch (e) {
        logger.warn(`[supabase-nurture] Depth metrics sync failed: ${formatError(e)}`);
    }
}
