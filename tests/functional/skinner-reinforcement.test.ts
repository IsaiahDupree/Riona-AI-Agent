/**
 * Skinner Reinforcement System Tests
 * Tests: VI delays, jackpot mechanics, offer readiness, RL meta-optimization,
 * VR scheduling, health management, thinning, and multi-arm bandit
 */

import {
    loadVRState, saveVRState, recordInteractionAndDecide,
    updateHealth, recordBanditReward, recordBanditPull,
    isJackpotReply, computeOfferReadiness, getVRStats,
    getContactsReadyForEngagement, VRContactState, CommentStyle
} from '../../src/nurture/vr-scheduler';
import {
    computeReplyDelay, scheduleDelayedReply, getReadyReplies,
    markReplySent, markReplyFailed, cleanupDelayedQueue, hasPendingReply, DelayedReplyEntry
} from '../../src/nurture/vi-delays';
import * as fs from 'fs';
import * as path from 'path';

// ── Test Helpers ──────────────────────────────────────────────────────

const TEST_VR_DIR = path.join(process.cwd(), 'logs', 'tracking', 'nurture', 'vr-states');
const TEST_QUEUE_FILE = path.join(process.cwd(), 'logs', 'tracking', 'nurture', 'delayed-replies.json');

function cleanupTestState(username: string, platform: string) {
    const fp = path.join(TEST_VR_DIR, `${platform}_${username}.json`);
    try { fs.unlinkSync(fp); } catch (_) { /* ignore */ }
}

function cleanupDelayedQueue_file() {
    try { fs.unlinkSync(TEST_QUEUE_FILE); } catch (_) { /* ignore */ }
}

const testUser = `test_skinner_${Date.now()}`;
const testUser2 = `test_skinner2_${Date.now()}`;

afterAll(() => {
    cleanupTestState(testUser, 'twitter');
    cleanupTestState(testUser, 'instagram');
    cleanupTestState(testUser2, 'twitter');
    cleanupDelayedQueue_file();
});

// ═══════════════════════════════════════════════════════════════════════
// VR State Management
// ═══════════════════════════════════════════════════════════════════════

describe('VR State Management', () => {
    beforeEach(() => cleanupTestState(testUser, 'twitter'));

    it('should create new state with correct defaults', () => {
        const state = loadVRState(testUser, 'twitter');
        expect(state.username).toBe(testUser.toLowerCase());
        expect(state.platform).toBe('twitter');
        expect(state.counter).toBe(0);
        expect(state.health).toBe(0.7);
        expect(state.meanN).toBe(3);
        expect(state.thinningStage).toBe(0);
        expect(state.dmReplyCounter).toBe(0);
        expect(state.commentBandit.length).toBe(7);
        expect(state.nextThreshold).toBeGreaterThanOrEqual(1);
        expect(state.dmNextThreshold).toBeGreaterThanOrEqual(1);
    });

    it('should persist and reload state', () => {
        const state = loadVRState(testUser, 'twitter');
        state.counter = 5;
        state.health = 0.85;
        saveVRState(state);

        const reloaded = loadVRState(testUser, 'twitter');
        expect(reloaded.counter).toBe(5);
        expect(reloaded.health).toBe(0.85);
    });

    it('should backward-compat migrate missing DM jackpot fields', () => {
        // Write state without dmReplyCounter/dmNextThreshold
        const fp = path.join(TEST_VR_DIR, `twitter_${testUser.toLowerCase()}.json`);
        const minimalState: any = {
            username: testUser.toLowerCase(),
            platform: 'twitter',
            counter: 3,
            nextThreshold: 4,
            meanN: 3,
            health: 0.7,
            healthHistory: [],
            totalReinforcements: 0,
            thinningStage: 0,
            commentBandit: [],
            commentsToday: 0,
            lastCommentDate: '',
            consecutiveIgnored: 0,
            lastCommentAt: null,
            pausedUntil: null,
            totalComments: 0,
            totalRepliesReceived: 0,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        };
        if (!fs.existsSync(path.dirname(fp))) fs.mkdirSync(path.dirname(fp), { recursive: true });
        fs.writeFileSync(fp, JSON.stringify(minimalState));

        const loaded = loadVRState(testUser, 'twitter');
        expect(loaded.dmReplyCounter).toBe(0);
        expect(loaded.dmNextThreshold).toBeGreaterThanOrEqual(1);
    });
});

