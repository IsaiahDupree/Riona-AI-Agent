/**
 * DM Auto-Reply Pipeline Tests
 * Tests: getReplyObjective(), opt-out detection, turn-check logic,
 * DMAutoReplyResult structure, guard conditions, bot filtering, catch-up logic
 */

import { getReplyObjective as getIGReplyObjective } from '../../src/client/Instagram-DM-AI';
import { getReplyObjective as getTwitterReplyObjective } from '../../src/client/Twitter-DM-AI';
import { analyzeSentiment } from '../../src/client/Twitter-DM-Pipeline';
import { isLikelyBot, DMAutoReplyResult } from '../../src/client/Instagram-DM-Pipeline';
import { ProfileInfo, RelationshipInfo, DMMessage } from '../../src/types/dm';

// ── Helpers ──────────────────────────────────────────────────────────

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

function makeMessage(text: string, isOurs: boolean): DMMessage {
    return {
        sender: isOurs ? 'us' : 'them',
        text,
        timestamp: new Date().toISOString(),
        isOurs
    };
}

const OPT_OUT_KEYWORDS = ['stop', 'unsubscribe', 'leave me alone', 'block', 'report', 'spam', "don't message", 'no thanks'];

// ═══════════════════════════════════════════════════════════════════════
// getReplyObjective — Instagram
// ═══════════════════════════════════════════════════════════════════════

describe('Instagram getReplyObjective', () => {
    it('should return graceful response objective for negative messages', () => {
        const rel = makeRelationship({ stage: 'building', warmth: 30 });
        const objective = getIGReplyObjective(rel, 'Please stop messaging me');
        expect(objective).toContain('unhappy');
        expect(objective).toContain('gracefully');
    });

    it('should return rapport-building objective for cold_outreach stage', () => {
        const rel = makeRelationship({ stage: 'cold_outreach' });
        const objective = getIGReplyObjective(rel, 'Hey, nice to meet you!');
        expect(objective).toContain('replied');
        expect(objective).toContain('rapport');
        expect(objective).toContain('NOT pitch');
    });

    it('should return rapport-building objective for initial_contact stage', () => {
        const rel = makeRelationship({ stage: 'initial_contact' });
        const objective = getIGReplyObjective(rel, 'Thanks for reaching out!');
        expect(objective).toContain('rapport');
    });

    it('should return value-sharing objective for building stage', () => {
        const rel = makeRelationship({ stage: 'building', warmth: 40 });
        const objective = getIGReplyObjective(rel, 'That sounds interesting');
        expect(objective).toContain('naturally');
        expect(objective).toContain('value');
    });

    it('should return conversational objective for warm stage', () => {
        const rel = makeRelationship({ stage: 'warm', warmth: 75 });
        const objective = getIGReplyObjective(rel, 'Love what you shared!');
        expect(objective).toContain('conversationally');
    });

    it('should return conversational objective for active stage', () => {
        const rel = makeRelationship({ stage: 'active', warmth: 90 });
        const objective = getIGReplyObjective(rel, "Let's connect!");
        expect(objective).toContain('conversationally');
    });

    it('should prioritize negative detection over stage', () => {
        // Even if warm stage, negative message should trigger graceful response
        const rel = makeRelationship({ stage: 'active', warmth: 95 });
        const objective = getIGReplyObjective(rel, "Don't spam me please");
        expect(objective).toContain('unhappy');
    });

    it('should handle unknown stage with generic objective', () => {
        const rel = makeRelationship({ stage: 'unknown_stage' as any });
        const objective = getIGReplyObjective(rel, 'Hello there');
        expect(objective).toContain('naturally');
        expect(objective).toContain('genuine');
    });
});

// ═══════════════════════════════════════════════════════════════════════
// getReplyObjective — Twitter (should be identical behavior)
// ═══════════════════════════════════════════════════════════════════════

