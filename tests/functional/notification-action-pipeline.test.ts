/**
 * Notification Action Pipeline Tests
 *
 * End-to-end tests verifying the full flow:
 *   Badge data → Action prioritization → Notification processing →
 *   Health updates → Reply actioning → DM inbox triggering
 *
 * Tests cover:
 * 1. Badge reader returns structured data and triggers correct actions
 * 2. Actions from badges map to executable handlers
 * 3. Notification detection feeds VR health system
 * 4. Unactioned replies are surfaced and actionable
 * 5. DM badge counts trigger inbox scraping decisions
 * 6. Multi-platform action orchestration respects priority ordering
 * 7. Badge trends detect escalation (growing unread counts)
 * 8. Ignored comment penalties apply correctly after timeout
 * 9. Full cycle: badge → action → notification → health → bandit reward
 */

import {
    getActionsFromBadges, getLatestBadgeSnapshot, getBadgeTrend,
    BadgeSnapshot, PlatformBadges, BadgeAction,
} from '../../src/client/NotificationBadgeReader';

import {
    getUnactionedReplies, markNotificationActioned,
    getNotificationStats, processIgnoredComments,
    DetectedNotification, NotificationType,
} from '../../src/client/Twitter-Notifications';

import {
    loadVRState, saveVRState, updateHealth,
    recordBanditPull, recordBanditReward,
    recordInteractionAndDecide, getContactsReadyForEngagement,
    VRContactState, CommentStyle,
} from '../../src/nurture/vr-scheduler';

import {
    loadNurtureProfile, saveNurtureProfile, profileExists,
} from '../../src/nurture/store';

import * as fs from 'fs';
import * as path from 'path';

// ── Test helpers ────────────────────────────────────────────────────

function makeBadges(platform: 'twitter' | 'instagram' | 'threads', dms: number, notifs: number): PlatformBadges {
    return {
        platform,
        dms,
        notifications: notifs,
        rawDms: String(dms),
        rawNotifications: String(notifs),
        readAt: new Date().toISOString(),
    };
}

function makeSnapshot(twitter: PlatformBadges, instagram: PlatformBadges, threads: PlatformBadges): BadgeSnapshot {
    return { twitter, instagram, threads, snapshotAt: new Date().toISOString() };
}

const NOTIF_DIR = path.join(process.cwd(), 'logs', 'tracking', 'twitter', 'notifications');
const NOTIF_FILE = path.join(NOTIF_DIR, 'detected.json');
const VR_DIR = path.join(process.cwd(), 'logs', 'tracking', 'nurture', 'vr-states');
const BADGE_HISTORY_FILE = path.join(process.cwd(), 'logs', 'tracking', 'badge_snapshots.json');

function seedNotification(overrides: Partial<DetectedNotification> = {}): DetectedNotification {
    return {
        type: 'reply',
        fromUsername: 'test_replier',
        text: 'test_replier replied to your tweet: great insight!',
        ourTweetUrl: 'https://x.com/me/status/123',
        theirTweetUrl: 'https://x.com/test_replier/status/456',
        detectedAt: new Date().toISOString(),
        actioned: false,
        ...overrides,
    };
}

function seedNotifications(notifs: DetectedNotification[]) {
    if (!fs.existsSync(NOTIF_DIR)) fs.mkdirSync(NOTIF_DIR, { recursive: true });
    fs.writeFileSync(NOTIF_FILE, JSON.stringify(notifs), 'utf8');
}

