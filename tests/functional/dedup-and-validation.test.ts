/**
 * Tests for DM deduplication, username validation, and race condition prevention.
 *
 * Covers:
 * - isValidUsername: blocks UI labels, short junk, invalid formats
 * - hasContactedToday / hasContactedTwitterToday: unified dedup across sent + pending
 * - getReadyReplies: atomic claim (pending → sending) prevents concurrent sends
 * - isLikelyBot: cross-platform bot filtering
 */

import { isLikelyBot, isValidUsername } from '../../src/client/Instagram-DM-Pipeline';
import { hasContactedToday } from '../../src/tracking/dmTracker';
import { hasContactedTwitterToday } from '../../src/tracking/twitterDMTracker';
import {
    hasPendingReply, scheduleDelayedReply, getReadyReplies,
    markReplySent, markReplyFailed, cleanupDelayedQueue,
} from '../../src/nurture/vi-delays';
import * as fs from 'fs';
import * as path from 'path';

// ── Test helpers ────────────────────────────────────────────────────

const TEST_QUEUE_FILE = path.join(process.cwd(), 'logs', 'tracking', 'nurture', 'delayed-replies.json');

function backupAndClearQueue() {
    let backup: any[] = [];
    try {
        backup = JSON.parse(fs.readFileSync(TEST_QUEUE_FILE, 'utf8'));
    } catch { /* no file */ }
    return backup;
}