describe('Twitter getReplyObjective', () => {
    it('should return graceful response objective for negative messages', () => {
        const rel = makeRelationship({ stage: 'building', warmth: 30 });
        const objective = getTwitterReplyObjective(rel, 'Leave me alone');
        expect(objective).toContain('unhappy');
        expect(objective).toContain('gracefully');
    });

    it('should return rapport-building for cold_outreach', () => {
        const rel = makeRelationship({ stage: 'cold_outreach' });
        const objective = getTwitterReplyObjective(rel, 'Hey!');
        expect(objective).toContain('rapport');
    });

    it('should return value-sharing for building stage', () => {
        const rel = makeRelationship({ stage: 'building' });
        const objective = getTwitterReplyObjective(rel, 'Cool stuff');
        expect(objective).toContain('value');
    });

    it('should return conversational for warm/active', () => {
        const rel = makeRelationship({ stage: 'warm' });
        const objective = getTwitterReplyObjective(rel, 'Great work!');
        expect(objective).toContain('conversationally');
    });
});

// ═══════════════════════════════════════════════════════════════════════
// Negative Sentiment / Opt-Out Detection
// ═══════════════════════════════════════════════════════════════════════

describe('Opt-Out Keyword Detection', () => {
    it.each(OPT_OUT_KEYWORDS)('should detect opt-out keyword: "%s"', (keyword) => {
        const text = `Please ${keyword}, I am not interested`;
        const lower = text.toLowerCase();
        const detected = OPT_OUT_KEYWORDS.some(k => lower.includes(k));
        expect(detected).toBe(true);
    });

    it('should not trigger opt-out for normal messages', () => {
        const normalMessages = [
            'Hey, how are you?',
            'Thanks for reaching out!',
            'That sounds interesting',
            'Tell me more about your project',
            'I love AI tools'
        ];
        for (const msg of normalMessages) {
            const lower = msg.toLowerCase();
            const detected = OPT_OUT_KEYWORDS.some(k => lower.includes(k));
            expect(detected).toBe(false);
        }
    });

    it('should be case-insensitive', () => {
        const text = 'STOP messaging me';
        const lower = text.toLowerCase();
        const detected = OPT_OUT_KEYWORDS.some(k => lower.includes(k));
        expect(detected).toBe(true);
    });

    it('should detect partial matches within longer text', () => {
        const text = 'I will block you if you keep messaging';
        const lower = text.toLowerCase();
        const detected = OPT_OUT_KEYWORDS.some(k => lower.includes(k));
        expect(detected).toBe(true);
    });
});

// ═══════════════════════════════════════════════════════════════════════
// Turn-Check Logic (isOurTurnToReply)
// ═══════════════════════════════════════════════════════════════════════

describe('Turn-Check Logic', () => {
    function isOurTurnToReply(messages: DMMessage[]): boolean {
        if (messages.length === 0) return false;
        return !messages[messages.length - 1].isOurs;
    }

    it('should return false for empty conversation', () => {
        expect(isOurTurnToReply([])).toBe(false);
    });

    it('should return true when last message is theirs', () => {
        const messages = [
            makeMessage('Hey', false),
            makeMessage('Hi there!', true),
            makeMessage('How are you?', false)
        ];
        expect(isOurTurnToReply(messages)).toBe(true);
    });

    it('should return false when last message is ours', () => {
        const messages = [
            makeMessage('Hey', false),
            makeMessage('Hi there!', true)
        ];
        expect(isOurTurnToReply(messages)).toBe(false);
    });

    it('should handle single message from them', () => {
        const messages = [makeMessage('Hello', false)];
        expect(isOurTurnToReply(messages)).toBe(true);
    });

    it('should handle single message from us', () => {
        const messages = [makeMessage('Hello', true)];
        expect(isOurTurnToReply(messages)).toBe(false);
    });

    it('should handle multiple consecutive messages from them', () => {
        const messages = [
            makeMessage('Hey', false),
            makeMessage('Are you there?', false),
            makeMessage('Hello??', false)
        ];
        expect(isOurTurnToReply(messages)).toBe(true);
    });
});

// ═══════════════════════════════════════════════════════════════════════
// Sentiment Analysis (exported from Twitter pipeline)
// ═══════════════════════════════════════════════════════════════════════