// ═══════════════════════════════════════════════════════════════════════
// VR Decision Engine
// ═══════════════════════════════════════════════════════════════════════

describe('VR Decision Engine', () => {
    beforeEach(() => cleanupTestState(testUser, 'twitter'));

    it('should not engage when counter is below threshold', () => {
        const state = loadVRState(testUser, 'twitter');
        state.nextThreshold = 10;
        state.counter = 0;
        saveVRState(state);

        const decision = recordInteractionAndDecide(testUser, 'twitter');
        expect(decision.shouldEngage).toBe(false);
        expect(decision.reason).toContain('not yet');
    });

    it('should engage when counter reaches threshold', () => {
        const state = loadVRState(testUser, 'twitter');
        state.nextThreshold = 1; // Will trigger on next interaction
        state.counter = 0;
        saveVRState(state);

        const decision = recordInteractionAndDecide(testUser, 'twitter');
        expect(decision.shouldEngage).toBe(true);
        expect(decision.style).toBeDefined();
    });

    it('should reset counter after engagement', () => {
        const state = loadVRState(testUser, 'twitter');
        state.nextThreshold = 1;
        state.counter = 0;
        saveVRState(state);

        recordInteractionAndDecide(testUser, 'twitter');
        const after = loadVRState(testUser, 'twitter');
        expect(after.counter).toBe(0);
        expect(after.totalComments).toBe(1);
    });

    it('should enforce daily cap per user', () => {
        const state = loadVRState(testUser, 'twitter');
        const today = new Date();
        state.lastCommentDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
        state.commentsToday = 2; // At cap
        state.nextThreshold = 1;
        state.counter = 0;
        saveVRState(state);

        const decision = recordInteractionAndDecide(testUser, 'twitter');
        expect(decision.shouldEngage).toBe(false);
        expect(decision.reason).toContain('Daily cap');
    });

    it('should pause when health drops below floor', () => {
        const state = loadVRState(testUser, 'twitter');
        state.health = 0.4; // Below 0.55 floor
        state.nextThreshold = 1;
        state.counter = 0;
        saveVRState(state);

        const decision = recordInteractionAndDecide(testUser, 'twitter');
        expect(decision.shouldEngage).toBe(false);
        expect(decision.reason).toContain('below floor');
    });

    it('should pause after consecutive ignored comments', () => {
        const state = loadVRState(testUser, 'twitter');
        state.consecutiveIgnored = 4; // At limit
        state.nextThreshold = 1;
        state.counter = 0;
        saveVRState(state);

        const decision = recordInteractionAndDecide(testUser, 'twitter');
        expect(decision.shouldEngage).toBe(false);
        expect(decision.reason).toContain('ignored');
    });

    it('should enforce minimum interval between comments', () => {
        const state = loadVRState(testUser, 'twitter');
        state.lastCommentAt = new Date().toISOString(); // Just commented
        state.nextThreshold = 1;
        state.counter = 0;
        saveVRState(state);

        const decision = recordInteractionAndDecide(testUser, 'twitter');
        expect(decision.shouldEngage).toBe(false);
        expect(decision.reason).toContain('Too soon');
    });
});

// ═══════════════════════════════════════════════════════════════════════
// Health Management
// ═══════════════════════════════════════════════════════════════════════