function seedBadgeHistory(snapshots: BadgeSnapshot[]) {
    const dir = path.dirname(BADGE_HISTORY_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(BADGE_HISTORY_FILE, JSON.stringify(snapshots), 'utf8');
}

function cleanupTestVRState(username: string, platform: string) {
    const file = path.join(VR_DIR, `${platform}_${username}.json`);
    if (fs.existsSync(file)) fs.unlinkSync(file);
}

// ── Tests ───────────────────────────────────────────────────────────

describe('Notification Action Pipeline', () => {

    // ── 1. Badge → Action mapping ───────────────────────────────────

    describe('Badge-to-Action mapping', () => {
        it('should map Twitter DM badges to scrape_inbox_and_reply action', () => {
            const snapshot = makeSnapshot(
                makeBadges('twitter', 14, 0),
                makeBadges('instagram', 0, 0),
                makeBadges('threads', 0, 0),
            );
            const actions = getActionsFromBadges(snapshot);
            expect(actions).toHaveLength(1);
            expect(actions[0]).toMatchObject({
                platform: 'twitter',
                type: 'dm',
                count: 14,
                action: 'scrape_inbox_and_reply',
                priority: 'high',
            });
        });

        it('should map Instagram DM badges to scrape_ig_inbox_and_reply action', () => {
            const snapshot = makeSnapshot(
                makeBadges('twitter', 0, 0),
                makeBadges('instagram', 9, 0),
                makeBadges('threads', 0, 0),
            );
            const actions = getActionsFromBadges(snapshot);
            expect(actions).toHaveLength(1);
            expect(actions[0]).toMatchObject({
                platform: 'instagram',
                type: 'dm',
                count: 9,
                action: 'scrape_ig_inbox_and_reply',
                priority: 'high',
            });
        });

        it('should map Twitter notification badges to check_notifications action', () => {
            const snapshot = makeSnapshot(
                makeBadges('twitter', 0, 7),
                makeBadges('instagram', 0, 0),
                makeBadges('threads', 0, 0),
            );
            const actions = getActionsFromBadges(snapshot);
            expect(actions).toHaveLength(1);
            expect(actions[0]).toMatchObject({
                platform: 'twitter',
                type: 'notification',
                action: 'check_notifications',
                priority: 'medium',
            });
        });

        it('should map Threads notification badges to check_threads_notifications', () => {
            const snapshot = makeSnapshot(
                makeBadges('twitter', 0, 0),
                makeBadges('instagram', 0, 0),
                makeBadges('threads', 0, 5),
            );
            const actions = getActionsFromBadges(snapshot);
            expect(actions).toHaveLength(1);
            expect(actions[0]).toMatchObject({
                platform: 'threads',
                type: 'notification',
                action: 'check_threads_notifications',
                priority: 'low',
            });
        });
    });

    // ── 2. Action priority orchestration ────────────────────────────

    describe('Multi-platform action orchestration', () => {
        it('should process DMs before notifications across all platforms', () => {
            const snapshot = makeSnapshot(
                makeBadges('twitter', 5, 10),
                makeBadges('instagram', 3, 8),
                makeBadges('threads', 0, 4),
            );
            const actions = getActionsFromBadges(snapshot);

            // First two should be high-priority DMs
            expect(actions[0].priority).toBe('high');
            expect(actions[1].priority).toBe('high');
            expect(actions[0].type).toBe('dm');
            expect(actions[1].type).toBe('dm');

            // Twitter DMs (5) > Instagram DMs (3) by count
            expect(actions[0].platform).toBe('twitter');
            expect(actions[1].platform).toBe('instagram');

            // Then medium notifications
            const mediumActions = actions.filter(a => a.priority === 'medium');
            expect(mediumActions).toHaveLength(2);

            // Low last
            const lowActions = actions.filter(a => a.priority === 'low');
            expect(lowActions).toHaveLength(1);
            expect(lowActions[0].platform).toBe('threads');
        });

        it('should return actions executable as a prioritized queue', () => {
            const snapshot = makeSnapshot(
                makeBadges('twitter', 14, 3),
                makeBadges('instagram', 9, 2),
                makeBadges('threads', 0, 1),
            );
            const actions = getActionsFromBadges(snapshot);

            // Verify queue is properly ordered for sequential execution
            const actionNames = actions.map(a => a.action);
            expect(actionNames).toEqual([
                'scrape_inbox_and_reply',      // Twitter DMs (14) - high
                'scrape_ig_inbox_and_reply',    // IG DMs (9) - high
                'check_notifications',          // Twitter notifs (3) - medium
                'check_ig_notifications',       // IG notifs (2) - medium
                'check_threads_notifications',  // Threads notifs (1) - low
            ]);
        });

        it('should support filtering actions by priority for batch processing', () => {
            const snapshot = makeSnapshot(
                makeBadges('twitter', 5, 2),
                makeBadges('instagram', 3, 0),
                makeBadges('threads', 0, 1),
            );
            const actions = getActionsFromBadges(snapshot);

            // A scheduler might only process high-priority actions when short on time
            const urgentActions = actions.filter(a => a.priority === 'high');
            expect(urgentActions).toHaveLength(2);
            expect(urgentActions.every(a => a.type === 'dm')).toBe(true);

            // Or process medium+ in a normal run
            const normalActions = actions.filter(a => a.priority !== 'low');
            expect(normalActions).toHaveLength(3);
        });
    });

    // ── 3. Notification → VR health integration ─────────────────────

    describe('Notification to VR health updates', () => {
        const testUser = '__test_notif_health';

        beforeAll(() => {
            // Seed a VR state for the test user
            const state = loadVRState(testUser, 'twitter');
            state.health = 0.60;
            saveVRState(state);

            // Seed a nurture profile
            const profile = loadNurtureProfile(testUser, 'twitter');
            profile.tier = 'acquaintance';
            saveNurtureProfile(profile);
        });

        afterAll(() => {
            cleanupTestVRState(testUser, 'twitter');
            const profilePath = path.join(process.cwd(), 'logs', 'tracking', 'nurture', 'profiles', `twitter_${testUser}.json`);
            if (fs.existsSync(profilePath)) fs.unlinkSync(profilePath);
        });

        it('should increase health when contact replies to our comment', () => {
            // Reset to known value to avoid accumulated state
            const state = loadVRState(testUser, 'twitter');
            state.health = 0.60;
            state.healthHistory = [];
            saveVRState(state);

            updateHealth(testUser, 'twitter', 'reply_received');

            const after = loadVRState(testUser, 'twitter');
            expect(after.health).toBeGreaterThan(0.60);
            expect(after.consecutiveIgnored).toBe(0); // Reset on positive engagement
        });

        it('should increase health when contact likes our content', () => {
            const state = loadVRState(testUser, 'twitter');
            state.health = 0.60;
            state.healthHistory = [];
            saveVRState(state);

            updateHealth(testUser, 'twitter', 'like_received');

            const after = loadVRState(testUser, 'twitter');
            expect(after.health).toBeGreaterThan(0.60);
        });

        it('should increase health when they engage our content (RT/quote)', () => {
            const state = loadVRState(testUser, 'twitter');
            state.health = 0.60;
            state.healthHistory = [];
            saveVRState(state);

            updateHealth(testUser, 'twitter', 'they_engaged_our_content');

            const after = loadVRState(testUser, 'twitter');
            expect(after.health).toBeGreaterThan(0.60);
        });

        it('should decrease health on comment_ignored', () => {
            // Reset health to a known value
            const state = loadVRState(testUser, 'twitter');
            state.health = 0.70;
            saveVRState(state);

            updateHealth(testUser, 'twitter', 'comment_ignored');

            const after = loadVRState(testUser, 'twitter');
            expect(after.health).toBeLessThan(0.70);
            expect(after.consecutiveIgnored).toBeGreaterThan(0);
        });

        it('should record health history for trend analysis', () => {
            const state = loadVRState(testUser, 'twitter');
            expect(state.healthHistory.length).toBeGreaterThan(0);

            const lastEntry = state.healthHistory[state.healthHistory.length - 1];
            expect(lastEntry).toHaveProperty('value');
            expect(lastEntry).toHaveProperty('reason');
            expect(lastEntry).toHaveProperty('at');
        });
    });

    // ── 4. Unactioned replies surfacing + actioning ─────────────────

    describe('Unactioned reply detection and actioning', () => {
        const testNotifs: DetectedNotification[] = [
            seedNotification({ fromUsername: 'replier_1', type: 'reply', actioned: false }),
            seedNotification({ fromUsername: 'replier_2', type: 'mention', actioned: false }),
            seedNotification({ fromUsername: 'liker_1', type: 'like', actioned: false }),
            seedNotification({ fromUsername: 'replier_3', type: 'reply', actioned: true, actionType: 'replied' }),
            seedNotification({ fromUsername: 'quoter_1', type: 'quote', actioned: false }),
        ];

        beforeAll(() => {
            seedNotifications(testNotifs);
        });

        it('should return only unactioned reply/mention notifications', () => {
            const unactioned = getUnactionedReplies();
            // reply from replier_1 + mention from replier_2 (not: like, not: already actioned, not: quote)
            expect(unactioned).toHaveLength(2);
            expect(unactioned.map(n => n.fromUsername).sort()).toEqual(['replier_1', 'replier_2']);
        });

        it('should not include likes or retweets in unactioned replies', () => {
            const unactioned = getUnactionedReplies();
            expect(unactioned.every(n => n.type === 'reply' || n.type === 'mention')).toBe(true);
        });

        it('should not include already-actioned notifications', () => {
            const unactioned = getUnactionedReplies();
            expect(unactioned.every(n => !n.actioned)).toBe(true);
            expect(unactioned.find(n => n.fromUsername === 'replier_3')).toBeUndefined();
        });

        it('should mark notification as actioned with reply', () => {
            markNotificationActioned('replier_1', 'reply', 'replied', 'Thanks for the feedback!');
            const unactioned = getUnactionedReplies();
            expect(unactioned.find(n => n.fromUsername === 'replier_1')).toBeUndefined();
        });

        it('should mark notification as actioned with like', () => {
            markNotificationActioned('replier_2', 'mention', 'liked');
            const unactioned = getUnactionedReplies();
            expect(unactioned).toHaveLength(0);
        });

        it('should track action type and text when actioned', () => {
            // Re-read the stored notifications
            const allNotifs: DetectedNotification[] = JSON.parse(fs.readFileSync(NOTIF_FILE, 'utf8'));
            const replier1 = allNotifs.find(n => n.fromUsername === 'replier_1' && n.actioned);
            expect(replier1).toBeDefined();
            expect(replier1!.actionType).toBe('replied');
            expect(replier1!.actionText).toBe('Thanks for the feedback!');
            expect(replier1!.actionedAt).toBeTruthy();
        });
    });

    // ── 5. Notification stats ───────────────────────────────────────

    describe('Notification statistics', () => {
        it('should return correct stats breakdown', () => {
            const stats = getNotificationStats();
            expect(stats.total).toBeGreaterThan(0);
            expect(stats.byType).toHaveProperty('reply');
            expect(stats.byType).toHaveProperty('mention');
            expect(stats.byType).toHaveProperty('like');
            expect(stats.byType).toHaveProperty('retweet');
            expect(stats.byType).toHaveProperty('quote');
        });

        it('should count unactioned correctly after actioning', () => {
            const stats = getNotificationStats();
            // We actioned replier_1 (reply) and replier_2 (mention) above
            expect(stats.unactioned).toBe(0);
        });
    });

    // ── 6. DM badge → inbox scraping decision ───────────────────────

    describe('DM badge triggers inbox scraping', () => {
        it('should trigger Twitter inbox scrape when DM count > 0', () => {
            const snapshot = makeSnapshot(
                makeBadges('twitter', 1, 0),
                makeBadges('instagram', 0, 0),
                makeBadges('threads', 0, 0),
            );
            const actions = getActionsFromBadges(snapshot);
            const dmAction = actions.find(a => a.platform === 'twitter' && a.type === 'dm');
            expect(dmAction).toBeDefined();
            expect(dmAction!.action).toBe('scrape_inbox_and_reply');
        });

        it('should trigger Instagram inbox scrape when DM count > 0', () => {
            const snapshot = makeSnapshot(
                makeBadges('twitter', 0, 0),
                makeBadges('instagram', 1, 0),
                makeBadges('threads', 0, 0),
            );
            const actions = getActionsFromBadges(snapshot);
            const dmAction = actions.find(a => a.platform === 'instagram' && a.type === 'dm');
            expect(dmAction).toBeDefined();
            expect(dmAction!.action).toBe('scrape_ig_inbox_and_reply');
        });

        it('should not trigger inbox scrape when DM count is 0', () => {
            const snapshot = makeSnapshot(
                makeBadges('twitter', 0, 5),
                makeBadges('instagram', 0, 3),
                makeBadges('threads', 0, 2),
            );
            const actions = getActionsFromBadges(snapshot);
            expect(actions.every(a => a.type === 'notification')).toBe(true);
        });

        it('should include DM count for batch size decisions', () => {
            const snapshot = makeSnapshot(
                makeBadges('twitter', 25, 0),
                makeBadges('instagram', 0, 0),
                makeBadges('threads', 0, 0),
            );
            const actions = getActionsFromBadges(snapshot);
            // Scheduler can use count to decide batch size
            expect(actions[0].count).toBe(25);
            // e.g., if count > 10, increase scrape depth
        });
    });

    // ── 7. Badge trend detection ────────────────────────────────────

    describe('Badge trend analysis', () => {
        beforeAll(() => {
            // Seed escalating badge history
            const snapshots: BadgeSnapshot[] = [];
            for (let i = 0; i < 5; i++) {
                snapshots.push(makeSnapshot(
                    makeBadges('twitter', i * 3, i * 2),    // Growing DMs
                    makeBadges('instagram', 5 - i, i),      // Shrinking DMs, growing notifs
                    makeBadges('threads', 0, 1),             // Stable
                ));
            }
            seedBadgeHistory(snapshots);
        });

        it('should detect escalating Twitter DMs (trend up)', () => {
            const trend = getBadgeTrend('twitter', 'dm');
            expect(trend.direction).toBe('up');
            expect(trend.current).toBeGreaterThan(trend.previous);
        });

        it('should detect decreasing Instagram DMs (trend down)', () => {
            const trend = getBadgeTrend('instagram', 'dm');
            expect(trend.direction).toBe('down');
            expect(trend.current).toBeLessThan(trend.previous);
        });

        it('should detect stable Threads notifications', () => {
            const trend = getBadgeTrend('threads', 'notification');
            expect(trend.direction).toBe('stable');
        });

        it('should detect growing Twitter notifications', () => {
            const trend = getBadgeTrend('twitter', 'notification');
            expect(trend.direction).toBe('up');
        });

        it('should return latest snapshot', () => {
            const latest = getLatestBadgeSnapshot();
            expect(latest).not.toBeNull();
            expect(latest!.twitter.dms).toBe(12); // Last entry: 4*3 = 12
            expect(latest!.instagram.dms).toBe(1);  // Last entry: 5-4 = 1
        });
    });

    // ── 8. Bandit reward from notification replies ──────────────────

    describe('Bandit reward from notification engagement', () => {
        const testUser = '__test_bandit_reward';

        beforeAll(() => {
            const state = loadVRState(testUser, 'twitter');
            state.health = 0.70;
            saveVRState(state);
        });

        afterAll(() => {
            cleanupTestVRState(testUser, 'twitter');
        });

        it('should reward bandit arm when contact replies after our comment', () => {
            // 1. Verify arm starts at 0 pulls and 0 reward
            const before = loadVRState(testUser, 'twitter');
            const humorBefore = before.commentBandit.find(a => a.style === 'humor')!;
            expect(humorBefore.pulls).toBe(0);
            expect(humorBefore.rewards).toBe(0);

            // 2. Contact replied → reward the arm (recordBanditReward counts as a pull + reward)
            recordBanditReward(testUser, 'twitter', 'humor', 1.0);

            // 3. Verify arm updated
            const after = loadVRState(testUser, 'twitter');
            const humorAfter = after.commentBandit.find(a => a.style === 'humor')!;
            expect(humorAfter.pulls).toBe(1);
            expect(humorAfter.rewards).toBe(1.0);
            expect(humorAfter.avgReward).toBeCloseTo(1.0);
        });

        it('should prefer rewarded arm in future selections', () => {
            // Pull humor many times with reward
            for (let i = 0; i < 10; i++) {
                recordBanditPull(testUser, 'twitter', 'humor');
                recordBanditReward(testUser, 'twitter', 'humor', 1.0);
            }

            // Pull short_value with no rewards
            for (let i = 0; i < 10; i++) {
                recordBanditPull(testUser, 'twitter', 'short_value');
                recordBanditReward(testUser, 'twitter', 'short_value', 0.0);
            }

            const state = loadVRState(testUser, 'twitter');
            const humor = state.commentBandit.find(a => a.style === 'humor')!;
            const shortValue = state.commentBandit.find(a => a.style === 'short_value')!;

            expect(humor.avgReward).toBeGreaterThan(shortValue.avgReward);
        });
    });

    // ── 9. Full cycle: badge → VR decision → health feedback ────────

    describe('Full notification-to-action cycle', () => {
        const testUser = '__test_full_cycle';

        beforeAll(() => {
            // Setup: create VR state and nurture profile
            const state = loadVRState(testUser, 'twitter');
            state.health = 0.65;
            state.meanN = 3;
            saveVRState(state);

            const profile = loadNurtureProfile(testUser, 'twitter');
            profile.tier = 'acquaintance';
            saveNurtureProfile(profile);
        });

        afterAll(() => {
            cleanupTestVRState(testUser, 'twitter');
            const profilePath = path.join(process.cwd(), 'logs', 'tracking', 'nurture', 'profiles', `twitter_${testUser}.json`);
            if (fs.existsSync(profilePath)) fs.unlinkSync(profilePath);
        });

        it('should complete full cycle: detect badges → decide action → process notification → update health', () => {
            // Step 1: Badge reader detects notifications
            const snapshot = makeSnapshot(
                makeBadges('twitter', 3, 5),
                makeBadges('instagram', 0, 0),
                makeBadges('threads', 0, 0),
            );
            const actions = getActionsFromBadges(snapshot);

            // Step 2: Verify actions are prioritized correctly
            expect(actions.length).toBe(2);
            expect(actions[0].action).toBe('scrape_inbox_and_reply');
            expect(actions[1].action).toBe('check_notifications');

            // Step 3: Simulate notification check found a reply from testUser
            // (normally done by checkNotifications with Puppeteer — we simulate)
            const beforeHealth = loadVRState(testUser, 'twitter').health;

            // Step 4: Process the notification → updates health
            updateHealth(testUser, 'twitter', 'reply_received');
            const afterHealth = loadVRState(testUser, 'twitter').health;
            expect(afterHealth).toBeGreaterThan(beforeHealth);

            // Step 5: Reward bandit for the comment style that got the reply
            recordBanditReward(testUser, 'twitter', 'thoughtful_question', 1.0);

            const state = loadVRState(testUser, 'twitter');
            const tq = state.commentBandit.find(a => a.style === 'thoughtful_question')!;
            expect(tq.rewards).toBe(1.0);
            expect(tq.pulls).toBeGreaterThanOrEqual(1);
        });

        it('should handle the engagement → VR decision loop', () => {
            // After positive engagement, VR should be more willing to engage again
            const state = loadVRState(testUser, 'twitter');
            expect(state.health).toBeGreaterThan(0.55); // Above health floor

            // Simulate interactions until VR decides to engage
            let decided = false;
            for (let i = 0; i < 20; i++) {
                const decision = recordInteractionAndDecide(testUser, 'twitter');
                if (decision.shouldEngage) {
                    decided = true;
                    expect(decision.style).toBeTruthy();
                    expect(decision.reason).toBeTruthy();
                    break;
                }
            }
            expect(decided).toBe(true); // Should have decided to engage within 20 tries
        });
    });

    // ── 10. Action handler mapping verification ─────────────────────

    describe('Action-to-handler mapping', () => {
        const ACTION_HANDLERS: Record<string, string> = {
            'scrape_inbox_and_reply': 'TwitterDM.scrapeInbox() → process unread → reply',
            'check_notifications': 'checkNotifications(page) → process replies',
            'scrape_ig_inbox_and_reply': 'InstagramDM inbox scrape → process → reply',
            'check_ig_notifications': 'Instagram notification check',
            'check_threads_notifications': 'Threads notification check',
        };

        it('should have a handler defined for every possible action', () => {
            // Generate all possible actions
            const allActions = new Set<string>();
            const configs: Array<[number, number, number, number, number]> = [
                [1, 0, 0, 0, 0], [0, 1, 0, 0, 0], [0, 0, 1, 0, 0],
                [0, 0, 0, 1, 0], [0, 0, 0, 0, 1], [1, 1, 1, 1, 1],
            ];

            for (const [twDm, twNotif, igDm, igNotif, thNotif] of configs) {
                const snapshot = makeSnapshot(
                    makeBadges('twitter', twDm, twNotif),
                    makeBadges('instagram', igDm, igNotif),
                    makeBadges('threads', 0, thNotif),
                );
                const actions = getActionsFromBadges(snapshot);
                actions.forEach(a => allActions.add(a.action));
            }

            // Every action string should map to a known handler
            for (const action of allActions) {
                expect(ACTION_HANDLERS).toHaveProperty(action);
            }
        });

        it('should never produce duplicate actions in a single snapshot', () => {
            const snapshot = makeSnapshot(
                makeBadges('twitter', 10, 10),
                makeBadges('instagram', 10, 10),
                makeBadges('threads', 0, 10),
            );
            const actions = getActionsFromBadges(snapshot);
            const actionStrings = actions.map(a => `${a.platform}_${a.type}`);
            const unique = new Set(actionStrings);
            expect(unique.size).toBe(actionStrings.length);
        });
    });

    // ── 11. Edge cases ──────────────────────────────────────────────

    describe('Edge cases', () => {
        it('should handle very large badge counts', () => {
            const snapshot = makeSnapshot(
                makeBadges('twitter', 999, 500),
                makeBadges('instagram', 200, 150),
                makeBadges('threads', 0, 99),
            );
            const actions = getActionsFromBadges(snapshot);
            expect(actions).toHaveLength(5);
            expect(actions[0].count).toBe(999); // Highest DM count first
        });

        it('should handle badge count of 1 (single unread)', () => {
            const snapshot = makeSnapshot(
                makeBadges('twitter', 1, 0),
                makeBadges('instagram', 0, 0),
                makeBadges('threads', 0, 0),
            );
            const actions = getActionsFromBadges(snapshot);
            expect(actions).toHaveLength(1);
            expect(actions[0].count).toBe(1);
        });

        it('should handle all platforms having only notifications (no DMs)', () => {
            const snapshot = makeSnapshot(
                makeBadges('twitter', 0, 3),
                makeBadges('instagram', 0, 2),
                makeBadges('threads', 0, 1),
            );
            const actions = getActionsFromBadges(snapshot);
            expect(actions.every(a => a.type === 'notification')).toBe(true);
            expect(actions[0].priority).toBe('medium'); // Twitter notif
            expect(actions[actions.length - 1].priority).toBe('low'); // Threads notif
        });

        it('should return empty actions for empty snapshot', () => {
            const snapshot = makeSnapshot(
                makeBadges('twitter', 0, 0),
                makeBadges('instagram', 0, 0),
                makeBadges('threads', 0, 0),
            );
            const actions = getActionsFromBadges(snapshot);
            expect(actions).toHaveLength(0);
        });
    });

    // ── 12. Ignored comment penalty ─────────────────────────────────

    describe('Ignored comment penalty', () => {
        const testUser = '__test_ignored_penalty';

        beforeAll(() => {
            // Create VR state with a comment posted long ago (48h)
            const state = loadVRState(testUser, 'twitter');
            state.health = 0.70;
            state.lastCommentAt = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
            state.consecutiveIgnored = 0;
            saveVRState(state);

            // Also need a nurture profile
            const profile = loadNurtureProfile(testUser, 'twitter');
            profile.tier = 'acquaintance';
            saveNurtureProfile(profile);
        });

        afterAll(() => {
            cleanupTestVRState(testUser, 'twitter');
            const profilePath = path.join(process.cwd(), 'logs', 'tracking', 'nurture', 'profiles', `twitter_${testUser}.json`);
            if (fs.existsSync(profilePath)) fs.unlinkSync(profilePath);
        });

        it('should apply ignored penalty after wait period with no reply', () => {
            // Clear notifications so there's no reply from testUser
            seedNotifications([]);

            const beforeState = loadVRState(testUser, 'twitter');
            const beforeHealth = beforeState.health;

            // Process ignored comments with 24h wait (our comment was 48h ago)
            const updated = processIgnoredComments(24);
            expect(updated).toBeGreaterThanOrEqual(1);

            const afterState = loadVRState(testUser, 'twitter');
            expect(afterState.health).toBeLessThan(beforeHealth);
        });
    });

    // ── 13. Cross-platform VR state isolation ───────────────────────

    describe('Cross-platform state isolation', () => {
        const testUser = '__test_xplatform';

        afterAll(() => {
            cleanupTestVRState(testUser, 'twitter');
            cleanupTestVRState(testUser, 'instagram');
        });

        it('should maintain separate VR states per platform', () => {
            // Update Twitter health
            const twState = loadVRState(testUser, 'twitter');
            twState.health = 0.90;
            saveVRState(twState);

            // Update Instagram health differently
            const igState = loadVRState(testUser, 'instagram');
            igState.health = 0.40;
            saveVRState(igState);

            // Verify they're independent
            const tw = loadVRState(testUser, 'twitter');
            const ig = loadVRState(testUser, 'instagram');
            expect(tw.health).toBe(0.90);
            expect(ig.health).toBe(0.40);
        });

        it('should allow independent bandit learning per platform', () => {
            // Reward humor on Twitter
            recordBanditPull(testUser, 'twitter', 'humor');
            recordBanditReward(testUser, 'twitter', 'humor', 1.0);

            // Reward encouragement on Instagram
            recordBanditPull(testUser, 'instagram', 'encouragement');
            recordBanditReward(testUser, 'instagram', 'encouragement', 1.0);

            const tw = loadVRState(testUser, 'twitter');
            const ig = loadVRState(testUser, 'instagram');

            const twHumor = tw.commentBandit.find(a => a.style === 'humor')!;
            const twEncourage = tw.commentBandit.find(a => a.style === 'encouragement')!;
            const igHumor = ig.commentBandit.find(a => a.style === 'humor')!;
            const igEncourage = ig.commentBandit.find(a => a.style === 'encouragement')!;

            expect(twHumor.rewards).toBe(1.0);
            expect(twEncourage.rewards).toBe(0);
            expect(igHumor.rewards).toBe(0);
            expect(igEncourage.rewards).toBe(1.0);
        });
    });
});