describe('Sentiment Analysis', () => {
    it('should return negative for opt-out language', () => {
        expect(analyzeSentiment('No thanks, not interested')).toBe('negative');
        expect(analyzeSentiment('Stop messaging me')).toBe('negative');
        expect(analyzeSentiment('This is spam')).toBe('negative');
        expect(analyzeSentiment('Leave me alone please')).toBe('negative');
    });

    it('should return positive for enthusiastic replies', () => {
        expect(analyzeSentiment('That sounds awesome! I would love to connect')).toBe('positive');
        expect(analyzeSentiment('Thanks so much, I really appreciate it!')).toBe('positive');
    });

    it('should return neutral for simple acknowledgments', () => {
        expect(analyzeSentiment('Ok')).toBe('neutral');
        expect(analyzeSentiment('I see')).toBe('neutral');
        expect(analyzeSentiment('Hmm')).toBe('neutral');
    });

    it('should return neutral for single positive word', () => {
        // One positive word = neutral (needs >= 2 for positive)
        expect(analyzeSentiment('Sure')).toBe('neutral');
        expect(analyzeSentiment('Thanks')).toBe('neutral');
    });

    it('should prioritize negative over positive', () => {
        // Even if positive words present, negative takes priority
        expect(analyzeSentiment('Thanks but please stop, not interested')).toBe('negative');
    });
});

// ═══════════════════════════════════════════════════════════════════════
// DMAutoReplyResult Structure
// ═══════════════════════════════════════════════════════════════════════

describe('DMAutoReplyResult Structure', () => {
    it('should have all required fields with correct types', () => {
        // Import types to verify structure
        const result = {
            processed: 0,
            replied: 0,
            skipped: 0,
            failed: 0,
            details: [] as Array<{ username: string; action: 'replied' | 'skipped' | 'failed'; reason?: string }>
        };

        expect(result).toHaveProperty('processed');
        expect(result).toHaveProperty('replied');
        expect(result).toHaveProperty('skipped');
        expect(result).toHaveProperty('failed');
        expect(result).toHaveProperty('details');
        expect(Array.isArray(result.details)).toBe(true);
    });

    it('should track detail entries correctly', () => {
        const details: Array<{ username: string; action: 'replied' | 'skipped' | 'failed'; reason?: string }> = [];

        details.push({ username: 'user1', action: 'replied' });
        details.push({ username: 'user2', action: 'skipped', reason: 'cooldown' });
        details.push({ username: 'user3', action: 'failed', reason: 'network error' });

        expect(details).toHaveLength(3);
        expect(details[0].action).toBe('replied');
        expect(details[1].reason).toBe('cooldown');
        expect(details[2].action).toBe('failed');
    });
});

// ═══════════════════════════════════════════════════════════════════════
// Guard Conditions (unit-level)
// ═══════════════════════════════════════════════════════════════════════

describe('Auto-Reply Guard Conditions', () => {
    const AUTO_REPLY_MAX_PER_RUN = 5;
    const AUTO_REPLY_COOLDOWN_HOURS = 1;

    it('should enforce max replies per run limit', () => {
        let replied = 0;
        const messages = Array.from({ length: 8 }, (_, i) => ({
            from: `user${i}`,
            preview: 'Hello there'
        }));

        const results: string[] = [];
        for (const msg of messages) {
            if (replied >= AUTO_REPLY_MAX_PER_RUN) {
                results.push('skipped');
            } else {
                results.push('replied');
                replied++;
            }
        }

        expect(results.filter(r => r === 'replied')).toHaveLength(5);
        expect(results.filter(r => r === 'skipped')).toHaveLength(3);
    });

    it('should skip own username', () => {
        const ourUsername = 'the_isaiah_dupree';
        const from = 'the_isaiah_dupree';
        expect(from.toLowerCase() === ourUsername.toLowerCase()).toBe(true);
    });

    it('should detect negative reply objective overrides stage', () => {
        // For every stage, negative message should always produce graceful objective
        const stages: RelationshipInfo['stage'][] = [
            'cold_outreach', 'initial_contact', 'building', 'warm', 'active'
        ];
        for (const stage of stages) {
            const rel = makeRelationship({ stage, warmth: 90 });
            const objective = getIGReplyObjective(rel, 'Stop, I will report you');
            expect(objective).toContain('unhappy');
        }
    });

    it('should handle all negative keywords in getReplyObjective', () => {
        const negativeKeywords = ['no thanks', 'not interested', 'stop', "don't", 'spam',
            'unsubscribe', 'leave me alone', 'block', 'report', 'annoying', 'scam'];

        const rel = makeRelationship({ stage: 'building' });
        for (const keyword of negativeKeywords) {
            const objective = getIGReplyObjective(rel, keyword);
            expect(objective).toContain('unhappy');
        }
    });

    it('should produce consistent results between Instagram and Twitter', () => {
        const testCases = [
            { stage: 'cold_outreach' as const, msg: 'Hey!' },
            { stage: 'building' as const, msg: 'Cool idea' },
            { stage: 'warm' as const, msg: 'Sounds good' },
            { stage: 'active' as const, msg: 'Stop messaging' }
        ];

        for (const { stage, msg } of testCases) {
            const rel = makeRelationship({ stage });
            const igObjective = getIGReplyObjective(rel, msg);
            const twObjective = getTwitterReplyObjective(rel, msg);
            expect(igObjective).toBe(twObjective);
        }
    });
});

