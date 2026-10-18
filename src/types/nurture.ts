/**
 * Friendship Nurture System — Type Definitions
 */

// ── Friendship Tiers ────────────────────────────────────────────────

export type FriendshipTier = 'acquaintance' | 'casual_friend' | 'close_friend' | 'inner_circle';

export interface TierConfig {
    tier: FriendshipTier;
    checkInFrequencyHours: number;
    messageStyle: 'formal' | 'casual' | 'familiar' | 'intimate';
    depthExpectation: 'surface' | 'moderate' | 'deep' | 'vulnerable';
    promotionThreshold: TierPromotionCriteria;
    demotionInactivityDays: number;
}

export interface TierPromotionCriteria {
    minReplyCount: number;
    minPositiveSentimentRatio: number;
    minConversationDepthScore: number;
    minEngagementWithOurContent: number;
    minDaysSinceFirstContact: number;
}

// ── Interest Matching ───────────────────────────────────────────────

export interface InterestProfile {
    username: string;
    platform: 'twitter' | 'instagram';
    interests: InterestEntry[];
    lastUpdated: string;
}

export interface InterestEntry {
    topic: string;
    confidence: number;
    source: 'bio' | 'post' | 'engagement' | 'conversation';
    firstSeen: string;
    mentions: number;
}

export interface InterestMatchScore {
    username: string;
    overlapScore: number;
    sharedInterests: string[];
    theirUniqueInterests: string[];
    bestInterestForDM: string;
}

// ── Cross-Platform Identity ─────────────────────────────────────────

export interface CrossPlatformIdentity {
    id: string;
    twitterHandle?: string;
    instagramHandle?: string;
    linkedAt: string;
    linkConfidence: 'manual' | 'high' | 'medium';
    linkEvidence: string[];
}

export interface CrossPlatformState {
    personId: string;
    combinedWarmth: number;
    highestTier: FriendshipTier;
    lastMessagedTwitter?: string;
    lastMessagedInstagram?: string;
    platformPreference?: 'twitter' | 'instagram';
}

// ── Conversation Depth ──────────────────────────────────────────────

export interface ConversationDepthMetrics {
    username: string;
    platform: 'twitter' | 'instagram';
    avgMessageLength: number;
    topicVariety: number;
    personalDisclosureLevel: number;
    questionAskingRatio: number;
    conversationQualityScore: number;
    exchangeCount: number;
    lastCalculated: string;
}

// ── Proactive Check-ins ─────────────────────────────────────────────

export type CheckInType = 'content_reaction' | 'work_question' | 'resource_share' | 'celebrate_win';

export interface CheckInRecord {
    username: string;
    platform: 'twitter' | 'instagram';
    type: CheckInType;
    scheduledFor: string;
    sentAt?: string;
    contentReference?: string;
    messageUsed?: string;
    gotReply?: boolean;
}

// ── Nurture Profile (main enriched record per person) ───────────────

export interface NurtureProfile {
    username: string;
    platform: 'twitter' | 'instagram';
    personId?: string;
    tier: FriendshipTier;
    tierPromotedAt?: string;
    tierHistory: Array<{ tier: FriendshipTier; at: string }>;
    interests: InterestProfile;
    depth: ConversationDepthMetrics;
    checkIns: CheckInRecord[];
    lastCheckIn?: string;
    nextCheckInDue?: string;
    interestMessagePerformance: Record<string, { sent: number; replied: number }>;
    createdAt: string;
}