describe('Health Management', () => {
    beforeEach(() => cleanupTestState(testUser, 'twitter'));

    it('should increase health on reply_received', () => {
        const state = loadVRState(testUser, 'twitter');
        const initialHealth = state.health;
        const newHealth = updateHealth(testUser, 'twitter', 'reply_received');
        expect(newHealth).toBeGreaterThan(initialHealth);
    });

    it('should decrease health on comment_ignored', () => {
        const state = loadVRState(testUser, 'twitter');
        const initialHealth = state.health;
        const newHealth = updateHealth(testUser, 'twitter', 'comment_ignored');
        expect(newHealth).toBeLessThan(initialHealth);
    });

    it('should clamp health between 0 and 1', () => {
        const state = loadVRState(testUser, 'twitter');
        state.health = 0.99;
        saveVRState(state);
        const h1 = updateHealth(testUser, 'twitter', 'reply_received');
        expect(h1).toBeLessThanOrEqual(1.0);

        const state2 = loadVRState(testUser, 'twitter');
        state2.health = 0.01;
        saveVRState(state2);
        const h2 = updateHealth(testUser, 'twitter', 'dm_ignored');
        expect(h2).toBeGreaterThanOrEqual(0);
    });

    it('should reset consecutiveIgnored on positive event', () => {
        const state = loadVRState(testUser, 'twitter');
        state.consecutiveIgnored = 3;
        saveVRState(state);

        updateHealth(testUser, 'twitter', 'reply_received');
        const after = loadVRState(testUser, 'twitter');
        expect(after.consecutiveIgnored).toBe(0);
    });

    it('should increment consecutiveIgnored on comment_ignored', () => {
        const state = loadVRState(testUser, 'twitter');
        state.consecutiveIgnored = 1;
        saveVRState(state);

        updateHealth(testUser, 'twitter', 'comment_ignored');
        const after = loadVRState(testUser, 'twitter');
        expect(after.consecutiveIgnored).toBe(2);
    });

    it('should track health history', () => {
        updateHealth(testUser, 'twitter', 'reply_received');
        updateHealth(testUser, 'twitter', 'comment_ignored');
        const state = loadVRState(testUser, 'twitter');
        // Initial + 2 events
        expect(state.healthHistory.length).toBeGreaterThanOrEqual(3);
    });
});

// ═══════════════════════════════════════════════════════════════════════
// RL Meta-Optimization (health → meanN feedback)
// ═══════════════════════════════════════════════════════════════════════

describe('RL Meta-Optimization', () => {
    beforeEach(() => cleanupTestState(testUser, 'twitter'));

    it('should decrease meanN when health is declining', () => {
        const state = loadVRState(testUser, 'twitter');
        state.meanN = 5;
        // Simulate declining health history
        state.healthHistory = [
            { value: 0.8, delta: -0.04, reason: 'comment_ignored', at: new Date().toISOString() },
            { value: 0.76, delta: -0.04, reason: 'comment_ignored', at: new Date().toISOString() },
            { value: 0.72, delta: -0.04, reason: 'comment_ignored', at: new Date().toISOString() },
            { value: 0.68, delta: -0.04, reason: 'comment_ignored', at: new Date().toISOString() },
            { value: 0.64, delta: -0.04, reason: 'comment_ignored', at: new Date().toISOString() },
        ];
        saveVRState(state);

        // Trigger adjustMeanNFromHealth via updateHealth
        updateHealth(testUser, 'twitter', 'comment_ignored');
        const after = loadVRState(testUser, 'twitter');
        expect(after.meanN).toBeLessThan(5);
    });

    it('should increase meanN when health is rising', () => {
        const state = loadVRState(testUser, 'twitter');
        state.meanN = 3;
        // Simulate rising health history
        state.healthHistory = [
            { value: 0.7, delta: 0.08, reason: 'reply_received', at: new Date().toISOString() },
            { value: 0.78, delta: 0.08, reason: 'reply_received', at: new Date().toISOString() },
            { value: 0.86, delta: 0.08, reason: 'reply_received', at: new Date().toISOString() },
            { value: 0.89, delta: 0.03, reason: 'like_received', at: new Date().toISOString() },
            { value: 0.92, delta: 0.03, reason: 'like_received', at: new Date().toISOString() },
        ];
        saveVRState(state);

        updateHealth(testUser, 'twitter', 'reply_received');
        const after = loadVRState(testUser, 'twitter');
        expect(after.meanN).toBeGreaterThan(3);
    });

    it('should not adjust meanN with insufficient history', () => {
        const state = loadVRState(testUser, 'twitter');
        state.meanN = 3;
        state.healthHistory = [
            { value: 0.7, delta: 0, reason: 'initial', at: new Date().toISOString() },
        ];
        saveVRState(state);

        updateHealth(testUser, 'twitter', 'reply_received');
        const after = loadVRState(testUser, 'twitter');
        // meanN might change slightly due to the RL check after the update adds history,
        // but should be very close to 3
        expect(after.meanN).toBeGreaterThanOrEqual(2);
        expect(after.meanN).toBeLessThanOrEqual(4);
    });
});