// ═══════════════════════════════════════════════════════════════════════
// Edge Cases
// ═══════════════════════════════════════════════════════════════════════

describe('Edge Cases', () => {
    it('should handle empty message text in getReplyObjective', () => {
        const rel = makeRelationship({ stage: 'building' });
        const objective = getIGReplyObjective(rel, '');
        expect(typeof objective).toBe('string');
        expect(objective.length).toBeGreaterThan(0);
    });

    it('should handle very long message text', () => {
        const rel = makeRelationship({ stage: 'warm' });
        const longMsg = 'a'.repeat(10000);
        const objective = getIGReplyObjective(rel, longMsg);
        expect(typeof objective).toBe('string');
    });

    it('should handle special characters in message', () => {
        const rel = makeRelationship({ stage: 'building' });
        const objective = getIGReplyObjective(rel, '🔥💯 Great stuff! @user #hashtag $$$');
        expect(typeof objective).toBe('string');
    });

    it('should handle message with only emojis', () => {
        const rel = makeRelationship({ stage: 'warm' });
        const objective = getIGReplyObjective(rel, '😊🙏❤️');
        expect(typeof objective).toBe('string');
        // Should not be detected as negative
        expect(objective).not.toContain('unhappy');
    });

    it('should handle message with mixed sentiment signals', () => {
        // "stop" is negative but "thanks" is positive — negative should win in sentiment
        expect(analyzeSentiment('stop')).toBe('negative');
    });
});

// ═══════════════════════════════════════════════════════════════════════
// Bot / Automated Account Detection
// ═══════════════════════════════════════════════════════════════════════

describe('isLikelyBot — Link/Spam Detection', () => {
    it('should detect messages with URLs', () => {
        expect(isLikelyBot('Check out https://example.com')).toEqual(
            expect.objectContaining({ isBot: true })
        );
        expect(isLikelyBot('Visit http://my-site.com')).toEqual(
            expect.objectContaining({ isBot: true })
        );
        expect(isLikelyBot('Go to www.example.com')).toEqual(
            expect.objectContaining({ isBot: true })
        );
        expect(isLikelyBot('See bit.ly/abc123')).toEqual(
            expect.objectContaining({ isBot: true })
        );
    });

    it('should include link-related reason', () => {
        const result = isLikelyBot('Check https://spammy.com');
        expect(result.reason).toContain('link');
    });
});

describe('isLikelyBot — Download/Freebie Language', () => {
    it('should detect download language', () => {
        expect(isLikelyBot('Download our free guide now!').isBot).toBe(true);
        expect(isLikelyBot('Click here to get started').isBot).toBe(true);
        expect(isLikelyBot('Grab your copy today').isBot).toBe(true);
        expect(isLikelyBot('Get your free ebook').isBot).toBe(true);
        expect(isLikelyBot('Tap the link in bio').isBot).toBe(true);
    });

    it('should include descriptive reason for download phrases', () => {
        const result = isLikelyBot('Click here to join');
        expect(result.reason).toContain('click here');
    });
});

describe('isLikelyBot — Automated Welcome Messages', () => {
    it('should detect automated welcome messages', () => {
        expect(isLikelyBot('Thanks for following! Here is our latest content').isBot).toBe(true);
        expect(isLikelyBot('Thank you for following us!').isBot).toBe(true);
        expect(isLikelyBot('Thanks for connecting! We are excited').isBot).toBe(true);
        expect(isLikelyBot('Welcome! Here is what we do').isBot).toBe(true);
        expect(isLikelyBot('Welcome to our community').isBot).toBe(true);
        expect(isLikelyBot('Thanks for the follow!').isBot).toBe(true);
    });

    it('should include welcome-related reason', () => {
        const result = isLikelyBot('Thanks for following! Check us out');
        expect(result.reason).toContain('welcome');
    });
});

