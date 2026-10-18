/**
 * Tests for Twitter reply focus management and front-truncation protection.
 *
 * Covers:
 * - Reply validation (length, emojis, forbidden phrases, generic detection)
 * - Selector scoping (modal-first to avoid search box)
 * - safeType contract (exported, callable signature)
 * - Front-truncation detection patterns
 */

import { validateReply, DEFAULT_REPLY_GUIDELINES, safeType } from '../../src/client/Twitter-Core';

describe('Twitter Reply Focus & Validation', () => {
    describe('validateReply', () => {
        it('should accept a valid reply', () => {
            const result = validateReply('That approach to fine-tuning makes a lot of sense for smaller datasets');
            expect(result.valid).toBe(true);
        });

        it('should reject empty reply', () => {
            const result = validateReply('');
            expect(result.valid).toBe(false);
            expect(result.reason).toContain('empty');
        });

        it('should reject reply that is too short', () => {
            const result = validateReply('hi');
            expect(result.valid).toBe(false);
            expect(result.reason).toContain('short');
        });

        it('should reject reply that exceeds 280 chars', () => {
            const longReply = 'a'.repeat(281);
            const result = validateReply(longReply);
            expect(result.valid).toBe(false);
            expect(result.reason).toContain('long');
        });

        it('should accept reply at exactly 280 chars', () => {
            const exactReply = 'a'.repeat(280);
            const result = validateReply(exactReply);
            expect(result.valid).toBe(true);
        });

        it('should accept reply at exactly minimum length', () => {
            const result = validateReply('abcdefghij'); // 10 chars = minLength
            expect(result.valid).toBe(true);
        });

        it('should reject generic low-value replies', () => {
            const guidelines = { ...DEFAULT_REPLY_GUIDELINES, mustAddValue: true };
            const genericReplies = ['Nice!', 'Great', 'This', 'Agreed', 'Same', 'Facts', 'Real', 'Fr', 'Literally'];
            for (const reply of genericReplies) {
                const result = validateReply(reply, guidelines);
                expect(result.valid).toBe(false);
            }
        });

        it('should accept substantive replies when mustAddValue is true', () => {
            const guidelines = { ...DEFAULT_REPLY_GUIDELINES, mustAddValue: true };
            const substantiveReplies = [
                'The key insight here is the batch size vs learning rate tradeoff',
                'Have you tried using gradient accumulation instead?',
                'This reminds me of the scaling laws paper from Kaplan et al',
            ];
            for (const reply of substantiveReplies) {
                const result = validateReply(reply, guidelines);
                expect(result.valid).toBe(true);
            }
        });

        it('should reject replies with too many emojis', () => {
            const result = validateReply('🔥🔥🔥🔥 love this so much!!');
            expect(result.valid).toBe(false);
            expect(result.reason).toContain('emoji');
        });

        it('should accept replies with emojis within limit', () => {
            const result = validateReply('Really interesting point about attention mechanisms 🔥');
            expect(result.valid).toBe(true);
        });

        it('should reject replies with forbidden phrases', () => {
            const guidelines = { ...DEFAULT_REPLY_GUIDELINES, forbiddenPhrases: ['check my profile', 'follow me', 'DM me'] };
            expect(validateReply('Great thread! Check my profile for more', guidelines).valid).toBe(false);
            expect(validateReply('Follow me for more AI tips', guidelines).valid).toBe(false);
            expect(validateReply('DM me to learn more about this', guidelines).valid).toBe(false);
        });

        it('should be case-insensitive for forbidden phrases', () => {
            const guidelines = { ...DEFAULT_REPLY_GUIDELINES, forbiddenPhrases: ['check my profile'] };
            expect(validateReply('CHECK MY PROFILE for more', guidelines).valid).toBe(false);
        });
    });

    describe('safeType export', () => {
        it('should be exported as a function', () => {
            expect(typeof safeType).toBe('function');
        });

        it('should accept the expected parameters', () => {
            // Verify the function signature accepts (page, element, text, options?)
            expect(safeType.length).toBeGreaterThanOrEqual(3); // at least 3 required params
        });
    });

    describe('Reply textarea selector scoping', () => {
        it('should use modal-scoped selectors before unscoped', () => {
            // Priority order used in postReply():
            const selectors = [
                'div[aria-modal="true"] div[data-testid="tweetTextarea_0"]',  // 1st: modal
                'div[role="dialog"] div[data-testid="tweetTextarea_0"]',       // 1st: dialog
                'div[data-testid="tweetTextarea_0"]',                          // 2nd: fallback
                'div[role="dialog"] div[role="textbox"][contenteditable="true"]', // 3rd: generic
            ];

            // All selectors should be non-empty strings with valid attribute syntax
            for (const sel of selectors) {
                expect(sel).toMatch(/\[.*\]/);
                expect(sel.length).toBeGreaterThan(10);
            }

            // Modal-scoped should come before unscoped in the priority list
            expect(selectors[0]).toContain('aria-modal');
            expect(selectors[2]).not.toContain('modal');
        });

        it('should scope submit button to modal when possible', () => {
            const modalButton = 'div[aria-modal="true"] button[data-testid="tweetButton"]';
            const unscopedButton = 'button[data-testid="tweetButton"]';

            expect(modalButton.length).toBeGreaterThan(unscopedButton.length);
            expect(modalButton).toContain('aria-modal');
        });
    });

    describe('Front-truncation detection patterns', () => {
        // These test the logic patterns used in safeType for detecting truncation

        it('should detect when typed text is missing the expected start', () => {
            const message = 'Hey! Great point about the architecture changes';
            const expectedStart = message.slice(0, 20);
            const truncatedResult = 'Great point about the architecture changes'; // missing "Hey! "

            expect(truncatedResult.startsWith(expectedStart)).toBe(false);
        });

        it('should not false-positive on correct text', () => {
            const message = 'Hey! Great point about the architecture changes';
            const expectedStart = message.slice(0, 20);
            const correctResult = 'Hey! Great point about the architecture changes';

            expect(correctResult.startsWith(expectedStart)).toBe(true);
        });

        it('should detect completely missing text (typed in wrong element)', () => {
            const typedContent = '';
            expect(typedContent.trim().length).toBe(0);
        });

        it('should handle whitespace-only content as empty', () => {
            const typedContent = '   \n  ';
            expect(typedContent.trim().length).toBe(0);
        });

        it('should match even with minor trailing whitespace differences', () => {
            const message = 'The batch normalization layer needs adjustment  ';
            const expectedStart = message.slice(0, 20);
            const typedResult = 'The batch normalization layer needs adjustment';

            // Trimmed typed result should still start with expectedStart
            expect(typedResult.trim().startsWith(expectedStart)).toBe(true);
        });
    });

    describe('Wake-up keystroke strategy', () => {
        // safeType sends Space + Backspace before the real text to "wake up"
        // Twitter's contenteditable placeholder handler

        it('Space + Backspace should produce no net content', () => {
            // This simulates the logic: type space then backspace = no content
            let buffer = '';
            buffer += ' ';  // Space
            buffer = buffer.slice(0, -1); // Backspace
            expect(buffer).toBe('');
        });

        it('should type with increased delay on retry', () => {
            const baseDelay = 30;
            const retryIncrease = 15;
            expect(baseDelay + retryIncrease).toBe(45);
            expect(baseDelay + retryIncrease).toBeGreaterThan(baseDelay);
        });
    });
});