// ═══════════════════════════════════════════════════════════════════════
// Jackpot DM Reply Mechanics
// ═══════════════════════════════════════════════════════════════════════

describe('Jackpot DM Reply Mechanics', () => {
    beforeEach(() => cleanupTestState(testUser, 'instagram'));

    it('should return non-jackpot when counter is below threshold', () => {
        const state = loadVRState(testUser, 'instagram');
        state.dmNextThreshold = 10;
        state.dmReplyCounter = 0;
        saveVRState(state);

        const decision = isJackpotReply(testUser, 'instagram');
        expect(decision.jackpot).toBe(false);
        expect(decision.reason).toContain('standard reply');
    });

    it('should trigger jackpot when counter reaches threshold', () => {
        const state = loadVRState(testUser, 'instagram');
        state.dmNextThreshold = 1; // Will trigger on next call
        state.dmReplyCounter = 0;
        saveVRState(state);

        const decision = isJackpotReply(testUser, 'instagram');
        expect(decision.jackpot).toBe(true);
        expect(decision.reason).toContain('VR threshold');
    });

    it('should reset counter and draw new threshold after jackpot', () => {
        const state = loadVRState(testUser, 'instagram');
        state.dmNextThreshold = 1;
        state.dmReplyCounter = 0;
        saveVRState(state);

        isJackpotReply(testUser, 'instagram');
        const after = loadVRState(testUser, 'instagram');
        expect(after.dmReplyCounter).toBe(0);
        expect(after.dmNextThreshold).toBeGreaterThanOrEqual(1);
    });

    it('should increment counter on non-jackpot', () => {
        const state = loadVRState(testUser, 'instagram');
        state.dmNextThreshold = 100;
        state.dmReplyCounter = 5;
        saveVRState(state);

        isJackpotReply(testUser, 'instagram');
        const after = loadVRState(testUser, 'instagram');
        expect(after.dmReplyCounter).toBe(6);
    });

    it('should eventually trigger jackpot over many calls', () => {
        const state = loadVRState(testUser, 'instagram');
        state.dmNextThreshold = 3;
        state.dmReplyCounter = 0;
        saveVRState(state);

        let gotJackpot = false;
        for (let i = 0; i < 50; i++) {
            const decision = isJackpotReply(testUser, 'instagram');
            if (decision.jackpot) {
                gotJackpot = true;
                break;
            }
        }
        expect(gotJackpot).toBe(true);
    });
});

// ═══════════════════════════════════════════════════════════════════════
// Offer Readiness Score
// ═══════════════════════════════════════════════════════════════════════

