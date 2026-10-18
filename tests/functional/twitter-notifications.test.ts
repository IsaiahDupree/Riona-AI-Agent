/**
 * Twitter Notifications Tests — Notification detection, health updates,
 * ignored comment processing, and actioning.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
    getUnactionedReplies, markNotificationActioned,
    getNotificationStats, DetectedNotification,
} from '../../src/client/Twitter-Notifications';
import { loadVRState, saveVRState, updateHealth } from '../../src/nurture/vr-scheduler';
import { loadNurtureProfile, saveNurtureProfile } from '../../src/nurture/store';

// ── Test helpers ─────────────────────────────────────────────────────

const NOTIF_DIR = path.join(process.cwd(), 'logs', 'tracking', 'twitter', 'notifications');
const NOTIF_FILE = path.join(NOTIF_DIR, 'detected.json');
const VR_STATE_DIR = path.join(process.cwd(), 'logs', 'tracking', 'nurture', 'vr-states');
const NURTURE_DIR = path.join(process.cwd(), 'logs', 'tracking', 'nurture', 'profiles');
const TEST_PREFIX = '__test_notif_';

function testStatePath(username: string): string {
    return path.join(VR_STATE_DIR, `twitter_${username}.json`);
}

function testProfilePath(username: string): string {
    return path.join(NURTURE_DIR, `twitter_${username}.json`);
}

function injectTestNotifications(notifs: DetectedNotification[]) {
    if (!fs.existsSync(NOTIF_DIR)) fs.mkdirSync(NOTIF_DIR, { recursive: true });

    // Read existing, filter out test entries, add new test ones
    let existing: DetectedNotification[] = [];
    try {
        existing = JSON.parse(fs.readFileSync(NOTIF_FILE, 'utf8'));
    } catch (_) {}

    const nonTest = existing.filter(n => !n.fromUsername.includes(TEST_PREFIX));
    fs.writeFileSync(NOTIF_FILE, JSON.stringify([...nonTest, ...notifs], null, 2));
}

function cleanupTestNotifications() {
    try {
        if (!fs.existsSync(NOTIF_FILE)) return;
        const notifs: DetectedNotification[] = JSON.parse(fs.readFileSync(NOTIF_FILE, 'utf8'));
        const cleaned = notifs.filter(n => !n.fromUsername.includes(TEST_PREFIX));
        fs.writeFileSync(NOTIF_FILE, JSON.stringify(cleaned, null, 2));
    } catch (_) {}
}

function cleanupTestFiles() {
    cleanupTestNotifications();
    try {
        if (fs.existsSync(VR_STATE_DIR)) {
            for (const f of fs.readdirSync(VR_STATE_DIR)) {
                if (f.includes(TEST_PREFIX)) fs.unlinkSync(path.join(VR_STATE_DIR, f));
            }
        }
        if (fs.existsSync(NURTURE_DIR)) {
            for (const f of fs.readdirSync(NURTURE_DIR)) {
                if (f.includes(TEST_PREFIX)) fs.unlinkSync(path.join(NURTURE_DIR, f));
            }
        }
    } catch (_) {}
}

// ── Tests ────────────────────────────────────────────────────────────

describe('Twitter Notifications System', () => {
    afterAll(() => {
        cleanupTestFiles();
    });

    describe('Notification Detection & Storage', () => {
        const user1 = `${TEST_PREFIX}user1`;
        const user2 = `${TEST_PREFIX}user2`;

        beforeAll(() => {
            injectTestNotifications([
                {
                    type: 'reply',
                    fromUsername: user1,
                    text: `${user1} replied to your tweet`,
                    ourTweetUrl: 'https://x.com/bot/status/123',
                    theirTweetUrl: 'https://x.com/user1/status/456',
                    detectedAt: new Date().toISOString(),
                    actioned: false,
                },
                {
                    type: 'like',
                    fromUsername: user2,
                    text: `${user2} liked your tweet`,
                    ourTweetUrl: 'https://x.com/bot/status/123',
                    detectedAt: new Date().toISOString(),
                    actioned: false,
                },
                {
                    type: 'mention',
                    fromUsername: user1,
                    text: `${user1} mentioned you`,
                    theirTweetUrl: 'https://x.com/user1/status/789',
                    detectedAt: new Date().toISOString(),
                    actioned: false,
                },
            ]);
        });

        it('should return unactioned reply/mention notifications', () => {
            const unactioned = getUnactionedReplies();
            const testNotifs = unactioned.filter(n => n.fromUsername.includes(TEST_PREFIX));

            expect(testNotifs.length).toBe(2); // reply + mention
            expect(testNotifs.some(n => n.type === 'reply')).toBe(true);
            expect(testNotifs.some(n => n.type === 'mention')).toBe(true);
        });

        it('should not include likes in unactioned replies', () => {
            const unactioned = getUnactionedReplies();
            const testLikes = unactioned.filter(n =>
                n.fromUsername.includes(TEST_PREFIX) && n.type === 'like'
            );
            expect(testLikes.length).toBe(0);
        });

        it('should return notification stats', () => {
            const stats = getNotificationStats();
            expect(stats.total).toBeGreaterThan(0);
            expect(stats).toHaveProperty('unactioned');
            expect(stats).toHaveProperty('byType');
            expect(stats.byType).toHaveProperty('reply');
            expect(stats.byType).toHaveProperty('like');
        });
    });

    describe('Notification Actioning', () => {
        const user = `${TEST_PREFIX}action`;

        beforeAll(() => {
            injectTestNotifications([
                {
                    type: 'reply',
                    fromUsername: user,
                    text: `${user} replied to your tweet`,
                    ourTweetUrl: 'https://x.com/bot/status/100',
                    detectedAt: new Date().toISOString(),
                    actioned: false,
                },
            ]);
        });

        it('should mark notification as actioned', () => {
            markNotificationActioned(user, 'reply', 'replied', 'Thanks!');

            const unactioned = getUnactionedReplies();
            const userNotifs = unactioned.filter(n => n.fromUsername === user);
            expect(userNotifs.length).toBe(0);
        });
    });

    describe('Health Updates from Notifications', () => {
        const user = `${TEST_PREFIX}health`;

        beforeAll(() => {
            // Create VR state and nurture profile
            const state = loadVRState(user, 'twitter');
            state.health = 0.7;
            saveVRState(state);
            loadNurtureProfile(user, 'twitter');
        });

        it('should increase health on reply_received', () => {
            const newHealth = updateHealth(user, 'twitter', 'reply_received');
            expect(newHealth).toBeGreaterThan(0.7);
        });

        it('should increase health on like_received', () => {
            const before = loadVRState(user, 'twitter').health;
            const newHealth = updateHealth(user, 'twitter', 'like_received');
            expect(newHealth).toBeGreaterThan(before);
        });

        it('should increase health when they engage our content', () => {
            const before = loadVRState(user, 'twitter').health;
            const newHealth = updateHealth(user, 'twitter', 'they_engaged_our_content');
            expect(newHealth).toBeGreaterThan(before);
        });

        it('should decrease health on DM ignored', () => {
            const before = loadVRState(user, 'twitter').health;
            const newHealth = updateHealth(user, 'twitter', 'dm_ignored');
            expect(newHealth).toBeLessThan(before);
        });
    });

    describe('VR State ↔ Nurture Profile Integration', () => {
        const user = `${TEST_PREFIX}integration`;

        afterAll(() => {
            try { fs.unlinkSync(testStatePath(user)); } catch (_) {}
            try { fs.unlinkSync(testProfilePath(user)); } catch (_) {}
        });

        it('should have both VR state and nurture profile for same user', () => {
            const vrState = loadVRState(user, 'twitter');
            const profile = loadNurtureProfile(user, 'twitter');

            expect(vrState.username).toBe(user);
            expect(profile.username).toBe(user);
            expect(vrState.platform).toBe('twitter');
            expect(profile.platform).toBe('twitter');
        });

        it('should maintain independent health and tier systems', () => {
            const vrState = loadVRState(user, 'twitter');
            const profile = loadNurtureProfile(user, 'twitter');

            // VR health is 0-1, tier is a string
            expect(vrState.health).toBeGreaterThanOrEqual(0);
            expect(vrState.health).toBeLessThanOrEqual(1);
            expect(profile.tier).toBe('acquaintance');

            // Health update doesn't change tier
            updateHealth(user, 'twitter', 'reply_received');
            const reloaded = loadNurtureProfile(user, 'twitter');
            expect(reloaded.tier).toBe('acquaintance');
        });
    });
});
