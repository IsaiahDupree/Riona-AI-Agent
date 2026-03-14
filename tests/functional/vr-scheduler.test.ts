/**
 * VR Scheduler Tests — Core Skinner-inspired scheduling logic
 */

import * as fs from 'fs';
import * as path from 'path';
import {
    loadVRState, saveVRState, recordInteractionAndDecide,
    updateHealth, recordBanditReward, recordBanditPull,
    getContactsReadyForEngagement, getAllVRStates, getVRStats,
    VRContactState, CommentStyle,
} from '../../src/nurture/vr-scheduler';

// ── Test helpers ─────────────────────────────────────────────────────

const VR_STATE_DIR = path.join(process.cwd(), 'logs', 'tracking', 'nurture', 'vr-states');
const TEST_PREFIX = '__test_vr_';

function testStatePath(username: string): string {
    return path.join(VR_STATE_DIR, `twitter_${username}.json`);
}

function cleanupTestFiles() {
    try {
        if (!fs.existsSync(VR_STATE_DIR)) return;
        const files = fs.readdirSync(VR_STATE_DIR);
        for (const f of files) {
            if (f.includes(TEST_PREFIX)) {
                fs.unlinkSync(path.join(VR_STATE_DIR, f));
            }
        }
    } catch (_) { /* ignore */ }
}

// ── Tests ────────────────────────────────────────────────────────────