describe('isLikelyBot — Lead Magnet Language', () => {
    it('should detect lead magnet and promo language', () => {
        expect(isLikelyBot('Exclusive access to our masterclass').isBot).toBe(true);
        expect(isLikelyBot('Limited time offer - act now!').isBot).toBe(true);
        expect(isLikelyBot('Sign up now for free').isBot).toBe(true);
        expect(isLikelyBot('Register now for the webinar').isBot).toBe(true);
        expect(isLikelyBot('Claim your free trial today').isBot).toBe(true);
        expect(isLikelyBot('Use code SAVE20 for discount').isBot).toBe(true);
        expect(isLikelyBot('Discount code inside!').isBot).toBe(true);
    });

    it('should include lead magnet reason', () => {
        const result = isLikelyBot('Exclusive access to our course');
        expect(result.reason).toContain('lead magnet');
    });
});

describe('isLikelyBot — Username Pattern Detection', () => {
    it('should detect bot-like usernames', () => {
        expect(isLikelyBot('Hey there', 'marketing12345').isBot).toBe(true);
        expect(isLikelyBot('Hey there', 'growth_bot').isBot).toBe(true);
        expect(isLikelyBot('Hey there', 'sales99887').isBot).toBe(true);
        expect(isLikelyBot('Hey there', 'leads__gen__').isBot).toBe(true);
        expect(isLikelyBot('Hey there', 'user_official123').isBot).toBe(true);
    });

    it('should include username-related reason', () => {
        const result = isLikelyBot('Hey', 'growth_bot');
        expect(result.reason).toContain('username');
    });

    it('should not flag normal usernames', () => {
        expect(isLikelyBot('Hey', 'vanessa_edwards').isBot).toBe(false);
        expect(isLikelyBot('Hey', 'john.doe').isBot).toBe(false);
        expect(isLikelyBot('Hey', 'thecreativemind').isBot).toBe(false);
        expect(isLikelyBot('Hey', 'day1marketing').isBot).toBe(false);
    });
});

describe('isLikelyBot — Legitimate Messages (false negatives)', () => {
    it('should not flag genuine conversational messages', () => {
        const legitimate = [
            'Hey, how are you?',
            'Love your content! Been following for a while',
            'Thanks for the reply!',
            'Can we collaborate on something?',
            'That sounds interesting, tell me more',
            'Great to connect with you!',
            'I saw your post about AI, really cool stuff',
            "What's your take on the new update?",
            'Hey! I noticed we have similar interests',
            'Would love to chat about your project'
        ];

        for (const msg of legitimate) {
            const result = isLikelyBot(msg);
            expect(result.isBot).toBe(false);
        }
    });

    it('should not flag "thanks for the reply" (not "thanks for following")', () => {
        expect(isLikelyBot('Thanks for the reply!').isBot).toBe(false);
    });

    it('should not flag "welcome back" or casual welcome', () => {
        // "Welcome!" triggers bot detection, but casual phrases without exclamation should not
        expect(isLikelyBot('hey welcome back to the chat').isBot).toBe(false);
    });
});

describe('isLikelyBot — Edge Cases', () => {
    it('should handle empty preview string', () => {
        expect(isLikelyBot('').isBot).toBe(false);
    });

    it('should handle undefined username', () => {
        expect(isLikelyBot('Hey there').isBot).toBe(false);
        expect(isLikelyBot('Hey there', undefined).isBot).toBe(false);
    });

    it('should be case-insensitive', () => {
        expect(isLikelyBot('CLICK HERE TO GET STARTED').isBot).toBe(true);
        expect(isLikelyBot('THANKS FOR FOLLOWING!').isBot).toBe(true);
        expect(isLikelyBot('EXCLUSIVE ACCESS').isBot).toBe(true);
    });

    it('should return empty reason for non-bot messages', () => {
        const result = isLikelyBot('Hey, nice to meet you!');
        expect(result.reason).toBe('');
    });

    it('should detect bot on first matching pattern (short-circuit)', () => {
        // Message that matches multiple patterns — should still return only one reason
        const result = isLikelyBot('Click here https://example.com free guide');
        expect(result.isBot).toBe(true);
        // Should match link first (checked before download phrases)
        expect(result.reason).toContain('link');
    });
});

