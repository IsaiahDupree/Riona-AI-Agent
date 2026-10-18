/**
 * Notification Badge Reader Tests — Badge parsing, action prioritization, history
 */

import {
    getActionsFromBadges, getLatestBadgeSnapshot, getBadgeTrend,
    BadgeSnapshot, PlatformBadges,
} from '../../src/client/NotificationBadgeReader';

// ── Helpers ──────────────────────────────────────────────────────────

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

// ── Tests ────────────────────────────────────────────────────────────

describe('NotificationBadgeReader', () => {
    describe('Action prioritization', () => {
        it('should return no actions when all badges are zero', () => {
            const snapshot = makeSnapshot(
                makeBadges('twitter', 0, 0),
                makeBadges('instagram', 0, 0),
                makeBadges('threads', 0, 0),
            );
            const actions = getActionsFromBadges(snapshot);
            expect(actions).toHaveLength(0);
        });

        it('should prioritize DMs over notifications', () => {
            const snapshot = makeSnapshot(
                makeBadges('twitter', 14, 5),
                makeBadges('instagram', 0, 0),
                makeBadges('threads', 0, 0),
            );
            const actions = getActionsFromBadges(snapshot);
            expect(actions.length).toBe(2);
            expect(actions[0].type).toBe('dm');
            expect(actions[0].priority).toBe('high');
            expect(actions[0].count).toBe(14);
            expect(actions[1].type).toBe('notification');
            expect(actions[1].priority).toBe('medium');
        });

        it('should handle multi-platform badges', () => {
            const snapshot = makeSnapshot(
                makeBadges('twitter', 14, 0),
                makeBadges('instagram', 9, 3),
                makeBadges('threads', 0, 2),
            );
            const actions = getActionsFromBadges(snapshot);

            // High priority: Twitter DMs (14) + Instagram DMs (9)
            const highPriority = actions.filter(a => a.priority === 'high');
            expect(highPriority).toHaveLength(2);
            expect(highPriority[0].count).toBe(14); // Twitter DMs first (higher count)
            expect(highPriority[1].count).toBe(9);  // Instagram DMs second

            // Medium: Instagram notifications (3)
            const medium = actions.filter(a => a.priority === 'medium');
            expect(medium).toHaveLength(1);
            expect(medium[0].platform).toBe('instagram');

            // Low: Threads notifications (2)
            const low = actions.filter(a => a.priority === 'low');
            expect(low).toHaveLength(1);
            expect(low[0].platform).toBe('threads');
        });

        it('should sort high-priority actions by count descending', () => {
            const snapshot = makeSnapshot(
                makeBadges('twitter', 3, 0),
                makeBadges('instagram', 9, 0),
                makeBadges('threads', 0, 0),
            );
            const actions = getActionsFromBadges(snapshot);
            expect(actions[0].platform).toBe('instagram');
            expect(actions[0].count).toBe(9);
            expect(actions[1].platform).toBe('twitter');
            expect(actions[1].count).toBe(3);
        });

        it('should assign correct action strings', () => {
            const snapshot = makeSnapshot(
                makeBadges('twitter', 1, 1),
                makeBadges('instagram', 1, 1),
                makeBadges('threads', 0, 1),
            );
            const actions = getActionsFromBadges(snapshot);
            const actionMap = Object.fromEntries(actions.map(a => [`${a.platform}_${a.type}`, a.action]));

            expect(actionMap['twitter_dm']).toBe('scrape_inbox_and_reply');
            expect(actionMap['twitter_notification']).toBe('check_notifications');
            expect(actionMap['instagram_dm']).toBe('scrape_ig_inbox_and_reply');
            expect(actionMap['instagram_notification']).toBe('check_ig_notifications');
            expect(actionMap['threads_notification']).toBe('check_threads_notifications');
        });
    });

    describe('Badge trend', () => {
        it('should return a valid direction for any history state', () => {
            const trend = getBadgeTrend('twitter', 'dm');
            expect(['up', 'down', 'stable']).toContain(trend.direction);
        });
    });
});