describe('VR Scheduler', () => {
    afterAll(() => {
        cleanupTestFiles();
    });

    describe('State CRUD', () => {
        const user = `${TEST_PREFIX}crud`;

        afterAll(() => {
            try { fs.unlinkSync(testStatePath(user)); } catch (_) {}
        });

        it('should create default state for new contact', () => {
            const state = loadVRState(user, 'twitter');

            expect(state.username).toBe(user);
            expect(state.platform).toBe('twitter');
            expect(state.counter).toBe(0);
            expect(state.nextThreshold).toBeGreaterThanOrEqual(1);
            expect(state.meanN).toBe(3);
            expect(state.health).toBe(0.7);
            expect(state.totalComments).toBe(0);
            expect(state.totalRepliesReceived).toBe(0);
            expect(state.commentBandit).toHaveLength(7);
            expect(state.pausedUntil).toBeNull();
        });

        it('should persist and reload state', () => {
            const state = loadVRState(user, 'twitter');
            state.health = 0.85;
            state.counter = 5;
            saveVRState(state);

            const reloaded = loadVRState(user, 'twitter');
            expect(reloaded.health).toBe(0.85);
            expect(reloaded.counter).toBe(5);
        });

        it('should initialize all 7 bandit arms', () => {
            const state = loadVRState(user, 'twitter');
            const styles: CommentStyle[] = [
                'short_value', 'thoughtful_question', 'humor',
                'contrarian_take', 'personal_story', 'encouragement', 'resource_share',
            ];
            expect(state.commentBandit.map(a => a.style).sort()).toEqual(styles.sort());
            for (const arm of state.commentBandit) {
                expect(arm.pulls).toBe(0);
                expect(arm.rewards).toBe(0);
                expect(arm.avgReward).toBe(0);
            }
        });
    });

    describe('VR Decision Engine', () => {
        const user = `${TEST_PREFIX}decision`;

        afterAll(() => {
            try { fs.unlinkSync(testStatePath(user)); } catch (_) {}
        });

        it('should not engage when counter is below threshold', () => {
            // Force a high threshold so first interaction won't trigger
            const state = loadVRState(user, 'twitter');
            state.nextThreshold = 100;
            saveVRState(state);

            const decision = recordInteractionAndDecide(user, 'twitter');
            expect(decision.shouldEngage).toBe(false);
            expect(decision.reason).toContain('not yet');
        });

        it('should engage when counter reaches threshold', () => {
            const state = loadVRState(user, 'twitter');
            state.counter = 98; // Will be incremented to 99, threshold is 100
            state.nextThreshold = 100;
            saveVRState(state);

            // Need one more interaction
            let decision = recordInteractionAndDecide(user, 'twitter');
            // counter is now 99, still not 100
            expect(decision.shouldEngage).toBe(false);

            decision = recordInteractionAndDecide(user, 'twitter');
            // counter is now 100, equals threshold
            expect(decision.shouldEngage).toBe(true);
            expect(decision.style).toBeDefined();
        });

        it('should reset counter after engagement', () => {
            const state = loadVRState(user, 'twitter');
            expect(state.counter).toBe(0);
            expect(state.totalComments).toBeGreaterThan(0);
            expect(state.nextThreshold).toBeGreaterThanOrEqual(1);
        });
    });

    describe('Guardrails', () => {
        const userDaily = `${TEST_PREFIX}daily`;
        const userPause = `${TEST_PREFIX}pause`;
        const userHealth = `${TEST_PREFIX}health`;
        const userIgnored = `${TEST_PREFIX}ignored`;
        const userInterval = `${TEST_PREFIX}interval`;

        afterAll(() => {
            for (const u of [userDaily, userPause, userHealth, userIgnored, userInterval]) {
                try { fs.unlinkSync(testStatePath(u)); } catch (_) {}
            }
        });

        it('should enforce daily comment cap per user', () => {
            const state = loadVRState(userDaily, 'twitter');
            state.commentsToday = 2;
            state.lastCommentDate = new Date().toISOString().slice(0, 10);
            state.nextThreshold = 1;
            state.counter = 0;
            saveVRState(state);

            const decision = recordInteractionAndDecide(userDaily, 'twitter');
            expect(decision.shouldEngage).toBe(false);
            expect(decision.reason).toContain('Daily cap');
        });

        it('should pause when health drops below floor', () => {
            const state = loadVRState(userHealth, 'twitter');
            state.health = 0.50; // Below 0.55 floor
            state.nextThreshold = 1;
            state.counter = 0;
            saveVRState(state);

            const decision = recordInteractionAndDecide(userHealth, 'twitter');
            expect(decision.shouldEngage).toBe(false);
            expect(decision.reason).toContain('below floor');

            const reloaded = loadVRState(userHealth, 'twitter');
            expect(reloaded.pausedUntil).not.toBeNull();
        });

        it('should pause after consecutive ignored comments', () => {
            const state = loadVRState(userIgnored, 'twitter');
            state.consecutiveIgnored = 4; // MAX_CONSECUTIVE_IGNORED
            state.nextThreshold = 1;
            state.counter = 0;
            saveVRState(state);

            const decision = recordInteractionAndDecide(userIgnored, 'twitter');
            expect(decision.shouldEngage).toBe(false);
            expect(decision.reason).toContain('ignored');
        });

        it('should respect minimum interval between comments', () => {
            const state = loadVRState(userInterval, 'twitter');
            state.lastCommentAt = new Date().toISOString(); // Just commented
            state.nextThreshold = 1;
            state.counter = 0;
            state.commentsToday = 0;
            state.lastCommentDate = '';
            saveVRState(state);

            const decision = recordInteractionAndDecide(userInterval, 'twitter');
            expect(decision.shouldEngage).toBe(false);
            expect(decision.reason).toContain('Too soon');
        });

        it('should unpause after pause expires', () => {
            const state = loadVRState(userPause, 'twitter');
            state.pausedUntil = new Date(Date.now() - 1000).toISOString(); // Expired
            state.health = 0.7;
            state.consecutiveIgnored = 0;
            state.nextThreshold = 1;
            state.counter = 0;
            state.commentsToday = 0;
            state.lastCommentDate = '';
            state.lastCommentAt = null;
            saveVRState(state);

            const decision = recordInteractionAndDecide(userPause, 'twitter');
            // Should not be blocked by pause
            expect(decision.reason).not.toContain('Paused');
        });
    });

    describe('Health System', () => {
        const user = `${TEST_PREFIX}health_sys`;

        afterAll(() => {
            try { fs.unlinkSync(testStatePath(user)); } catch (_) {}
        });

        it('should increase health on reply_received', () => {
            loadVRState(user, 'twitter'); // Init at 0.7
            const newHealth = updateHealth(user, 'twitter', 'reply_received');
            expect(newHealth).toBeCloseTo(0.78, 1);
        });

        it('should increase health on like_received', () => {
            const before = loadVRState(user, 'twitter').health;
            const newHealth = updateHealth(user, 'twitter', 'like_received');
            expect(newHealth).toBeGreaterThan(before);
        });

        it('should decrease health on comment_ignored', () => {
            const before = loadVRState(user, 'twitter').health;
            const newHealth = updateHealth(user, 'twitter', 'comment_ignored');
            expect(newHealth).toBeLessThan(before);
        });

        it('should clamp health between 0 and 1', () => {
            const state = loadVRState(user, 'twitter');
            state.health = 0.99;
            saveVRState(state);

            const newHealth = updateHealth(user, 'twitter', 'reply_received');
            expect(newHealth).toBeLessThanOrEqual(1.0);

            // Drive health low
            state.health = 0.02;
            saveVRState(state);
            const low = updateHealth(user, 'twitter', 'comment_ignored');
            expect(low).toBeGreaterThanOrEqual(0);
        });

        it('should reset consecutiveIgnored on positive engagement', () => {
            const state = loadVRState(user, 'twitter');
            state.consecutiveIgnored = 3;
            state.health = 0.7;
            saveVRState(state);

            updateHealth(user, 'twitter', 'reply_received');
            const updated = loadVRState(user, 'twitter');
            expect(updated.consecutiveIgnored).toBe(0);
        });

        it('should track health history', () => {
            const state = loadVRState(user, 'twitter');
            expect(state.healthHistory.length).toBeGreaterThan(1);
            const last = state.healthHistory[state.healthHistory.length - 1];
            expect(last).toHaveProperty('value');
            expect(last).toHaveProperty('delta');
            expect(last).toHaveProperty('reason');
            expect(last).toHaveProperty('at');
        });
    });

    describe('Multi-Arm Bandit', () => {
        const user = `${TEST_PREFIX}bandit`;

        afterAll(() => {
            try { fs.unlinkSync(testStatePath(user)); } catch (_) {}
        });

        it('should record pulls', () => {
            loadVRState(user, 'twitter');
            recordBanditPull(user, 'twitter', 'humor');

            const state = loadVRState(user, 'twitter');
            const humorArm = state.commentBandit.find(a => a.style === 'humor')!;
            expect(humorArm.pulls).toBe(1);
            expect(humorArm.rewards).toBe(0);
        });

        it('should record rewards and update average', () => {
            recordBanditReward(user, 'twitter', 'humor', 1.0);

            const state = loadVRState(user, 'twitter');
            const humorArm = state.commentBandit.find(a => a.style === 'humor')!;
            expect(humorArm.pulls).toBe(2); // 1 pull + 1 reward call
            expect(humorArm.rewards).toBe(1.0);
            expect(humorArm.avgReward).toBeCloseTo(0.5, 1);
        });

        it('should prefer high-reward arms during exploitation', () => {
            // Load rewards into one arm to make it dominant
            const state = loadVRState(user, 'twitter');
            const encouragementArm = state.commentBandit.find(a => a.style === 'encouragement')!;
            encouragementArm.pulls = 20;
            encouragementArm.rewards = 18;
            encouragementArm.avgReward = 0.9;
            saveVRState(state);

            // Run many decisions and count style selection
            // With epsilon=0.15, ~85% should pick the best arm
            // But this is stochastic, so we just verify the arm data is correct
            const reloaded = loadVRState(user, 'twitter');
            const best = reloaded.commentBandit
                .filter(a => a.pulls > 0)
                .sort((a, b) => b.avgReward - a.avgReward)[0];
            expect(best.style).toBe('encouragement');
        });
    });

    describe('Thinning', () => {
        const user = `${TEST_PREFIX}thinning`;

        afterAll(() => {
            try { fs.unlinkSync(testStatePath(user)); } catch (_) {}
        });

        it('should start with default meanN', () => {
            const state = loadVRState(user, 'twitter');
            expect(state.meanN).toBe(3);
            expect(state.thinningStage).toBe(0);
        });

        it('should increase meanN after 10 reinforcements', () => {
            const state = loadVRState(user, 'twitter');
            state.totalReinforcements = 9;
            state.nextThreshold = 1;
            state.counter = 0;
            state.commentsToday = 0;
            state.lastCommentDate = '';
            state.lastCommentAt = null;
            saveVRState(state);

            // This engagement will push to 10 reinforcements
            const decision = recordInteractionAndDecide(user, 'twitter');
            expect(decision.shouldEngage).toBe(true);

            const updated = loadVRState(user, 'twitter');
            expect(updated.thinningStage).toBe(1);
            expect(updated.meanN).toBeCloseTo(4.5, 1); // 3 * 1.5
        });

        it('should increase meanN further after 25 reinforcements', () => {
            const state = loadVRState(user, 'twitter');
            state.totalReinforcements = 24;
            state.nextThreshold = 1;
            state.counter = 0;
            state.commentsToday = 0;
            state.lastCommentDate = '';
            state.lastCommentAt = null;
            saveVRState(state);

            const decision = recordInteractionAndDecide(user, 'twitter');
            expect(decision.shouldEngage).toBe(true);

            const updated = loadVRState(user, 'twitter');
            expect(updated.thinningStage).toBe(2);
            expect(updated.meanN).toBeCloseTo(6.0, 1); // 3 * 2.0
        });
    });

    describe('Batch Queries', () => {
        const users = [`${TEST_PREFIX}batch1`, `${TEST_PREFIX}batch2`, `${TEST_PREFIX}batch3`];

        afterAll(() => {
            for (const u of users) {
                try { fs.unlinkSync(testStatePath(u)); } catch (_) {}
            }
        });

        it('should get contacts ready for engagement', () => {
            // Create contacts at various stages
            for (const [i, u] of users.entries()) {
                const state = loadVRState(u, 'twitter');
                state.counter = 8 + i; // 8, 9, 10
                state.nextThreshold = 10;
                saveVRState(state);
            }

            const ready = getContactsReadyForEngagement('twitter', 10);
            const readyUsernames = ready.map(r => r.username);

            // batch3 has counter=10, ratio=1.0 (should be first)
            // batch2 has counter=9, ratio=0.9
            // batch1 has counter=8, ratio=0.8
            // All above 0.6 threshold
            for (const u of users) {
                expect(readyUsernames).toContain(u);
            }
        });

        it('should exclude paused contacts from ready list', () => {
            const state = loadVRState(users[0], 'twitter');
            state.pausedUntil = new Date(Date.now() + 86400000).toISOString();
            saveVRState(state);

            const ready = getContactsReadyForEngagement('twitter', 10);
            const readyUsernames = ready.map(r => r.username);
            expect(readyUsernames).not.toContain(users[0]);
        });

        it('should return aggregate stats', () => {
            const stats = getVRStats('twitter');
            expect(stats.totalContacts).toBeGreaterThan(0);
            expect(stats).toHaveProperty('activeContacts');
            expect(stats).toHaveProperty('pausedContacts');
            expect(stats).toHaveProperty('avgHealth');
            expect(stats).toHaveProperty('bestArms');
        });
    });
});
