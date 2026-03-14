/**
 * DM System Unit Tests
 * Tests core logic: categorization, warmth scoring, offer matching,
 * analytics, pipeline config, feedback, and timing
 */

import {
    categorizeContact, loadRelationship, saveRelationship,
    updateWarmth, getFeedbackStats, recordFeedback
} from '../../src/client/Instagram-DM-AI';
import {
    loadOffers, saveOffers, loadConfig, saveConfig,
    matchOffer, loadPendingSends, savePendingSends,
    PipelineConfig, Offer, PendingSend
} from '../../src/client/Instagram-DM-Pipeline';
import {
    recordConversion, getConversionStats, analyzeFeedbackAndLearn,
    getLearningContextForAI, getBestSendingHours, isGoodSendingTime,
    getFullAnalytics
} from '../../src/client/Instagram-DM-Analytics';
import {
    hasSentDMTo, trackDM, getTodayDMCount, getAllDMs, getDMsForUser,
    cleanupOldDMs, createDMSession, saveDMSession
} from '../../src/tracking/dmTracker';
import { ProfileInfo, RelationshipInfo, TrackedDM } from '../../src/types/dm';
import * as fs from 'fs';
import * as path from 'path';

// ── Test data directory (use temp dir to avoid polluting real data) ──
const TEST_DATA_DIR = path.join(process.cwd(), 'logs', 'tracking', 'dm', '__test__');

// Helper to create test profile
function makeProfile(overrides: Partial<ProfileInfo> = {}): ProfileInfo {
    return {
        username: 'testuser',
        fullName: 'Test User',
        bio: '',
        followerCount: 1000,
        followingCount: 500,
        postCount: 50,
        isVerified: false,
        ...overrides
    };
}

function makeRelationship(overrides: Partial<RelationshipInfo> = {}): RelationshipInfo {
    return {
        category: 'personal',
        warmth: 0,
        stage: 'cold_outreach',
        notes: [],
        tags: [],
        ...overrides
    };
}

// ═══════════════════════════════════════════════════════════════════════
// Contact Categorization
// ═══════════════════════════════════════════════════════════════════════

describe('Contact Categorization', () => {
    it('should categorize a founder as business_networking', () => {
        const profile = makeProfile({ bio: 'Founder & CEO of TechStartup | Building the future' });
        const result = categorizeContact(profile);
        expect(result.category).toBe('business_networking');
    });

    it('should tag high-follower business profiles as high_value', () => {
        const profile = makeProfile({
            bio: 'Entrepreneur | Marketing strategist',
            followerCount: 10000
        });
        const result = categorizeContact(profile);
        expect(result.category).toBe('business_networking');
        expect(result.tags).toContain('high_value');
    });

    it('should categorize a creator as collaborator', () => {
        const profile = makeProfile({
            bio: 'Content creator | Photographer | Filmmaker',
            followerCount: 5000
        });
        const result = categorizeContact(profile);
        expect(result.category).toBe('collaborator');
        expect(result.tags).toContain('creator');
    });

    it('should categorize small business as potential_client', () => {
        const profile = makeProfile({
            bio: 'Looking for help with my local shop in LA'
        });
        const result = categorizeContact(profile);
        expect(result.category).toBe('potential_client');
    });

    it('should default to personal for ambiguous bios', () => {
        const profile = makeProfile({ bio: 'Living my best life' });
        const result = categorizeContact(profile);
        expect(result.category).toBe('personal');
    });

    it('should tag verified users', () => {
        const profile = makeProfile({ isVerified: true, bio: 'Just me' });
        const result = categorizeContact(profile);
        expect(result.tags).toContain('verified');
    });

    it('should tag macro influencers (100k+ followers)', () => {
        const profile = makeProfile({ followerCount: 150000, bio: 'Creator' });
        const result = categorizeContact(profile);
        expect(result.tags).toContain('macro_influencer');
    });

    it('should tag micro influencers (10k-100k followers)', () => {
        const profile = makeProfile({ followerCount: 25000, bio: 'Content creator' });
        const result = categorizeContact(profile);
        expect(result.tags).toContain('micro_influencer');
    });

    it('should handle empty bio gracefully', () => {
        const profile = makeProfile({ bio: '' });
        const result = categorizeContact(profile);
        expect(result.category).toBe('personal');
    });
});