function restoreQueue(backup: any[]) {
    const dir = path.dirname(TEST_QUEUE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(TEST_QUEUE_FILE, JSON.stringify(backup, null, 2));
}

// ── Username Validation ─────────────────────────────────────────────

describe('isValidUsername', () => {
    it('should accept valid Twitter handles', () => {
        expect(isValidUsername('dvassallo').valid).toBe(true);
        expect(isValidUsername('OpenAI').valid).toBe(true);
        expect(isValidUsername('the_isaiah_dupree').valid).toBe(true);
        expect(isValidUsername('user123').valid).toBe(true);
    });

    it('should accept valid Instagram handles', () => {
        expect(isValidUsername('deeprag.ai').valid).toBe(true);
        expect(isValidUsername('talktomay').valid).toBe(true);
        expect(isValidUsername('angus.sewell').valid).toBe(true);
    });

    it('should reject empty/null usernames', () => {
        expect(isValidUsername('').valid).toBe(false);
        expect(isValidUsername('  ').valid).toBe(false);
    });

    it('should reject UI labels that are not real users', () => {
        const uiLabels = ['chat', 'search', 'all', 'requests', 'messages',
            'compose', 'home', 'explore', 'notifications', 'settings',
            'primary', 'general', 'inbox', 'direct', 'unread'];
        for (const label of uiLabels) {
            const result = isValidUsername(label);
            expect(result.valid).toBe(false);
            expect(result.reason).toContain('UI label');
        }
    });

    it('should reject UI labels case-insensitively', () => {
        expect(isValidUsername('Chat').valid).toBe(false);
        expect(isValidUsername('SEARCH').valid).toBe(false);
        expect(isValidUsername('Messages').valid).toBe(false);
    });

    it('should reject all-numeric usernames', () => {
        expect(isValidUsername('12345').valid).toBe(false);
        expect(isValidUsername('0').valid).toBe(false);
    });

    it('should reject time indicators', () => {
        expect(isValidUsername('2h').valid).toBe(false);
        expect(isValidUsername('30m').valid).toBe(false);
        expect(isValidUsername('1d').valid).toBe(false);
    });

    it('should reject very long strings', () => {
        expect(isValidUsername('a'.repeat(31)).valid).toBe(false);
    });

    it('should strip @ prefix before validation', () => {
        expect(isValidUsername('@dvassallo').valid).toBe(true);
        expect(isValidUsername('@chat').valid).toBe(false);
    });
});

// ── Bot Detection ───────────────────────────────────────────────────

describe('isLikelyBot', () => {
    it('should detect link spam', () => {
        expect(isLikelyBot('Check this out http://spam.com', 'spammer').isBot).toBe(true);
        expect(isLikelyBot('Visit bit.ly/free', 'spammer').isBot).toBe(true);
    });

    it('should detect automated welcome messages', () => {
        expect(isLikelyBot('Thanks for connecting! Download my free ebook', 'coach123').isBot).toBe(true);
    });

    it('should pass genuine conversation messages', () => {
        expect(isLikelyBot('Hey! I loved your recent tweet about AI', 'realuser').isBot).toBe(false);
        expect(isLikelyBot('That makes sense, thanks for explaining', 'friend').isBot).toBe(false);
    });
});

// ── Delayed Reply Queue (Race Condition Prevention) ─────────────────

describe('Delayed reply queue (atomic claim)', () => {
    let originalQueue: any[];

    beforeAll(() => {
        originalQueue = backupAndClearQueue();
    });

    afterAll(() => {
        restoreQueue(originalQueue);
    });

    beforeEach(() => {
        // Clear queue before each test
        const dir = path.dirname(TEST_QUEUE_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(TEST_QUEUE_FILE, '[]');
    });

    it('should schedule a delayed reply', () => {
        const id = scheduleDelayedReply({
            username: 'testuser',
            platform: 'twitter',
            replyMessage: 'Hello!',
            sendAfter: new Date(Date.now() - 1000).toISOString(), // Already ready
            context: {
                relationship: { warmth: 50, stage: 'building', category: 'personal', tags: [], notes: [], lastInteraction: '' },
                objective: 'test',
                isJackpot: false,
            },
        });
        expect(id).toBeTruthy();
        expect(hasPendingReply('testuser', 'twitter')).toBe(true);
    });

    it('should mark ready replies as "sending" atomically', () => {
        // Schedule a reply that's already past due
        scheduleDelayedReply({
            username: 'atomictest',
            platform: 'twitter',
            replyMessage: 'Test message',
            sendAfter: new Date(Date.now() - 5000).toISOString(),
            context: {
                relationship: { warmth: 50, stage: 'building', category: 'personal', tags: [], notes: [], lastInteraction: '' },
                objective: 'test',
                isJackpot: false,
            },
        });

        // First call should claim the entry
        const ready1 = getReadyReplies('twitter');
        expect(ready1.length).toBe(1);
        expect(ready1[0].username).toBe('atomictest');

        // Second call should return EMPTY — entry is now "sending"
        const ready2 = getReadyReplies('twitter');
        expect(ready2.length).toBe(0);
    });

    it('should still show "sending" entries as pending for dedup', () => {
        scheduleDelayedReply({
            username: 'deduptest',
            platform: 'instagram',
            replyMessage: 'Hi there!',
            sendAfter: new Date(Date.now() - 1000).toISOString(),
            context: {
                relationship: { warmth: 30, stage: 'initial_contact', category: 'personal', tags: [], notes: [], lastInteraction: '' },
                objective: 'test',
                isJackpot: false,
            },
        });

        // Claim the reply (moves to "sending")
        getReadyReplies('instagram');

        // hasPendingReply should still return true (prevents double-scheduling)
        expect(hasPendingReply('deduptest', 'instagram')).toBe(true);
    });

    it('should allow markReplySent after claiming', () => {
        scheduleDelayedReply({
            username: 'senttest',
            platform: 'twitter',
            replyMessage: 'Done!',
            sendAfter: new Date(Date.now() - 1000).toISOString(),
            context: {
                relationship: { warmth: 70, stage: 'warm', category: 'personal', tags: [], notes: [], lastInteraction: '' },
                objective: 'test',
                isJackpot: false,
            },
        });

        const ready = getReadyReplies('twitter');
        expect(ready.length).toBe(1);

        markReplySent(ready[0].id);

        // Should no longer be pending
        expect(hasPendingReply('senttest', 'twitter')).toBe(false);
    });

    it('should allow markReplyFailed after claiming', () => {
        scheduleDelayedReply({
            username: 'failtest',
            platform: 'twitter',
            replyMessage: 'Will fail',
            sendAfter: new Date(Date.now() - 1000).toISOString(),
            context: {
                relationship: { warmth: 20, stage: 'cold_outreach', category: 'personal', tags: [], notes: [], lastInteraction: '' },
                objective: 'test',
                isJackpot: false,
            },
        });

        const ready = getReadyReplies('twitter');
        markReplyFailed(ready[0].id, 'Thread not found');

        // Should no longer be pending
        expect(hasPendingReply('failtest', 'twitter')).toBe(false);
    });

    it('should not pick up future-scheduled replies', () => {
        scheduleDelayedReply({
            username: 'futuretest',
            platform: 'twitter',
            replyMessage: 'Not yet!',
            sendAfter: new Date(Date.now() + 3600000).toISOString(), // 1 hour from now
            context: {
                relationship: { warmth: 40, stage: 'building', category: 'personal', tags: [], notes: [], lastInteraction: '' },
                objective: 'test',
                isJackpot: false,
            },
        });

        const ready = getReadyReplies('twitter');
        expect(ready.length).toBe(0);

        // But should still show as pending for dedup
        expect(hasPendingReply('futuretest', 'twitter')).toBe(true);
    });

    it('should prevent double-scheduling for same user', () => {
        scheduleDelayedReply({
            username: 'doubleschedule',
            platform: 'instagram',
            replyMessage: 'First reply',
            sendAfter: new Date(Date.now() + 60000).toISOString(),
            context: {
                relationship: { warmth: 50, stage: 'building', category: 'personal', tags: [], notes: [], lastInteraction: '' },
                objective: 'test',
                isJackpot: false,
            },
        });

        // Checking hasPendingReply should prevent a second schedule
        expect(hasPendingReply('doubleschedule', 'instagram')).toBe(true);
    });
});

// ── Contacted Today (Unified Dedup) ─────────────────────────────────

describe('hasContactedToday / hasContactedTwitterToday', () => {
    it('should be exported functions', () => {
        expect(typeof hasContactedToday).toBe('function');
        expect(typeof hasContactedTwitterToday).toBe('function');
    });

    it('should return false for empty username', () => {
        expect(hasContactedToday('')).toBe(false);
        expect(hasContactedTwitterToday('')).toBe(false);
    });

    it('should return false for a user never contacted', () => {
        expect(hasContactedToday('__never_contacted_test_user_12345__')).toBe(false);
        expect(hasContactedTwitterToday('__never_contacted_test_user_12345__')).toBe(false);
    });
});