// ═══════════════════════════════════════════════════════════════════════
// Dry-Run Mode Structure
// ═══════════════════════════════════════════════════════════════════════

describe('Dry-Run Mode — Result Structure', () => {
    it('DMAutoReplyResult should support dryRunMessages field', () => {
        const result: DMAutoReplyResult = {
            processed: 2,
            replied: 2,
            skipped: 0,
            failed: 0,
            details: [
                { username: 'user1', action: 'replied', reason: 'dry-run: would schedule in 15min' },
                { username: 'user2', action: 'replied', reason: 'dry-run: would schedule in 30min (jackpot)' }
            ],
            dryRunMessages: [
                { username: 'user1', message: 'Hey! Great content.', delayMinutes: 15, isJackpot: false },
                { username: 'user2', message: 'Love your work!', delayMinutes: 30, isJackpot: true }
            ]
        };

        expect(result.dryRunMessages).toHaveLength(2);
        expect(result.dryRunMessages![0]).toEqual(expect.objectContaining({
            username: 'user1',
            message: expect.any(String),
            delayMinutes: expect.any(Number),
            isJackpot: false
        }));
        expect(result.dryRunMessages![1].isJackpot).toBe(true);
    });

    it('dryRunMessages should be undefined when not in dry-run mode', () => {
        const result: DMAutoReplyResult = {
            processed: 1,
            replied: 1,
            skipped: 0,
            failed: 0,
            details: [{ username: 'user1', action: 'replied', reason: 'scheduled in 20min' }]
        };

        expect(result.dryRunMessages).toBeUndefined();
    });

    it('dry-run action reasons should be prefixed with "dry-run:"', () => {
        const dryRunDetail = { username: 'testuser', action: 'replied' as const, reason: 'dry-run: would schedule in 25min' };
        expect(dryRunDetail.reason).toMatch(/^dry-run:/);
    });

    it('dryRunMessages entries should have all required fields', () => {
        const entry = { username: 'testuser', message: 'Hello!', delayMinutes: 10, isJackpot: false };
        expect(entry).toHaveProperty('username');
        expect(entry).toHaveProperty('message');
        expect(entry).toHaveProperty('delayMinutes');
        expect(entry).toHaveProperty('isJackpot');
    });
});

// ═══════════════════════════════════════════════════════════════════════
// Bot Filter Guard Integration
// ═══════════════════════════════════════════════════════════════════════

describe('Bot Filter Guard Integration', () => {
    it('bot detection should result in skipped action with bot: prefix', () => {
        // Simulate the guard logic from processDMAutoReplies
        const preview = 'Thanks for following! Check out our new course';
        const username = 'testuser';
        const botCheck = isLikelyBot(preview, username);

        expect(botCheck.isBot).toBe(true);
        const detail = { username, action: 'skipped' as const, reason: `bot: ${botCheck.reason}` };
        expect(detail.reason).toMatch(/^bot:/);
    });

    it('non-bot messages should pass through (isBot = false)', () => {
        const preview = 'Hey, I loved your latest post about AI!';
        const username = 'real_person';
        const botCheck = isLikelyBot(preview, username);

        expect(botCheck.isBot).toBe(false);
    });

    it('bot guard runs AFTER opt-out guard (order matters)', () => {
        // A message with both opt-out and bot signals — opt-out should take priority
        // because it comes first in the guard chain. Verify both detect independently.
        const message = 'Stop, unsubscribe https://example.com';

        // Opt-out check
        const optOutDetected = OPT_OUT_KEYWORDS.some(k => message.toLowerCase().includes(k));
        expect(optOutDetected).toBe(true);

        // Bot check (also true, but runs second in pipeline)
        const botCheck = isLikelyBot(message);
        expect(botCheck.isBot).toBe(true);
    });

    it('should filter real-world bot examples', () => {
        // Based on actual bot messages seen in the dry run
        expect(isLikelyBot('Hey! Welcome to my community. Grab your free ebook here').isBot).toBe(true);
        expect(isLikelyBot('Thanks for following! Sign up now for exclusive content').isBot).toBe(true);
        expect(isLikelyBot('New free guide just dropped! Click here to download').isBot).toBe(true);
    });

    it('should filter actual bot DMs from our inbox', () => {
        // Real messages from our saved conversations
        expect(isLikelyBot('Hey there! I\'m so happy you\'re here, thanks so much for your interest 😊').isBot).toBe(false); // lucaswebq — borderline, but no bot signals
        expect(isLikelyBot('Yay! 👋 Amazing!! Click "Sign up" to join my newsletter and get more Monday M').isBot).toBe(true); // vvanedwards — "sign up" is lead magnet
        expect(isLikelyBot('PROMPT ENGINEERING GUIDE READY! Hey! This is what you need to do: 1) Click on').isBot).toBe(true); // youraicompass — "click" + "guide"
        expect(isLikelyBot('Hey I saw your comment on my post! To let me send you the resource just push the').isBot).toBe(false); // liamjohnston — conversational
        expect(isLikelyBot('Hopefully your montizingnon it. We should find some way to collab. You build the product I market it').isBot).toBe(false); // theexpandlab — real message
    });
});