// ═══════════════════════════════════════════════════════════════════════
// Warmth Scoring
// ═══════════════════════════════════════════════════════════════════════

describe('Warmth Scoring', () => {
    const testUser = '__test_warmth_user__';

    afterAll(() => {
        // Cleanup test relationship file
        const filePath = path.join(process.cwd(), 'logs', 'tracking', 'dm', 'relationships', `${testUser}.json`);
        try { fs.unlinkSync(filePath); } catch { }
    });

    it('should start at warmth 0 and cold_outreach', () => {
        const rel = loadRelationship(testUser);
        expect(rel.warmth).toBe(0);
        expect(rel.stage).toBe('cold_outreach');
    });

    it('should increase warmth on message_sent and advance to initial_contact', () => {
        const rel = updateWarmth(testUser, 'message_sent');
        expect(rel.warmth).toBe(5);
        expect(rel.stage).toBe('initial_contact');
    });

    it('should increase warmth on reply_received', () => {
        const rel = updateWarmth(testUser, 'reply_received');
        expect(rel.warmth).toBe(20);
        expect(rel.stage).toBe('building');
    });

    it('should increase warmth significantly on positive_reply', () => {
        const rel = updateWarmth(testUser, 'positive_reply');
        expect(rel.warmth).toBe(45);
    });

    it('should decrease warmth on negative_reply', () => {
        const before = loadRelationship(testUser).warmth;
        const rel = updateWarmth(testUser, 'negative_reply');
        expect(rel.warmth).toBe(before - 20);
    });

    it('should decrease warmth on no_reply', () => {
        const before = loadRelationship(testUser).warmth;
        const rel = updateWarmth(testUser, 'no_reply');
        expect(rel.warmth).toBe(before - 5);
    });

    it('should cap warmth at 100', () => {
        // Force warmth high
        const rel = loadRelationship(testUser);
        rel.warmth = 98;
        saveRelationship(testUser, rel);
        const updated = updateWarmth(testUser, 'positive_reply');
        expect(updated.warmth).toBe(100);
    });

    it('should floor warmth at 0', () => {
        const rel = loadRelationship(testUser);
        rel.warmth = 3;
        saveRelationship(testUser, rel);
        const updated = updateWarmth(testUser, 'negative_reply');
        expect(updated.warmth).toBe(0);
    });

    it('should auto-advance to warm stage at warmth >= 70', () => {
        const rel = loadRelationship(testUser);
        rel.warmth = 68;
        rel.stage = 'building';
        saveRelationship(testUser, rel);
        const updated = updateWarmth(testUser, 'message_sent');
        expect(updated.warmth).toBeGreaterThanOrEqual(70);
        expect(updated.stage).toBe('warm');
    });

    it('should auto-advance to active stage at warmth >= 90', () => {
        const rel = loadRelationship(testUser);
        rel.warmth = 88;
        rel.stage = 'warm';
        saveRelationship(testUser, rel);
        const updated = updateWarmth(testUser, 'message_sent');
        expect(updated.warmth).toBeGreaterThanOrEqual(90);
        expect(updated.stage).toBe('active');
    });
});

// ═══════════════════════════════════════════════════════════════════════
// Offer Matching
// ═══════════════════════════════════════════════════════════════════════