describe('Offer Readiness Score', () => {
    beforeEach(() => cleanupTestState(testUser, 'twitter'));

    it('should return score between 0 and 1', () => {
        const result = computeOfferReadiness(testUser, 'twitter');
        expect(result.score).toBeGreaterThanOrEqual(0);
        expect(result.score).toBeLessThanOrEqual(1);
    });

    it('should include all breakdown components', () => {
        const result = computeOfferReadiness(testUser, 'twitter');
        expect(result.breakdown).toHaveProperty('healthComponent');
        expect(result.breakdown).toHaveProperty('tierComponent');
        expect(result.breakdown).toHaveProperty('velocityComponent');
        expect(result.breakdown).toHaveProperty('sentimentComponent');
    });

    it('should reflect health in the score', () => {
        const state = loadVRState(testUser, 'twitter');
        state.health = 0.9;
        saveVRState(state);
        const highHealth = computeOfferReadiness(testUser, 'twitter');

        state.health = 0.3;
        saveVRState(state);
        const lowHealth = computeOfferReadiness(testUser, 'twitter');

        expect(highHealth.score).toBeGreaterThan(lowHealth.score);
    });

    it('should count positive events for velocity', () => {
        const state = loadVRState(testUser, 'twitter');
        const now = Date.now();
        state.healthHistory = [];
        for (let i = 0; i < 8; i++) {
            state.healthHistory.push({
                value: 0.7 + i * 0.02,
                delta: 0.08,
                reason: 'reply_received',
                at: new Date(now - i * 24 * 60 * 60 * 1000).toISOString()
            });
        }
        saveVRState(state);

        const result = computeOfferReadiness(testUser, 'twitter');
        expect(result.breakdown.velocityComponent).toBeGreaterThan(0.5);
    });

    it('should return low velocity with no recent history', () => {
        const state = loadVRState(testUser, 'twitter');
        state.healthHistory = [];
        saveVRState(state);

        const result = computeOfferReadiness(testUser, 'twitter');
        expect(result.breakdown.velocityComponent).toBe(0);
    });
});

// ═══════════════════════════════════════════════════════════════════════
// Multi-Arm Bandit
// ═══════════════════════════════════════════════════════════════════════

describe('Multi-Arm Bandit', () => {
    beforeEach(() => cleanupTestState(testUser, 'twitter'));

    it('should record bandit pull', () => {
        loadVRState(testUser, 'twitter'); // Initialize
        recordBanditPull(testUser, 'twitter', 'humor');
        const state = loadVRState(testUser, 'twitter');
        const arm = state.commentBandit.find(a => a.style === 'humor');
        expect(arm!.pulls).toBe(1);
    });

    it('should record bandit reward and update avgReward', () => {
        loadVRState(testUser, 'twitter');
        recordBanditPull(testUser, 'twitter', 'short_value');
        recordBanditReward(testUser, 'twitter', 'short_value', 1);
        const state = loadVRState(testUser, 'twitter');
        const arm = state.commentBandit.find(a => a.style === 'short_value');
        expect(arm!.rewards).toBe(1);
        expect(arm!.avgReward).toBe(0.5); // 1 reward / 2 pulls
    });

    it('should have all 7 comment styles', () => {
        const state = loadVRState(testUser, 'twitter');
        const styles = state.commentBandit.map(a => a.style);
        expect(styles).toContain('short_value');
        expect(styles).toContain('thoughtful_question');
        expect(styles).toContain('humor');
        expect(styles).toContain('contrarian_take');
        expect(styles).toContain('personal_story');
        expect(styles).toContain('encouragement');
        expect(styles).toContain('resource_share');
    });
});

// ═══════════════════════════════════════════════════════════════════════
// VI Delay System
// ═══════════════════════════════════════════════════════════════════════