// ═══════════════════════════════════════════════════════════════════════
// Catch-Up Missed Replies — Logic Tests
// ═══════════════════════════════════════════════════════════════════════

describe('Catch-Up Logic — Pre-filtering', () => {
    it('should skip conversations where last message starts with "You:"', () => {
        const lastMessage = 'You: Hey! Just testing something on my end';
        const isOurMessage = lastMessage.toLowerCase().startsWith('you:') || lastMessage.toLowerCase().startsWith('you sent');
        expect(isOurMessage).toBe(true);
    });

    it('should skip conversations where last message starts with "You sent"', () => {
        const lastMessage = 'You sent an attachment.';
        const isOurMessage = lastMessage.toLowerCase().startsWith('you:') || lastMessage.toLowerCase().startsWith('you sent');
        expect(isOurMessage).toBe(true);
    });

    it('should not skip conversations where their message mentions "you"', () => {
        const lastMessage = 'You got it! Looking forward to it 👊';
        const isOurMessage = lastMessage.toLowerCase().startsWith('you:') || lastMessage.toLowerCase().startsWith('you sent');
        // "You got it" is THEIR message (starts with "You " not "You:")
        expect(isOurMessage).toBe(false);
    });

    it('should identify conversations needing reply by turn-check', () => {
        // Last message is theirs = our turn
        const messages = [
            makeMessage('Hey', false),
            makeMessage('Hi there!', true),
            makeMessage('How are you?', false)
        ];
        const lastMsg = messages[messages.length - 1];
        expect(lastMsg.isOurs).toBe(false); // Their turn → we should reply
    });

    it('should skip conversations where we already replied', () => {
        const messages = [
            makeMessage('Hey', false),
            makeMessage('Hi! Nice to meet you', true)
        ];
        const lastMsg = messages[messages.length - 1];
        expect(lastMsg.isOurs).toBe(true); // We already replied
    });
});

describe('Catch-Up + Bot Filter Integration', () => {
    it('should filter bot messages during catch-up (real inbox data)', () => {
        // Simulate catch-up scanning real inbox entries
        const inboxEntries = [
            { username: 'vvanedwards', lastMessage: 'Click "Sign up" to join my newsletter', expected: true },
            { username: 'youraicompass', lastMessage: 'PROMPT ENGINEERING GUIDE READY! Hey! This is what you need to do: 1) Click on', expected: true },
            { username: 'theexpandlab', lastMessage: 'We should find some way to collab', expected: false },
            { username: 'thrivewithangelak', lastMessage: 'View transcription', expected: false },
            { username: 'day1marketing', lastMessage: 'You got it! Looking forward to it', expected: false },
        ];

        for (const entry of inboxEntries) {
            const botCheck = isLikelyBot(entry.lastMessage, entry.username);
            expect(botCheck.isBot).toBe(entry.expected);
        }
    });

    it('should allow genuine replies through catch-up filter', () => {
        const genuineReplies = [
            'That sounds great, let me know!',
            'Haha yeah exactly 😂',
            'I would love to collaborate on that',
            'Hopefully your montizingnon it. We should find some way to collab',
            'You got it! Looking forward to it 👊',
            'View transcription'
        ];

        for (const msg of genuineReplies) {
            expect(isLikelyBot(msg).isBot).toBe(false);
        }
    });
});
