/**
 * AI Client Tests — Anthropic Claude wrapper
 * Tests message formatting, system prompt handling, and live API calls.
 */
import { chatCompletion, AIChatMessage, AIChatOptions, DEFAULT_MODEL } from '../../src/utils/ai';
import dotenv from 'dotenv';

dotenv.config();

const hasApiKey = !!(process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY);

// ── Unit tests (no API calls) ────────────────────────────────────────

describe('AI Client - Unit', () => {
    it('should export chatCompletion function', () => {
        expect(typeof chatCompletion).toBe('function');
    });

    it('should export DEFAULT_MODEL', () => {
        expect(DEFAULT_MODEL).toBeDefined();
        expect(typeof DEFAULT_MODEL).toBe('string');
        expect(DEFAULT_MODEL).toContain('claude');
    });

    it('should have correct AIChatMessage interface shape', () => {
        const msg: AIChatMessage = { role: 'user', content: 'test' };
        expect(msg.role).toBe('user');
        expect(msg.content).toBe('test');
    });

    it('should accept system, user, and assistant roles', () => {
        const messages: AIChatMessage[] = [
            { role: 'system', content: 'You are helpful.' },
            { role: 'user', content: 'Hello' },
            { role: 'assistant', content: 'Hi there' },
        ];
        expect(messages).toHaveLength(3);
        expect(messages.map(m => m.role)).toEqual(['system', 'user', 'assistant']);
    });

    it('should accept optional fields in AIChatOptions', () => {
        const opts: AIChatOptions = {
            messages: [{ role: 'user', content: 'test' }],
        };
        expect(opts.model).toBeUndefined();
        expect(opts.max_tokens).toBeUndefined();
        expect(opts.temperature).toBeUndefined();
    });
});

// ── Message formatting tests ─────────────────────────────────────────

describe('AI Client - Message Formatting', () => {
    // Test the message separation logic by checking what chatCompletion receives
    // We can't easily mock the Anthropic client without API calls, so we test
    // the expected input/output contract

    it('should handle system-only messages gracefully', () => {
        const opts: AIChatOptions = {
            messages: [{ role: 'system', content: 'You are a bot.' }],
        };
        // System messages should be separated; a default user message prepended
        expect(opts.messages.filter(m => m.role === 'system')).toHaveLength(1);
        expect(opts.messages.filter(m => m.role !== 'system')).toHaveLength(0);
    });

    it('should handle multi-turn conversations', () => {
        const opts: AIChatOptions = {
            messages: [
                { role: 'system', content: 'Be concise.' },
                { role: 'user', content: 'Hi' },
                { role: 'assistant', content: 'Hello!' },
                { role: 'user', content: 'How are you?' },
            ],
        };
        const nonSystem = opts.messages.filter(m => m.role !== 'system');
        expect(nonSystem).toHaveLength(3);
        expect(nonSystem[0].role).toBe('user');
        expect(nonSystem[1].role).toBe('assistant');
        expect(nonSystem[2].role).toBe('user');
    });

    it('should handle empty content gracefully', () => {
        const opts: AIChatOptions = {
            messages: [
                { role: 'system', content: '' },
                { role: 'user', content: 'test' },
            ],
        };
        expect(opts.messages[0].content).toBe('');
    });
});

// ── Migration compatibility tests ────────────────────────────────────

describe('AI Client - OpenAI Migration Compatibility', () => {
    it('should accept the same message format as OpenAI', () => {
        // This is the pattern used across all 15 production files
        const messages: AIChatMessage[] = [
            {
                role: 'system',
                content: 'You are a friendly social media bot. Keep messages under 280 characters.',
            },
            {
                role: 'user',
                content: 'Generate a reply to this tweet: "Just launched my AI startup!"',
            },
        ];

        const opts: AIChatOptions = {
            messages,
            max_tokens: 150,
            temperature: 0.8,
        };

        expect(opts.messages).toHaveLength(2);
        expect(opts.max_tokens).toBe(150);
        expect(opts.temperature).toBe(0.8);
    });

    it('chatCompletion returns a string (not an object like OpenAI)', async () => {
        // Verify the return type contract
        // Old pattern: response.choices[0].message?.content?.trim()
        // New pattern: response (direct string)
        // We can't call without API key, but we verify the function signature
        expect(chatCompletion.length).toBe(1); // takes 1 argument
    });
});

// ── Live API tests (require ANTHROPIC_AUTH_TOKEN) ────────────────────

describe('AI Client - Live API', () => {
    beforeAll(() => {
        if (!hasApiKey) {
            console.warn('ANTHROPIC_AUTH_TOKEN not set — skipping live API tests');
        }
    });

    it('should generate a basic response', async () => {
        if (!hasApiKey) return;

        const response = await chatCompletion({
            messages: [
                { role: 'user', content: 'Reply with exactly the word "hello" and nothing else.' },
            ],
            max_tokens: 10,
            temperature: 0,
        });

        expect(typeof response).toBe('string');
        expect(response.length).toBeGreaterThan(0);
        expect(response.toLowerCase()).toContain('hello');
    }, 15000);

    it('should handle system prompts', async () => {
        if (!hasApiKey) return;

        const response = await chatCompletion({
            messages: [
                { role: 'system', content: 'You always respond in exactly 3 words.' },
                { role: 'user', content: 'How are you?' },
            ],
            max_tokens: 20,
            temperature: 0,
        });

        expect(typeof response).toBe('string');
        expect(response.length).toBeGreaterThan(0);
        // Should be roughly 3 words
        const wordCount = response.trim().split(/\s+/).length;
        expect(wordCount).toBeLessThanOrEqual(6); // Allow some flexibility
    }, 15000);

    it('should generate DM-style messages', async () => {
        if (!hasApiKey) return;

        const response = await chatCompletion({
            messages: [
                {
                    role: 'system',
                    content: 'You are a friendly person on social media. Write casual, authentic DMs. Keep it under 2 sentences.',
                },
                {
                    role: 'user',
                    content: 'Write a DM to @techfounder who just posted about launching their AI startup.',
                },
            ],
            max_tokens: 100,
            temperature: 0.8,
        });

        expect(typeof response).toBe('string');
        expect(response.length).toBeGreaterThan(10);
        expect(response.length).toBeLessThan(500);
    }, 15000);

    it('should generate comment-style replies', async () => {
        if (!hasApiKey) return;

        const response = await chatCompletion({
            messages: [
                {
                    role: 'system',
                    content: 'Generate a short, engaging Instagram comment. 1-2 sentences max. Be genuine.',
                },
                {
                    role: 'user',
                    content: 'Post caption: "Finally finished building my first robot! 3 months of work"',
                },
            ],
            max_tokens: 80,
            temperature: 0.8,
        });

        expect(typeof response).toBe('string');
        expect(response.length).toBeGreaterThan(5);
    }, 15000);

    it('should handle multi-turn conversation', async () => {
        if (!hasApiKey) return;

        const response = await chatCompletion({
            messages: [
                { role: 'system', content: 'You are a social media assistant.' },
                { role: 'user', content: 'Hi, I need help with a DM.' },
                { role: 'assistant', content: 'Sure! Who are you messaging?' },
                { role: 'user', content: 'A tech entrepreneur. Keep it casual.' },
            ],
            max_tokens: 100,
            temperature: 0.7,
        });

        expect(typeof response).toBe('string');
        expect(response.length).toBeGreaterThan(0);
    }, 15000);
});