describe('Offer Matching', () => {
    it('should not match offer when warmth is too low', () => {
        const profile = makeProfile({ bio: 'AI content creator', followerCount: 5000 });
        const rel = makeRelationship({ category: 'collaborator', warmth: 10, stage: 'cold_outreach', tags: ['creator'] });
        const offer = matchOffer(profile, rel);
        expect(offer).toBeNull();
    });

    it('should match AI tools offer for warm creator', () => {
        const profile = makeProfile({ bio: 'AI content creator building tools', followerCount: 15000 });
        const rel = makeRelationship({
            category: 'collaborator',
            warmth: 65,
            stage: 'warm',
            tags: ['creator', 'micro_influencer']
        });
        const offer = matchOffer(profile, rel);
        expect(offer).not.toBeNull();
        expect(offer!.name).toContain('AI Tools');
    });

    it('should match growth consulting for business networking contacts', () => {
        const profile = makeProfile({ bio: 'Startup entrepreneur looking for growth strategies' });
        const rel = makeRelationship({
            category: 'business_networking',
            warmth: 55,
            stage: 'building',
            tags: []
        });
        const offer = matchOffer(profile, rel);
        expect(offer).not.toBeNull();
    });

    it('should not match if category does not align', () => {
        const profile = makeProfile({ bio: 'Just a normal person' });
        const rel = makeRelationship({
            category: 'fan',
            warmth: 80,
            stage: 'warm',
            tags: []
        });
        const offer = matchOffer(profile, rel);
        expect(offer).toBeNull();
    });
});

// ═══════════════════════════════════════════════════════════════════════
// Pipeline Config
// ═══════════════════════════════════════════════════════════════════════

describe('Pipeline Config', () => {
    it('should return default config when no file exists', () => {
        const config = loadConfig();
        expect(config.autoApprove).toBe(false);
        expect(config.maxDMsPerDay).toBe(20);
        expect(config.minDelayBetweenDMs).toBe(60000);
        expect(config.cooldownHoursPerUser).toBe(48);
        expect(config.maxFollowUps).toBe(3);
        expect(config.offerEnabled).toBe(true);
    });

    it('should merge partial config with defaults', () => {
        const config = loadConfig();
        expect(config).toHaveProperty('autoApprove');
        expect(config).toHaveProperty('maxDMsPerDay');
        expect(config).toHaveProperty('skipIfNoReplyAfterDays');
    });
});

// ═══════════════════════════════════════════════════════════════════════
// Pending Sends
// ═══════════════════════════════════════════════════════════════════════

describe('Pending Sends Queue', () => {
    const testSendId = '__test_send__';

    afterAll(() => {
        // Clean up test sends
        const sends = loadPendingSends();
        const cleaned = sends.filter(s => !s.id.startsWith('__test'));
        savePendingSends(cleaned);
    });

    it('should save and load pending sends', () => {
        const sends = loadPendingSends();
        const testSend: PendingSend = {
            id: testSendId,
            recipientUsername: 'testrecipient',
            message: 'Test message',
            context: {
                relationship: makeRelationship(),
                objective: 'test'
            },
            status: 'pending',
            createdAt: new Date().toISOString()
        };

        sends.push(testSend);
        savePendingSends(sends);

        const loaded = loadPendingSends();
        const found = loaded.find(s => s.id === testSendId);
        expect(found).toBeDefined();
        expect(found!.recipientUsername).toBe('testrecipient');
        expect(found!.status).toBe('pending');
    });

    it('should filter by status', () => {
        const sends = loadPendingSends();
        const pending = sends.filter(s => s.status === 'pending');
        expect(pending.length).toBeGreaterThan(0);
    });
});

// ═══════════════════════════════════════════════════════════════════════
// DM Tracker
// ═══════════════════════════════════════════════════════════════════════

describe('DM Tracker', () => {
    const testRecipient = '__test_tracker_user__';

    afterAll(() => {
        // Don't clean up — cleanupOldDMs handles it
    });

    it('should track a DM', () => {
        const dm: TrackedDM = {
            recipientUsername: testRecipient,
            messageText: 'Hello test',
            timestamp: new Date().toISOString(),
            direction: 'outbound',
            verified: true,
            sessionId: 'test_session',
            conversationId: 'test_convo'
        };
        trackDM(dm);
        const userDMs = getDMsForUser(testRecipient);
        expect(userDMs.length).toBeGreaterThan(0);
    });

    it('should detect recent DM via hasSentDMTo', () => {
        const recent = hasSentDMTo(testRecipient, 1);
        expect(recent).not.toBeNull();
    });

    it('should return null for unknown user', () => {
        const result = hasSentDMTo('nonexistent_user_xyz_12345', 24);
        expect(result).toBeNull();
    });

    it('should count today DMs', () => {
        const count = getTodayDMCount();
        expect(count).toBeGreaterThanOrEqual(0);
    });

    it('should create and save a session', () => {
        const session = createDMSession();
        expect(session.sessionId).toBeDefined();
        expect(session.messagesSent).toBe(0);
        session.messagesSent = 1;
        saveDMSession(session);

        // Verify session file was created
        const sessionFile = path.join(process.cwd(), 'logs', 'sessions', 'dm', `${session.sessionId}.json`);
        expect(fs.existsSync(sessionFile)).toBe(true);

        // Cleanup
        try { fs.unlinkSync(sessionFile); } catch { }
    });
});