describe('VI Delay System', () => {
    beforeEach(() => cleanupDelayedQueue_file());

    it('should compute delay within expected range for each stage', () => {
        const stages = ['initial_contact', 'building', 'warm', 'active'];
        for (const stage of stages) {
            const delay = computeReplyDelay('testuser', 'instagram', stage, false);
            expect(delay).toBeGreaterThan(0);
            expect(delay).toBeLessThan(60 * 60 * 1000); // Less than 1 hour
        }
    });

    it('should return delay in milliseconds', () => {
        const delay = computeReplyDelay('testuser', 'twitter', 'building', false);
        expect(typeof delay).toBe('number');
        expect(delay).toBeGreaterThan(1000); // At least 1 second
    });

    it('should sometimes produce fast delay for jackpot', () => {
        const delays: number[] = [];
        for (let i = 0; i < 100; i++) {
            delays.push(computeReplyDelay('testuser', 'instagram', 'acquaintance', true));
        }
        // Acquaintance normal range is 10-45 min, jackpot fast is 0.5-3 min
        // At least some should be fast (below 5 min)
        const fastDelays = delays.filter(d => d < 5 * 60 * 1000);
        expect(fastDelays.length).toBeGreaterThan(0);
    });

    it('should schedule and retrieve delayed reply', () => {
        const sendAfter = new Date(Date.now() - 1000).toISOString(); // Already past
        const id = scheduleDelayedReply({
            username: 'testuser',
            platform: 'instagram',
            replyMessage: 'Hello!',
            sendAfter,
            context: {
                relationship: { category: 'personal', warmth: 50, stage: 'building', notes: [], tags: [] } as any,
                objective: 'test',
                isJackpot: false
            }
        });

        expect(typeof id).toBe('string');
        expect(id.startsWith('delayed_')).toBe(true);

        const ready = getReadyReplies('instagram');
        expect(ready.length).toBe(1);
        expect(ready[0].username).toBe('testuser');
    });

    it('should not return future replies as ready', () => {
        const sendAfter = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour from now
        scheduleDelayedReply({
            username: 'futureuser',
            platform: 'twitter',
            replyMessage: 'Later!',
            sendAfter,
            context: {
                relationship: { category: 'personal', warmth: 30, stage: 'cold_outreach', notes: [], tags: [] } as any,
                objective: 'test',
                isJackpot: false
            }
        });

        const ready = getReadyReplies('twitter');
        expect(ready.length).toBe(0);
    });

    it('should filter by platform', () => {
        const sendAfter = new Date(Date.now() - 1000).toISOString();
        scheduleDelayedReply({
            username: 'iguser',
            platform: 'instagram',
            replyMessage: 'Hi IG!',
            sendAfter,
            context: {
                relationship: { category: 'personal', warmth: 50, stage: 'building', notes: [], tags: [] } as any,
                objective: 'test',
                isJackpot: false
            }
        });
        scheduleDelayedReply({
            username: 'twuser',
            platform: 'twitter',
            replyMessage: 'Hi TW!',
            sendAfter,
            context: {
                relationship: { category: 'personal', warmth: 50, stage: 'building', notes: [], tags: [] } as any,
                objective: 'test',
                isJackpot: false
            }
        });

        const igReady = getReadyReplies('instagram');
        const twReady = getReadyReplies('twitter');
        expect(igReady.length).toBe(1);
        expect(igReady[0].username).toBe('iguser');
        expect(twReady.length).toBe(1);
        expect(twReady[0].username).toBe('twuser');
    });

    it('should mark reply as sent', () => {
        const sendAfter = new Date(Date.now() - 1000).toISOString();
        const id = scheduleDelayedReply({
            username: 'sentuser',
            platform: 'instagram',
            replyMessage: 'Done!',
            sendAfter,
            context: {
                relationship: { category: 'personal', warmth: 50, stage: 'building', notes: [], tags: [] } as any,
                objective: 'test',
                isJackpot: false
            }
        });

        markReplySent(id);
        const ready = getReadyReplies('instagram');
        const found = ready.find(r => r.id === id);
        expect(found).toBeUndefined(); // Sent entries should not appear as ready
    });

    it('should mark reply as failed with error', () => {
        const sendAfter = new Date(Date.now() - 1000).toISOString();
        const id = scheduleDelayedReply({
            username: 'failuser',
            platform: 'twitter',
            replyMessage: 'Oops!',
            sendAfter,
            context: {
                relationship: { category: 'personal', warmth: 50, stage: 'building', notes: [], tags: [] } as any,
                objective: 'test',
                isJackpot: false
            }
        });

        markReplyFailed(id, 'Network error');
        const ready = getReadyReplies('twitter');
        const found = ready.find(r => r.id === id);
        expect(found).toBeUndefined();
    });

    it('should cleanup old entries', () => {
        // This just verifies the function runs without error
        const removed = cleanupDelayedQueue();
        expect(typeof removed).toBe('number');
    });

    it('should detect pending reply for a user (hasPendingReply)', () => {
        const sendAfter = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // future
        scheduleDelayedReply({
            username: 'pendinguser',
            platform: 'instagram',
            replyMessage: 'Pending!',
            sendAfter,
            context: {
                relationship: { category: 'personal', warmth: 50, stage: 'building', notes: [], tags: [] } as any,
                objective: 'test',
                isJackpot: false
            }
        });

        expect(hasPendingReply('pendinguser', 'instagram')).toBe(true);
        expect(hasPendingReply('pendinguser', 'twitter')).toBe(false);
        expect(hasPendingReply('otheruser', 'instagram')).toBe(false);
    });

    it('should not report sent replies as pending', () => {
        const sendAfter = new Date(Date.now() - 1000).toISOString();
        const id = scheduleDelayedReply({
            username: 'doneuser',
            platform: 'twitter',
            replyMessage: 'Done!',
            sendAfter,
            context: {
                relationship: { category: 'personal', warmth: 50, stage: 'building', notes: [], tags: [] } as any,
                objective: 'test',
                isJackpot: false
            }
        });

        expect(hasPendingReply('doneuser', 'twitter')).toBe(true);
        markReplySent(id);
        expect(hasPendingReply('doneuser', 'twitter')).toBe(false);
    });

    it('should be case-insensitive for username', () => {
        const sendAfter = new Date(Date.now() + 60000).toISOString();
        scheduleDelayedReply({
            username: 'CaseMixUser',
            platform: 'instagram',
            replyMessage: 'Hi!',
            sendAfter,
            context: {
                relationship: { category: 'personal', warmth: 50, stage: 'building', notes: [], tags: [] } as any,
                objective: 'test',
                isJackpot: false
            }
        });

        expect(hasPendingReply('casemixuser', 'instagram')).toBe(true);
        expect(hasPendingReply('CASEMIXUSER', 'instagram')).toBe(true);
    });
});

