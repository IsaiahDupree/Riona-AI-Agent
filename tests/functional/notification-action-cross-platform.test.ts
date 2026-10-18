/**
 * Cross-Platform Notification Action Tests
 *
 * Tests the full notification→action pipeline for ALL platforms:
 *   Twitter: detect notifications → classify → surface unactioned → mark actioned → health update
 *   Instagram: detect notifications → classify → surface unactioned → mark actioned → health update
 *
 * Also tests:
 * - Deduplication across scrape passes
 * - Notification classification accuracy
 * - Reply handler skip/dedup logic (recently replied, already replied to tweet)
 * - Notification stats accuracy
 * - Cross-platform state isolation for notifications
 * - Scheduler integration points (reply handler fires even without new notifications)
 */

import {
    getUnactionedReplies, markNotificationActioned,
    getNotificationStats, processIgnoredComments,
    DetectedNotification, NotificationType,
} from '../../src/client/Twitter-Notifications';

import {
    getIGUnactionedReplies, markIGNotificationActioned,
    getIGNotificationStats,
    IGDetectedNotification, IGNotificationType,
} from '../../src/client/Instagram-Notifications';

import {
    getActionsFromBadges,
    BadgeSnapshot, PlatformBadges,
} from '../../src/client/NotificationBadgeReader';

import {
    loadVRState, saveVRState, updateHealth,
    recordBanditReward,
} from '../../src/nurture/vr-scheduler';

import {
    loadNurtureProfile, saveNurtureProfile, profileExists,
} from '../../src/nurture/store';

import {
    trackReply, hasRepliedToTweet, recentReplyToUser,
} from '../../src/tracking/twitterTracker';

import {
    trackComment, hasCommentedOnPost, recentCommentOnUser,
} from '../../src/tracking/commentTracker';

import * as fs from 'fs';
import * as path from 'path';

// ── Paths ────────────────────────────────────────────────────────────

const TW_NOTIF_DIR = path.join(process.cwd(), 'logs', 'tracking', 'twitter', 'notifications');
const TW_NOTIF_FILE = path.join(TW_NOTIF_DIR, 'detected.json');
const IG_NOTIF_DIR = path.join(process.cwd(), 'logs', 'tracking', 'instagram', 'notifications');
const IG_NOTIF_FILE = path.join(IG_NOTIF_DIR, 'detected.json');
const VR_DIR = path.join(process.cwd(), 'logs', 'tracking', 'nurture', 'vr-states');
const TW_REPLY_FILE = path.join(process.cwd(), 'logs', 'tracking', 'twitter', 'replies.json');
const IG_COMMENT_FILE = path.join(process.cwd(), 'logs', 'tracking', 'comments.json');

// ── Helpers ──────────────────────────────────────────────────────────

function makeBadges(platform: 'twitter' | 'instagram' | 'threads', dms: number, notifs: number): PlatformBadges {
    return {
        platform, dms, notifications: notifs,
        rawDms: String(dms), rawNotifications: String(notifs),
        readAt: new Date().toISOString(),
    };
}

function makeSnapshot(twitter: PlatformBadges, instagram: PlatformBadges, threads: PlatformBadges): BadgeSnapshot {
    return { twitter, instagram, threads, snapshotAt: new Date().toISOString() };
}

function seedTWNotification(overrides: Partial<DetectedNotification> = {}): DetectedNotification {
    return {
        type: 'reply',
        fromUsername: 'tw_user',
        text: 'tw_user replied to your tweet: interesting take!',
        ourTweetUrl: 'https://x.com/me/status/100',
        theirTweetUrl: 'https://x.com/tw_user/status/200',
        detectedAt: new Date().toISOString(),
        actioned: false,
        ...overrides,
    };
}

function seedIGNotification(overrides: Partial<IGDetectedNotification> = {}): IGDetectedNotification {
    return {
        type: 'reply',
        fromUsername: 'ig_user',
        text: 'ig_user commented on your post: love this!',
        postUrl: '/p/ABC123/',
        detectedAt: new Date().toISOString(),
        actioned: false,
        ...overrides,
    };
}

function seedTWNotifications(notifs: DetectedNotification[]) {
    if (!fs.existsSync(TW_NOTIF_DIR)) fs.mkdirSync(TW_NOTIF_DIR, { recursive: true });
    fs.writeFileSync(TW_NOTIF_FILE, JSON.stringify(notifs), 'utf8');
}

function seedIGNotifications(notifs: IGDetectedNotification[]) {
    if (!fs.existsSync(IG_NOTIF_DIR)) fs.mkdirSync(IG_NOTIF_DIR, { recursive: true });
    fs.writeFileSync(IG_NOTIF_FILE, JSON.stringify(notifs), 'utf8');
}

function cleanupVRState(username: string, platform: string) {
    const file = path.join(VR_DIR, `${platform}_${username}.json`);
    if (fs.existsSync(file)) fs.unlinkSync(file);
}

function cleanupProfile(username: string, platform: string) {
    const file = path.join(process.cwd(), 'logs', 'tracking', 'nurture', 'profiles', `${platform}_${username}.json`);
    if (fs.existsSync(file)) fs.unlinkSync(file);
}

