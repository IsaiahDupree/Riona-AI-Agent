/**
 * Friendship Tiers — Evaluation, promotion, and demotion logic.
 */

import { logger } from '../utils/logger';
import { FriendshipTier, TierConfig, NurtureProfile } from '../types/nurture';
import { loadNurtureProfile, saveNurtureProfile, getAllNurtureProfiles } from './store';
import { getDepthPromoBonus } from './depth';

// ── Tier configuration ──────────────────────────────────────────────

export const TIER_CONFIGS: Record<FriendshipTier, TierConfig> = {
    acquaintance: {
        tier: 'acquaintance',
        checkInFrequencyHours: 336,  // 2 weeks
        messageStyle: 'formal',
        depthExpectation: 'surface',
        promotionThreshold: {
            minReplyCount: 3,
            minPositiveSentimentRatio: 0.5,
            minConversationDepthScore: 20,
            minEngagementWithOurContent: 0,
            minDaysSinceFirstContact: 3,
        },
        demotionInactivityDays: 60,
    },
    casual_friend: {
        tier: 'casual_friend',
        checkInFrequencyHours: 168,  // 1 week
        messageStyle: 'casual',
        depthExpectation: 'moderate',
        promotionThreshold: {
            minReplyCount: 8,
            minPositiveSentimentRatio: 0.6,
            minConversationDepthScore: 40,
            minEngagementWithOurContent: 2,
            minDaysSinceFirstContact: 14,
        },
        demotionInactivityDays: 45,
    },
    close_friend: {
        tier: 'close_friend',
        checkInFrequencyHours: 84,   // ~3.5 days
        messageStyle: 'familiar',
        depthExpectation: 'deep',
        promotionThreshold: {
            minReplyCount: 20,
            minPositiveSentimentRatio: 0.7,
            minConversationDepthScore: 60,
            minEngagementWithOurContent: 5,
            minDaysSinceFirstContact: 30,
        },
        demotionInactivityDays: 30,
    },
    inner_circle: {
        tier: 'inner_circle',
        checkInFrequencyHours: 48,   // 2 days
        messageStyle: 'intimate',
        depthExpectation: 'vulnerable',
        promotionThreshold: {
            minReplyCount: 999, // effectively manual-only promotion
            minPositiveSentimentRatio: 0.8,
            minConversationDepthScore: 80,
            minEngagementWithOurContent: 10,
            minDaysSinceFirstContact: 60,
        },
        demotionInactivityDays: -1,  // never auto-demote
    },
};

const TIER_ORDER: FriendshipTier[] = ['acquaintance', 'casual_friend', 'close_friend', 'inner_circle'];

// ── Tier evaluation ─────────────────────────────────────────────────

export interface TierEvaluation {
    shouldPromote: boolean;
    shouldDemote: boolean;
    nextTier: FriendshipTier;
    reasons: string[];
}

export function evaluateTier(
    profile: NurtureProfile,
    replyCount: number,
    positiveSentimentRatio: number,
    engagementWithOurContent: number = 0
): TierEvaluation {
    const currentIndex = TIER_ORDER.indexOf(profile.tier);
    const reasons: string[] = [];

    // Check promotion
    if (currentIndex < TIER_ORDER.length - 1) {
        const config = TIER_CONFIGS[profile.tier];
        const threshold = config.promotionThreshold;
        const depthBonus = getDepthPromoBonus(profile.depth);
        const daysSinceCreated = (Date.now() - new Date(profile.createdAt).getTime()) / (1000 * 60 * 60 * 24);

        const meetsReplies = replyCount >= threshold.minReplyCount;
        const meetsSentiment = positiveSentimentRatio >= threshold.minPositiveSentimentRatio;
        const meetsDepth = (profile.depth.conversationQualityScore + depthBonus) >= threshold.minConversationDepthScore;
        const meetsEngagement = engagementWithOurContent >= threshold.minEngagementWithOurContent;
        const meetsTime = daysSinceCreated >= threshold.minDaysSinceFirstContact;

        if (meetsReplies && meetsSentiment && meetsDepth && meetsEngagement && meetsTime) {
            const nextTier = TIER_ORDER[currentIndex + 1];
            reasons.push(`${replyCount} replies (need ${threshold.minReplyCount})`);
            reasons.push(`${Math.round(positiveSentimentRatio * 100)}% positive (need ${Math.round(threshold.minPositiveSentimentRatio * 100)}%)`);
            reasons.push(`depth ${profile.depth.conversationQualityScore}+${depthBonus} (need ${threshold.minConversationDepthScore})`);
            reasons.push(`${engagementWithOurContent} engagements (need ${threshold.minEngagementWithOurContent})`);
            reasons.push(`${Math.round(daysSinceCreated)}d (need ${threshold.minDaysSinceFirstContact}d)`);

            return { shouldPromote: true, shouldDemote: false, nextTier, reasons };
        }
    }

    // Check demotion
    if (currentIndex > 0) {
        const config = TIER_CONFIGS[profile.tier];
        if (config.demotionInactivityDays > 0) {
            const lastActivity = profile.lastCheckIn || profile.tierPromotedAt || profile.createdAt;
            const daysSinceActivity = (Date.now() - new Date(lastActivity).getTime()) / (1000 * 60 * 60 * 24);

            if (daysSinceActivity >= config.demotionInactivityDays) {
                const nextTier = TIER_ORDER[currentIndex - 1];
                reasons.push(`${Math.round(daysSinceActivity)}d inactive (limit: ${config.demotionInactivityDays}d)`);
                return { shouldPromote: false, shouldDemote: true, nextTier, reasons };
            }
        }
    }

    return { shouldPromote: false, shouldDemote: false, nextTier: profile.tier, reasons: [] };
}