// ═══════════════════════════════════════════════════════════════════════
// VR Stats
// ═══════════════════════════════════════════════════════════════════════

describe('VR Stats', () => {
    it('should return stats object with correct shape', () => {
        const stats = getVRStats('twitter');
        expect(stats).toHaveProperty('totalContacts');
        expect(stats).toHaveProperty('activeContacts');
        expect(stats).toHaveProperty('pausedContacts');
        expect(stats).toHaveProperty('avgHealth');
        expect(stats).toHaveProperty('totalComments');
        expect(stats).toHaveProperty('totalRepliesReceived');
        expect(stats).toHaveProperty('bestArms');
        expect(Array.isArray(stats.bestArms)).toBe(true);
    });

    it('should return stats for all platforms when no filter', () => {
        const stats = getVRStats();
        expect(typeof stats.totalContacts).toBe('number');
    });
});

// ═══════════════════════════════════════════════════════════════════════
// Contacts Ready for Engagement
// ═══════════════════════════════════════════════════════════════════════

describe('Contacts Ready for Engagement', () => {
    beforeEach(() => cleanupTestState(testUser2, 'twitter'));

    it('should return array of contacts near threshold', () => {
        const state = loadVRState(testUser2, 'twitter');
        state.counter = 8;
        state.nextThreshold = 10; // 80% ratio
        saveVRState(state);

        const ready = getContactsReadyForEngagement('twitter', 10);
        const found = ready.find(r => r.username === testUser2.toLowerCase());
        expect(found).toBeDefined();
        expect(found!.counter).toBe(8);
        expect(found!.threshold).toBe(10);
    });

    it('should exclude paused contacts', () => {
        const state = loadVRState(testUser2, 'twitter');
        state.counter = 9;
        state.nextThreshold = 10;
        state.pausedUntil = new Date(Date.now() + 60 * 60 * 1000).toISOString();
        saveVRState(state);

        const ready = getContactsReadyForEngagement('twitter', 10);
        const found = ready.find(r => r.username === testUser2.toLowerCase());
        expect(found).toBeUndefined();
    });

    it('should exclude low-health contacts', () => {
        const state = loadVRState(testUser2, 'twitter');
        state.counter = 9;
        state.nextThreshold = 10;
        state.health = 0.3; // Below floor
        saveVRState(state);

        const ready = getContactsReadyForEngagement('twitter', 10);
        const found = ready.find(r => r.username === testUser2.toLowerCase());
        expect(found).toBeUndefined();
    });
});