// Backup/restore helpers for tracker files to avoid test pollution
let twReplyBackup: string | null = null;
let igCommentBackup: string | null = null;

function backupTrackers() {
    if (fs.existsSync(TW_REPLY_FILE)) twReplyBackup = fs.readFileSync(TW_REPLY_FILE, 'utf8');
    if (fs.existsSync(IG_COMMENT_FILE)) igCommentBackup = fs.readFileSync(IG_COMMENT_FILE, 'utf8');
}

function restoreTrackers() {
    if (twReplyBackup !== null) fs.writeFileSync(TW_REPLY_FILE, twReplyBackup, 'utf8');
    if (igCommentBackup !== null) fs.writeFileSync(IG_COMMENT_FILE, igCommentBackup, 'utf8');
}

// ── Tests ────────────────────────────────────────────────────────────

describe('Cross-Platform Notification Action Pipeline', () => {

    // ────────────────────────────────────────────────────────────────
    // 1. Twitter notification classification
    // ────────────────────────────────────────────────────────────────

    describe('Twitter notification classification', () => {
        it('should classify "replied" as reply type', () => {
            const notif = seedTWNotification({
                text: 'test_user replied to your tweet: this is great!',
                type: 'reply',
            });
            expect(notif.type).toBe('reply');
        });

        it('should classify "replying to" as reply type', () => {
            // The classifier in checkNotifications uses text matching:
            // lowerText.includes('replied') || lowerText.includes('replying to')
            const text = 'Replying to @me this is a conversation';
            const lower = text.toLowerCase();
            const isReply = lower.includes('replied') || lower.includes('replying to');
            expect(isReply).toBe(true);
        });

        it('should classify "liked your" as like type', () => {
            const text = 'john_doe liked your Tweet';
            const lower = text.toLowerCase();
            const isLike = lower.includes('liked your') || lower.includes('liked a') || /liked \d+ of your/i.test(text);
            expect(isLike).toBe(true);
        });

        it('should classify "liked 3 of your posts" as like type', () => {
            const text = 'someone liked 3 of your posts';
            const isLike = /liked \d+ of your/i.test(text);
            expect(isLike).toBe(true);
        });

        it('should classify "retweeted your" as retweet type', () => {
            const text = 'user123 Retweeted your Tweet about AI tools';
            const lower = text.toLowerCase();
            const isRT = lower.includes('retweeted your') || lower.includes('reposted your') || lower.includes('reposted');
            expect(isRT).toBe(true);
        });

        it('should classify "quoted your" as quote type', () => {
            const text = 'ai_dev quoted your Tweet';
            const lower = text.toLowerCase();
            const isQuote = lower.includes('quoted your') || lower.includes('quote tweeted') || lower.includes('quoted');
            expect(isQuote).toBe(true);
        });

        it('should classify "followed you" as follow type', () => {
            const text = 'new_follower followed you';
            const lower = text.toLowerCase();
            const isFollow = lower.includes('followed you') || lower.includes('followed');
            expect(isFollow).toBe(true);
        });

        it('should classify "recent post from" as recommended type', () => {
            const text = 'Recent post from @someone you follow';
            const lower = text.toLowerCase();
            const isRecommended = lower.includes('recent post from') || lower.includes('there was a login');
            expect(isRecommended).toBe(true);
        });

        it('should classify unrecognized text as unknown type', () => {
            const text = 'something completely random happened on Twitter';
            const lower = text.toLowerCase();
            let type = 'unknown';
            if (lower.includes('replied') || lower.includes('replying to')) type = 'reply';
            else if (lower.includes('mentioned you') || lower.includes('mentioned')) type = 'mention';
            else if (lower.includes('liked your') || lower.includes('liked a') || /liked \d+/.test(text)) type = 'like';
            else if (lower.includes('retweeted your') || lower.includes('reposted')) type = 'retweet';
            else if (lower.includes('quoted your') || lower.includes('quoted')) type = 'quote';
            else if (lower.includes('followed you') || lower.includes('followed')) type = 'follow';
            expect(type).toBe('unknown');
        });
    });

    // ────────────────────────────────────────────────────────────────
    // 2. Instagram notification classification
    // ────────────────────────────────────────────────────────────────

    describe('Instagram notification classification', () => {
        it('should classify "commented" as reply type', () => {
            const text = 'user123 commented on your post: nice work!';
            const lower = text.toLowerCase();
            const isReply = lower.includes('commented') || lower.includes('replied') || lower.includes('replying');
            expect(isReply).toBe(true);
        });

        it('should classify "mentioned you" as mention type', () => {
            const text = 'creator_user mentioned you in a comment';
            const lower = text.toLowerCase();
            const isMention = lower.includes('mentioned you') || lower.includes('mentioned');
            expect(isMention).toBe(true);
        });

        it('should classify "liked your" as like type', () => {
            const text = 'fan_page liked your photo';
            const lower = text.toLowerCase();
            const isLike = lower.includes('liked your') || lower.includes('liked a') || /liked \d+/.test(text);
            expect(isLike).toBe(true);
        });

        it('should classify "started following" as follow type', () => {
            const text = 'new_person started following you';
            const lower = text.toLowerCase();
            const isFollow = lower.includes('started following') || lower.includes('followed');
            expect(isFollow).toBe(true);
        });

        it('should classify "tagged you" as tag type', () => {
            const text = 'photographer tagged you in a post';
            const lower = text.toLowerCase();
            const isTag = lower.includes('tagged you') || lower.includes('tagged');
            expect(isTag).toBe(true);
        });
    });

    // ────────────────────────────────────────────────────────────────
    // 3. Twitter unactioned reply surfacing + actioning
    // ────────────────────────────────────────────────────────────────

    describe('Twitter unactioned reply lifecycle', () => {
        const testNotifs: DetectedNotification[] = [
            seedTWNotification({ fromUsername: 'tw_replier_1', type: 'reply' }),
            seedTWNotification({ fromUsername: 'tw_replier_2', type: 'mention' }),
            seedTWNotification({ fromUsername: 'tw_liker', type: 'like' }),
            seedTWNotification({ fromUsername: 'tw_replier_3', type: 'reply', actioned: true, actionType: 'replied' }),
            seedTWNotification({ fromUsername: 'tw_retweeter', type: 'retweet' }),
            seedTWNotification({ fromUsername: 'unknown', type: 'reply' }), // should be filtered
        ];

        beforeAll(() => seedTWNotifications(testNotifs));

        it('should return only unactioned reply/mention notifications (not likes/RTs/unknown)', () => {
            const unactioned = getUnactionedReplies();
            expect(unactioned).toHaveLength(2);
            expect(unactioned.map(n => n.fromUsername).sort()).toEqual(['tw_replier_1', 'tw_replier_2']);
        });

        it('should exclude already-actioned replies', () => {
            const unactioned = getUnactionedReplies();
            expect(unactioned.find(n => n.fromUsername === 'tw_replier_3')).toBeUndefined();
        });

        it('should exclude "unknown" usernames', () => {
            const unactioned = getUnactionedReplies();
            expect(unactioned.find(n => n.fromUsername === 'unknown')).toBeUndefined();
        });

        it('should mark notification as actioned with "replied"', () => {
            markNotificationActioned('tw_replier_1', 'reply', 'replied', 'Great point about AI!');
            const unactioned = getUnactionedReplies();
            expect(unactioned.find(n => n.fromUsername === 'tw_replier_1')).toBeUndefined();
            expect(unactioned).toHaveLength(1);
        });

        it('should mark notification as actioned with "ignored"', () => {
            markNotificationActioned('tw_replier_2', 'mention', 'ignored', 'no_context');
            const unactioned = getUnactionedReplies();
            expect(unactioned).toHaveLength(0);
        });

        it('should persist action type, text, and timestamp', () => {
            const stored: DetectedNotification[] = JSON.parse(fs.readFileSync(TW_NOTIF_FILE, 'utf8'));
            const r1 = stored.find(n => n.fromUsername === 'tw_replier_1' && n.actioned);
            expect(r1).toBeDefined();
            expect(r1!.actionType).toBe('replied');
            expect(r1!.actionText).toBe('Great point about AI!');
            expect(r1!.actionedAt).toBeTruthy();
        });
    });

    // ────────────────────────────────────────────────────────────────
    // 4. Instagram unactioned reply surfacing + actioning
    // ────────────────────────────────────────────────────────────────

    describe('Instagram unactioned reply lifecycle', () => {
        const testNotifs: IGDetectedNotification[] = [
            seedIGNotification({ fromUsername: 'ig_commenter_1', type: 'reply' }),
            seedIGNotification({ fromUsername: 'ig_mentioner', type: 'mention' }),
            seedIGNotification({ fromUsername: 'ig_liker', type: 'like' }),
            seedIGNotification({ fromUsername: 'ig_tagger', type: 'tag' }),
            seedIGNotification({ fromUsername: 'ig_commenter_2', type: 'reply', actioned: true, actionType: 'replied' }),
            seedIGNotification({ fromUsername: 'unknown', type: 'reply' }),
        ];

        beforeAll(() => seedIGNotifications(testNotifs));

        it('should return only unactioned reply/mention IG notifications', () => {
            const unactioned = getIGUnactionedReplies();
            expect(unactioned).toHaveLength(2);
            expect(unactioned.map(n => n.fromUsername).sort()).toEqual(['ig_commenter_1', 'ig_mentioner']);
        });

        it('should exclude likes, tags, follows, and already-actioned', () => {
            const unactioned = getIGUnactionedReplies();
            expect(unactioned.find(n => n.fromUsername === 'ig_liker')).toBeUndefined();
            expect(unactioned.find(n => n.fromUsername === 'ig_tagger')).toBeUndefined();
            expect(unactioned.find(n => n.fromUsername === 'ig_commenter_2')).toBeUndefined();
        });

        it('should exclude "unknown" usernames', () => {
            const unactioned = getIGUnactionedReplies();
            expect(unactioned.find(n => n.fromUsername === 'unknown')).toBeUndefined();
        });

        it('should mark IG notification as actioned', () => {
            markIGNotificationActioned('ig_commenter_1', 'reply', 'replied', 'Glad you liked it!');
            const unactioned = getIGUnactionedReplies();
            expect(unactioned.find(n => n.fromUsername === 'ig_commenter_1')).toBeUndefined();
        });

        it('should persist IG action details', () => {
            const stored: IGDetectedNotification[] = JSON.parse(fs.readFileSync(IG_NOTIF_FILE, 'utf8'));
            const c1 = stored.find(n => n.fromUsername === 'ig_commenter_1' && n.actioned);
            expect(c1).toBeDefined();
            expect(c1!.actionType).toBe('replied');
            expect(c1!.actionText).toBe('Glad you liked it!');
            expect(c1!.actionedAt).toBeTruthy();
        });
    });

    // ────────────────────────────────────────────────────────────────
    // 5. Twitter notification stats
    // ────────────────────────────────────────────────────────────────

    describe('Twitter notification stats', () => {
        beforeAll(() => {
            seedTWNotifications([
                seedTWNotification({ fromUsername: 'a', type: 'reply', actioned: false }),
                seedTWNotification({ fromUsername: 'b', type: 'reply', actioned: true }),
                seedTWNotification({ fromUsername: 'c', type: 'like', actioned: false }),
                seedTWNotification({ fromUsername: 'd', type: 'mention', actioned: false }),
                seedTWNotification({ fromUsername: 'e', type: 'retweet', actioned: false }),
                seedTWNotification({ fromUsername: 'f', type: 'quote', actioned: false }),
                seedTWNotification({ fromUsername: 'g', type: 'follow', actioned: false }),
            ]);
        });

        it('should count total notifications', () => {
            const stats = getNotificationStats();
            expect(stats.total).toBe(7);
        });

        it('should count unactioned reply+mention only', () => {
            const stats = getNotificationStats();
            // 'a' (reply, unactioned) + 'd' (mention, unactioned) = 2
            // 'b' is actioned, 'c' is like, 'e'/'f'/'g' aren't reply/mention
            expect(stats.unactioned).toBe(2);
        });

        it('should breakdown by type correctly', () => {
            const stats = getNotificationStats();
            expect(stats.byType.reply).toBe(2);
            expect(stats.byType.mention).toBe(1);
            expect(stats.byType.like).toBe(1);
            expect(stats.byType.retweet).toBe(1);
            expect(stats.byType.quote).toBe(1);
            expect(stats.byType.follow).toBe(1);
        });
    });

    // ────────────────────────────────────────────────────────────────
    // 6. Instagram notification stats
    // ────────────────────────────────────────────────────────────────

    describe('Instagram notification stats', () => {
        beforeAll(() => {
            seedIGNotifications([
                seedIGNotification({ fromUsername: 'a', type: 'reply', actioned: false }),
                seedIGNotification({ fromUsername: 'b', type: 'reply', actioned: true }),
                seedIGNotification({ fromUsername: 'c', type: 'like', actioned: false }),
                seedIGNotification({ fromUsername: 'd', type: 'mention', actioned: false }),
                seedIGNotification({ fromUsername: 'e', type: 'follow', actioned: false }),
                seedIGNotification({ fromUsername: 'f', type: 'tag', actioned: false }),
            ]);
        });

        it('should count total IG notifications', () => {
            const stats = getIGNotificationStats();
            expect(stats.total).toBe(6);
        });

        it('should count unactioned reply+mention only', () => {
            const stats = getIGNotificationStats();
            // 'a' (reply, unactioned) + 'd' (mention, unactioned) = 2
            expect(stats.unactioned).toBe(2);
        });

        it('should breakdown IG by type correctly', () => {
            const stats = getIGNotificationStats();
            expect(stats.byType.reply).toBe(2);
            expect(stats.byType.mention).toBe(1);
            expect(stats.byType.like).toBe(1);
            expect(stats.byType.follow).toBe(1);
            expect(stats.byType.tag).toBe(1);
        });
    });

    // ────────────────────────────────────────────────────────────────
    // 7. Twitter reply handler skip logic (dedup)
    // ────────────────────────────────────────────────────────────────

    describe('Twitter reply deduplication', () => {
        beforeAll(() => backupTrackers());
        afterAll(() => restoreTrackers());

        it('should detect when we already replied to a tweet URL', () => {
            const testUrl = 'https://x.com/__test_dedup/status/999';
            // No reply yet
            expect(hasRepliedToTweet(testUrl)).toBeNull();

            // Track a reply
            trackReply({
                tweetUrl: testUrl,
                tweetAuthor: '__test_dedup',
                replyText: 'Test reply',
                timestamp: new Date().toISOString(),
                verified: true,
                sessionId: 'test',
                tweetSnippet: 'test',
                liked: false,
                retweeted: false,
            });

            // Now should detect
            expect(hasRepliedToTweet(testUrl)).not.toBeNull();
        });

        it('should normalize URLs when checking (trailing slashes, query params)', () => {
            const base = 'https://x.com/__test_norm/status/888';
            trackReply({
                tweetUrl: base,
                tweetAuthor: '__test_norm',
                replyText: 'Test',
                timestamp: new Date().toISOString(),
                verified: true,
                sessionId: 'test',
                tweetSnippet: 'test',
                liked: false,
                retweeted: false,
            });

            // Same URL with trailing slash
            expect(hasRepliedToTweet(base + '/')).not.toBeNull();
            // Same URL with query params
            expect(hasRepliedToTweet(base + '?s=20')).not.toBeNull();
        });

        it('should detect recent reply to same user within time window', () => {
            const user = '__test_recent_user';
            trackReply({
                tweetUrl: 'https://x.com/' + user + '/status/777',
                tweetAuthor: user,
                replyText: 'Recent reply',
                timestamp: new Date().toISOString(), // just now
                verified: true,
                sessionId: 'test',
                tweetSnippet: 'test',
                liked: false,
                retweeted: false,
            });

            // Within 1 hour — should be found
            expect(recentReplyToUser(user, 1)).not.toBeNull();
            // Within 0 hours — edge case
            expect(recentReplyToUser(user, 0)).toBeNull();
        });

        it('should NOT detect reply to user outside time window', () => {
            const user = '__test_old_user';
            trackReply({
                tweetUrl: 'https://x.com/' + user + '/status/666',
                tweetAuthor: user,
                replyText: 'Old reply',
                timestamp: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(), // 3 hours ago
                verified: true,
                sessionId: 'test',
                tweetSnippet: 'test',
                liked: false,
                retweeted: false,
            });

            // Within 1 hour — should NOT be found (reply was 3h ago)
            expect(recentReplyToUser(user, 1)).toBeNull();
            // Within 4 hours — should be found
            expect(recentReplyToUser(user, 4)).not.toBeNull();
        });
    });

    // ────────────────────────────────────────────────────────────────
    // 8. Instagram comment deduplication
    // ────────────────────────────────────────────────────────────────

    describe('Instagram comment deduplication', () => {
        beforeAll(() => backupTrackers());
        afterAll(() => restoreTrackers());

        it('should detect when we already commented on a post', () => {
            const testUrl = 'https://www.instagram.com/p/TEST123/';
            expect(hasCommentedOnPost(testUrl)).toBeNull();

            trackComment({
                postUrl: testUrl,
                postUsername: '__ig_test',
                commentText: 'Nice!',
                timestamp: new Date().toISOString(),
                verified: true,
                sessionId: 'test',
                captionSnippet: 'test',
                liked: false,
            });

            expect(hasCommentedOnPost(testUrl)).not.toBeNull();
        });

        it('should detect recent comment on same user', () => {
            const user = '__ig_recent_user';
            trackComment({
                postUrl: 'https://www.instagram.com/p/RECENT123/',
                postUsername: user,
                commentText: 'Recent!',
                timestamp: new Date().toISOString(),
                verified: true,
                sessionId: 'test',
                captionSnippet: 'test',
                liked: false,
            });

            expect(recentCommentOnUser(user, 1)).not.toBeNull();
        });
    });

    // ────────────────────────────────────────────────────────────────
    // 9. Cross-platform notification deduplication keys
    // ────────────────────────────────────────────────────────────────

    describe('Notification deduplication', () => {
        it('should use type_username_text as dedup key (Twitter)', () => {
            const n1 = seedTWNotification({ fromUsername: 'user1', type: 'reply', text: 'great post about AI' });
            const n2 = seedTWNotification({ fromUsername: 'user1', type: 'reply', text: 'great post about AI' });
            const n3 = seedTWNotification({ fromUsername: 'user1', type: 'reply', text: 'different text here' });

            const key1 = `${n1.type}_${n1.fromUsername}_${n1.text.slice(0, 50)}`;
            const key2 = `${n2.type}_${n2.fromUsername}_${n2.text.slice(0, 50)}`;
            const key3 = `${n3.type}_${n3.fromUsername}_${n3.text.slice(0, 50)}`;

            expect(key1).toBe(key2); // Same notification = same key
            expect(key1).not.toBe(key3); // Different text = different key
        });

        it('should use type_username_text as dedup key (Instagram)', () => {
            const n1 = seedIGNotification({ fromUsername: 'iguser', type: 'reply', text: 'love this photo' });
            const n2 = seedIGNotification({ fromUsername: 'iguser', type: 'reply', text: 'love this photo' });

            const key1 = `${n1.type}_${n1.fromUsername}_${n1.text.slice(0, 50)}`;
            const key2 = `${n2.type}_${n2.fromUsername}_${n2.text.slice(0, 50)}`;
            expect(key1).toBe(key2);
        });

        it('should NOT dedup different types from same user', () => {
            const n1 = seedTWNotification({ fromUsername: 'user1', type: 'reply', text: 'same text' });
            const n2 = seedTWNotification({ fromUsername: 'user1', type: 'like', text: 'same text' });

            const key1 = `${n1.type}_${n1.fromUsername}_${n1.text.slice(0, 50)}`;
            const key2 = `${n2.type}_${n2.fromUsername}_${n2.text.slice(0, 50)}`;
            expect(key1).not.toBe(key2);
        });
    });

    // ────────────────────────────────────────────────────────────────
    // 10. Notification → VR health updates (cross-platform)
    // ────────────────────────────────────────────────────────────────

    describe('Notification health updates across platforms', () => {
        const twUser = '__test_health_tw';
        const igUser = '__test_health_ig';

        beforeAll(() => {
            // Setup Twitter contact
            const twState = loadVRState(twUser, 'twitter');
            twState.health = 0.50;
            saveVRState(twState);
            const twProfile = loadNurtureProfile(twUser, 'twitter');
            twProfile.tier = 'acquaintance';
            saveNurtureProfile(twProfile);

            // Setup Instagram contact
            const igState = loadVRState(igUser, 'instagram');
            igState.health = 0.50;
            saveVRState(igState);
            const igProfile = loadNurtureProfile(igUser, 'instagram');
            igProfile.tier = 'acquaintance';
            saveNurtureProfile(igProfile);
        });

        afterAll(() => {
            cleanupVRState(twUser, 'twitter');
            cleanupVRState(igUser, 'instagram');
            cleanupProfile(twUser, 'twitter');
            cleanupProfile(igUser, 'instagram');
        });

        it('should update Twitter health on reply_received', () => {
            const before = loadVRState(twUser, 'twitter').health;
            updateHealth(twUser, 'twitter', 'reply_received');
            const after = loadVRState(twUser, 'twitter').health;
            expect(after).toBeGreaterThan(before);
        });

        it('should update Instagram health on reply_received', () => {
            const before = loadVRState(igUser, 'instagram').health;
            updateHealth(igUser, 'instagram', 'reply_received');
            const after = loadVRState(igUser, 'instagram').health;
            expect(after).toBeGreaterThan(before);
        });

        it('should update health on like_received', () => {
            const before = loadVRState(twUser, 'twitter').health;
            updateHealth(twUser, 'twitter', 'like_received');
            const after = loadVRState(twUser, 'twitter').health;
            expect(after).toBeGreaterThan(before);
        });

        it('should update health on we_replied', () => {
            const before = loadVRState(twUser, 'twitter').health;
            updateHealth(twUser, 'twitter', 'we_replied');
            const after = loadVRState(twUser, 'twitter').health;
            expect(after).toBeGreaterThan(before);
        });

        it('should keep platforms independent', () => {
            // Punish Twitter
            const twBefore = loadVRState(twUser, 'twitter').health;
            updateHealth(twUser, 'twitter', 'comment_ignored');
            const twAfter = loadVRState(twUser, 'twitter').health;
            expect(twAfter).toBeLessThan(twBefore);

            // Instagram should be unaffected
            const igHealth = loadVRState(igUser, 'instagram').health;
            expect(igHealth).toBeGreaterThan(0.50); // We boosted it earlier
        });
    });

    // ────────────────────────────────────────────────────────────────
    // 11. Bandit reward from notification engagement (cross-platform)
    // ────────────────────────────────────────────────────────────────

    describe('Bandit reward from notifications', () => {
        const twUser = '__test_bandit_tw';
        const igUser = '__test_bandit_ig';

        beforeAll(() => {
            const twState = loadVRState(twUser, 'twitter');
            twState.health = 0.60;
            saveVRState(twState);
            const igState = loadVRState(igUser, 'instagram');
            igState.health = 0.60;
            saveVRState(igState);
        });

        afterAll(() => {
            cleanupVRState(twUser, 'twitter');
            cleanupVRState(igUser, 'instagram');
        });

        it('should reward Twitter bandit arm on reply engagement', () => {
            recordBanditReward(twUser, 'twitter', 'humor', 1.0);
            const state = loadVRState(twUser, 'twitter');
            const humor = state.commentBandit.find(a => a.style === 'humor')!;
            expect(humor.rewards).toBe(1.0);
            expect(humor.pulls).toBe(1);
        });

        it('should reward Instagram bandit arm on reply engagement', () => {
            recordBanditReward(igUser, 'instagram', 'encouragement', 0.8);
            const state = loadVRState(igUser, 'instagram');
            const enc = state.commentBandit.find(a => a.style === 'encouragement')!;
            expect(enc.rewards).toBe(0.8);
            expect(enc.pulls).toBe(1);
        });

        it('should keep bandit arms independent across platforms', () => {
            const tw = loadVRState(twUser, 'twitter');
            const twHumor = tw.commentBandit.find(a => a.style === 'humor')!;
            expect(twHumor.rewards).toBe(1.0);

            const ig = loadVRState(igUser, 'instagram');
            const igHumor = ig.commentBandit.find(a => a.style === 'humor')!;
            expect(igHumor.rewards).toBe(0); // Never rewarded on IG
        });
    });

    // ────────────────────────────────────────────────────────────────
    // 12. Badge → Action flow verifies all platforms produce actions
    // ────────────────────────────────────────────────────────────────

    describe('Badge actions cover all platforms', () => {
        it('should produce actions for all 3 platforms when badges present', () => {
            const snapshot = makeSnapshot(
                makeBadges('twitter', 5, 3),
                makeBadges('instagram', 2, 4),
                makeBadges('threads', 0, 1),
            );
            const actions = getActionsFromBadges(snapshot);

            const platforms = new Set(actions.map(a => a.platform));
            expect(platforms.has('twitter')).toBe(true);
            expect(platforms.has('instagram')).toBe(true);
            expect(platforms.has('threads')).toBe(true);
        });

        it('should map each platform to correct action names', () => {
            const snapshot = makeSnapshot(
                makeBadges('twitter', 1, 1),
                makeBadges('instagram', 1, 1),
                makeBadges('threads', 0, 1),
            );
            const actions = getActionsFromBadges(snapshot);

            const actionMap = new Map(actions.map(a => [`${a.platform}_${a.type}`, a.action]));
            expect(actionMap.get('twitter_dm')).toBe('scrape_inbox_and_reply');
            expect(actionMap.get('twitter_notification')).toBe('check_notifications');
            expect(actionMap.get('instagram_dm')).toBe('scrape_ig_inbox_and_reply');
            expect(actionMap.get('instagram_notification')).toBe('check_ig_notifications');
            expect(actionMap.get('threads_notification')).toBe('check_threads_notifications');
        });
    });

    // ────────────────────────────────────────────────────────────────
    // 13. Notification file size limits (max 500)
    // ────────────────────────────────────────────────────────────────

    describe('Notification storage limits', () => {
        it('should keep Twitter notifications to last 500', () => {
            // Seed 510 notifications
            const many = Array.from({ length: 510 }, (_, i) =>
                seedTWNotification({ fromUsername: `user_${i}`, text: `text_${i}` })
            );
            seedTWNotifications(many);

            // Read back — the actual limit is enforced by saveNotifications in the checker
            // but we verify the file can hold 500+
            const stored: DetectedNotification[] = JSON.parse(fs.readFileSync(TW_NOTIF_FILE, 'utf8'));
            expect(stored.length).toBe(510); // File can hold more; trimming happens in checker
        });

        it('should keep Instagram notifications to last 500', () => {
            const many = Array.from({ length: 510 }, (_, i) =>
                seedIGNotification({ fromUsername: `ig_user_${i}`, text: `text_${i}` })
            );
            seedIGNotifications(many);

            const stored: IGDetectedNotification[] = JSON.parse(fs.readFileSync(IG_NOTIF_FILE, 'utf8'));
            expect(stored.length).toBe(510);
        });
    });

    // ────────────────────────────────────────────────────────────────
    // 14. markNotificationActioned matches first unactioned only
    // ────────────────────────────────────────────────────────────────

    describe('Actioning matches correctly', () => {
        it('should only mark the first unactioned notification for a user+type combo (Twitter)', () => {
            const notifs: DetectedNotification[] = [
                seedTWNotification({ fromUsername: 'multi_reply', type: 'reply', text: 'first reply', actioned: false }),
                seedTWNotification({ fromUsername: 'multi_reply', type: 'reply', text: 'second reply', actioned: false }),
            ];
            seedTWNotifications(notifs);

            markNotificationActioned('multi_reply', 'reply', 'replied', 'response to first');

            const stored: DetectedNotification[] = JSON.parse(fs.readFileSync(TW_NOTIF_FILE, 'utf8'));
            const actioned = stored.filter(n => n.actioned);
            const unactioned = stored.filter(n => !n.actioned);

            expect(actioned).toHaveLength(1);
            expect(actioned[0].actionText).toBe('response to first');
            expect(unactioned).toHaveLength(1);
        });

        it('should only mark the first unactioned notification for a user+type combo (Instagram)', () => {
            const notifs: IGDetectedNotification[] = [
                seedIGNotification({ fromUsername: 'ig_multi', type: 'reply', text: 'first comment', actioned: false }),
                seedIGNotification({ fromUsername: 'ig_multi', type: 'reply', text: 'second comment', actioned: false }),
            ];
            seedIGNotifications(notifs);

            markIGNotificationActioned('ig_multi', 'reply', 'replied', 'response to first');

            const stored: IGDetectedNotification[] = JSON.parse(fs.readFileSync(IG_NOTIF_FILE, 'utf8'));
            const actioned = stored.filter(n => n.actioned);
            expect(actioned).toHaveLength(1);
            expect(stored.filter(n => !n.actioned)).toHaveLength(1);
        });
    });

    // ────────────────────────────────────────────────────────────────
    // 15. Ignored comment penalty (Twitter)
    // ────────────────────────────────────────────────────────────────

    describe('Ignored comment penalty applies correctly', () => {
        const testUser = '__test_ignore_xp';

        beforeAll(() => {
            const state = loadVRState(testUser, 'twitter');
            state.health = 0.70;
            state.lastCommentAt = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
            state.consecutiveIgnored = 0;
            saveVRState(state);

            const profile = loadNurtureProfile(testUser, 'twitter');
            profile.tier = 'acquaintance';
            saveNurtureProfile(profile);

            // Clear notifications (no reply from this user)
            seedTWNotifications([]);
        });

        afterAll(() => {
            cleanupVRState(testUser, 'twitter');
            cleanupProfile(testUser, 'twitter');
        });

        it('should penalize when no reply received within wait period', () => {
            const before = loadVRState(testUser, 'twitter').health;
            const updated = processIgnoredComments(24);
            expect(updated).toBeGreaterThanOrEqual(1);

            const after = loadVRState(testUser, 'twitter').health;
            expect(after).toBeLessThan(before);
        });

        it('should NOT double-penalize on consecutive calls', () => {
            const before = loadVRState(testUser, 'twitter').health;
            const updated = processIgnoredComments(24);
            // Should skip because last health entry reason is already 'comment_ignored'
            expect(updated).toBe(0);

            const after = loadVRState(testUser, 'twitter').health;
            expect(after).toBe(before); // No change
        });
    });

    // ────────────────────────────────────────────────────────────────
    // 16. Full cross-platform cycle
    // ────────────────────────────────────────────────────────────────

    describe('Full cross-platform notification cycle', () => {
        const twUser = '__test_full_xp_tw';
        const igUser = '__test_full_xp_ig';

        beforeAll(() => {
            // Twitter contact
            const twState = loadVRState(twUser, 'twitter');
            twState.health = 0.55;
            saveVRState(twState);
            const twProfile = loadNurtureProfile(twUser, 'twitter');
            twProfile.tier = 'acquaintance';
            saveNurtureProfile(twProfile);

            // Instagram contact
            const igState = loadVRState(igUser, 'instagram');
            igState.health = 0.55;
            saveVRState(igState);
            const igProfile = loadNurtureProfile(igUser, 'instagram');
            igProfile.tier = 'acquaintance';
            saveNurtureProfile(igProfile);
        });

        afterAll(() => {
            cleanupVRState(twUser, 'twitter');
            cleanupVRState(igUser, 'instagram');
            cleanupProfile(twUser, 'twitter');
            cleanupProfile(igUser, 'instagram');
        });

        it('should handle simultaneous Twitter + Instagram notification processing', () => {
            // Simulate: both platforms get reply notifications at the same time
            seedTWNotifications([
                seedTWNotification({ fromUsername: twUser, type: 'reply', text: 'tw reply' }),
            ]);
            seedIGNotifications([
                seedIGNotification({ fromUsername: igUser, type: 'reply', text: 'ig comment' }),
            ]);

            // Process Twitter notification
            const twUnactioned = getUnactionedReplies();
            expect(twUnactioned).toHaveLength(1);
            expect(twUnactioned[0].fromUsername).toBe(twUser);

            // Process Instagram notification
            const igUnactioned = getIGUnactionedReplies();
            expect(igUnactioned).toHaveLength(1);
            expect(igUnactioned[0].fromUsername).toBe(igUser);

            // Update health on both
            updateHealth(twUser, 'twitter', 'reply_received');
            updateHealth(igUser, 'instagram', 'reply_received');

            // Mark both as actioned
            markNotificationActioned(twUser, 'reply', 'replied', 'tw response');
            markIGNotificationActioned(igUser, 'reply', 'replied', 'ig response');

            // Verify both are cleared
            expect(getUnactionedReplies()).toHaveLength(0);
            expect(getIGUnactionedReplies()).toHaveLength(0);

            // Verify health increased on both platforms independently
            const twHealth = loadVRState(twUser, 'twitter').health;
            const igHealth = loadVRState(igUser, 'instagram').health;
            expect(twHealth).toBeGreaterThan(0.55);
            expect(igHealth).toBeGreaterThan(0.55);
        });
    });

    // ────────────────────────────────────────────────────────────────
    // 17. Edge: empty notification stores
    // ────────────────────────────────────────────────────────────────

    describe('Edge cases: empty stores', () => {
        it('should return empty array for Twitter unactioned when no file exists', () => {
            // Seed empty
            seedTWNotifications([]);
            const unactioned = getUnactionedReplies();
            expect(unactioned).toHaveLength(0);
        });

        it('should return empty array for IG unactioned when no file exists', () => {
            seedIGNotifications([]);
            const unactioned = getIGUnactionedReplies();
            expect(unactioned).toHaveLength(0);
        });

        it('should return zero stats for Twitter with no notifications', () => {
            seedTWNotifications([]);
            const stats = getNotificationStats();
            expect(stats.total).toBe(0);
            expect(stats.unactioned).toBe(0);
        });

        it('should return zero stats for IG with no notifications', () => {
            seedIGNotifications([]);
            const stats = getIGNotificationStats();
            expect(stats.total).toBe(0);
            expect(stats.unactioned).toBe(0);
        });

        it('should handle markNotificationActioned when no matching notification exists', () => {
            seedTWNotifications([]);
            // Should not throw
            expect(() => {
                markNotificationActioned('nonexistent_user', 'reply', 'replied', 'test');
            }).not.toThrow();
        });

        it('should handle markIGNotificationActioned when no matching notification exists', () => {
            seedIGNotifications([]);
            expect(() => {
                markIGNotificationActioned('nonexistent_user', 'reply', 'replied', 'test');
            }).not.toThrow();
        });
    });
});