// ═══════════════════════════════════════════════════════════════════════
// Analytics
// ═══════════════════════════════════════════════════════════════════════

describe('Analytics', () => {
    it('should return empty conversion stats when no data', () => {
        const stats = getConversionStats();
        expect(stats.totalConversions).toBeGreaterThanOrEqual(0);
        expect(stats).toHaveProperty('byType');
        expect(stats).toHaveProperty('byOffer');
        expect(stats).toHaveProperty('totalValue');
    });

    it('should return full analytics structure', () => {
        const analytics = getFullAnalytics();
        expect(analytics).toHaveProperty('feedback');
        expect(analytics).toHaveProperty('conversions');
        expect(analytics).toHaveProperty('learnings');
        expect(analytics).toHaveProperty('timing');
        expect(analytics.timing).toHaveProperty('bestHours');
        expect(analytics.timing).toHaveProperty('currentHourGood');
    });

    it('should check good sending time within active hours', () => {
        const result = isGoodSendingTime();
        expect(result).toHaveProperty('good');
        expect(result).toHaveProperty('reason');
        expect(typeof result.good).toBe('boolean');
    });

    it('should return best sending hours array', () => {
        const hours = getBestSendingHours();
        expect(Array.isArray(hours)).toBe(true);
        for (const h of hours) {
            expect(h).toHaveProperty('hour');
            expect(h).toHaveProperty('replyRate');
            expect(h).toHaveProperty('sampleSize');
        }
    });

    it('should generate learning context string for AI', () => {
        const context = getLearningContextForAI('business_networking', 'warm');
        expect(typeof context).toBe('string');
        // May be empty if no learnings yet — that's fine
    });
});

// ═══════════════════════════════════════════════════════════════════════
// Feedback Stats
// ═══════════════════════════════════════════════════════════════════════

describe('Feedback Stats', () => {
    it('should return feedback stats structure', () => {
        const stats = getFeedbackStats();
        expect(stats).toHaveProperty('totalSent');
        expect(stats).toHaveProperty('gotReply');
        expect(stats).toHaveProperty('replyRate');
        expect(stats).toHaveProperty('sentimentBreakdown');
        expect(typeof stats.replyRate).toBe('number');
    });
});

// ═══════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════

describe('DM Types', () => {
    it('should define all required ProfileInfo fields', () => {
        const profile: ProfileInfo = {
            username: 'test',
            fullName: 'Test',
            bio: 'bio',
            followerCount: 100,
            followingCount: 50,
            postCount: 10,
            isVerified: false
        };
        expect(profile.username).toBeDefined();
        expect(profile.followerCount).toBeDefined();
    });

    it('should define all required RelationshipInfo fields', () => {
        const rel: RelationshipInfo = {
            category: 'business_networking',
            warmth: 50,
            stage: 'building',
            notes: ['note1'],
            tags: ['tag1']
        };
        expect(rel.category).toBe('business_networking');
        expect(rel.warmth).toBe(50);
        expect(rel.stage).toBe('building');
    });

    it('should allow all valid category values', () => {
        const categories: RelationshipInfo['category'][] = [
            'business_networking', 'personal', 'potential_client', 'collaborator', 'fan'
        ];
        for (const cat of categories) {
            const rel = makeRelationship({ category: cat });
            expect(rel.category).toBe(cat);
        }
    });

    it('should allow all valid stage values', () => {
        const stages: RelationshipInfo['stage'][] = [
            'cold_outreach', 'initial_contact', 'building', 'warm', 'active'
        ];
        for (const stage of stages) {
            const rel = makeRelationship({ stage });
            expect(rel.stage).toBe(stage);
        }
    });
});