// ── Promote / Demote ────────────────────────────────────────────────

export function promoteTier(username: string, platform: 'twitter' | 'instagram'): NurtureProfile {
    const profile = loadNurtureProfile(username, platform);
    const currentIndex = TIER_ORDER.indexOf(profile.tier);
    if (currentIndex >= TIER_ORDER.length - 1) return profile;

    const newTier = TIER_ORDER[currentIndex + 1];
    const now = new Date().toISOString();

    profile.tier = newTier;
    profile.tierPromotedAt = now;
    profile.tierHistory.push({ tier: newTier, at: now });

    // Recalculate next check-in based on new tier
    const config = TIER_CONFIGS[newTier];
    profile.nextCheckInDue = new Date(Date.now() + config.checkInFrequencyHours * 60 * 60 * 1000).toISOString();

    saveNurtureProfile(profile);
    logger.info(`[tiers] Promoted @${username} (${platform}) to ${newTier}`);
    return profile;
}

export function demoteTier(username: string, platform: 'twitter' | 'instagram'): NurtureProfile {
    const profile = loadNurtureProfile(username, platform);
    const currentIndex = TIER_ORDER.indexOf(profile.tier);
    if (currentIndex <= 0) return profile;

    const newTier = TIER_ORDER[currentIndex - 1];
    const now = new Date().toISOString();

    profile.tier = newTier;
    profile.tierPromotedAt = now; // Reset inactivity clock to demotion time
    profile.tierHistory.push({ tier: newTier, at: now });

    const config = TIER_CONFIGS[newTier];
    profile.nextCheckInDue = new Date(Date.now() + config.checkInFrequencyHours * 60 * 60 * 1000).toISOString();

    saveNurtureProfile(profile);
    logger.info(`[tiers] Demoted @${username} (${platform}) to ${newTier}`);
    return profile;
}

// ── Tier prompt hints for AI ────────────────────────────────────────

export function getTierForMessage(tier: FriendshipTier): { style: string; depthHint: string } {
    const config = TIER_CONFIGS[tier];
    const styleHints: Record<string, string> = {
        formal: 'Be polite and professional. This is a new acquaintance.',
        casual: 'Be friendly and relaxed. You know each other a bit.',
        familiar: 'Be warm and personal. You are close friends. Use inside references if possible.',
        intimate: 'Be genuinely close and open. This is your inner circle. Be real and vulnerable.',
    };
    const depthHints: Record<string, string> = {
        surface: 'Keep it light — share observations or ask simple questions.',
        moderate: 'Go a bit deeper — share opinions, ask about their work or goals.',
        deep: 'Be personal — share experiences, ask meaningful questions, show you care.',
        vulnerable: 'Be authentic — share struggles, celebrate together, be fully yourself.',
    };

    return {
        style: styleHints[config.messageStyle] || styleHints.formal,
        depthHint: depthHints[config.depthExpectation] || depthHints.surface,
    };
}

// ── Batch evaluation (called from scheduler) ────────────────────────

export function runTierEvaluation(platform?: 'twitter' | 'instagram'): {
    promoted: string[];
    demoted: string[];
} {
    const profiles = getAllNurtureProfiles(platform);
    const promoted: string[] = [];
    const demoted: string[] = [];

    for (const profile of profiles) {
        const replyCount = profile.depth.exchangeCount;
        const sentimentRatio = profile.depth.personalDisclosureLevel > 50 ? 0.7 : 0.4;

        // Read engagement from VR health history (positive events = engagement with our content)
        let engagement = 0;
        try {
            const { loadVRState } = require('./vr-scheduler');
            const vrState = loadVRState(profile.username, profile.platform);
            engagement = vrState.totalRepliesReceived;
        } catch (_) { /* VR not initialized */ }

        const evaluation = evaluateTier(profile, replyCount, sentimentRatio, engagement);

        if (evaluation.shouldPromote) {
            promoteTier(profile.username, profile.platform);
            promoted.push(`${profile.platform}/@${profile.username} → ${evaluation.nextTier}`);
        } else if (evaluation.shouldDemote) {
            demoteTier(profile.username, profile.platform);
            demoted.push(`${profile.platform}/@${profile.username} → ${evaluation.nextTier}`);
        }
    }

    if (promoted.length > 0 || demoted.length > 0) {
        logger.info(`[tiers] Evaluation: ${promoted.length} promoted, ${demoted.length} demoted`);
    }

    return { promoted, demoted };
}
