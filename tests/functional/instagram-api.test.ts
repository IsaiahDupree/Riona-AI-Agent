/**
 * Instagram Graph API — Unit Tests
 *
 * Tests the API client for sending DMs via the official Instagram Graph API.
 * All fetch calls are mocked — no real API calls are made.
 */

import {
    sendInstagramDMViaAPI,
    sendInstagramDMByUsername,
    getConversations,
    getConversationMessages,
    lookupIGSID,
    clearIGSIDCache
} from '../../src/utils/instagram-api';

// ── Mock fetch globally ──────────────────────────────────────────────

const originalFetch = global.fetch;
let mockFetch: jest.Mock;

beforeEach(() => {
    mockFetch = jest.fn();
    global.fetch = mockFetch;
    clearIGSIDCache();

    // Set required env vars
    process.env.INSTAGRAM_ACCESS_TOKEN = 'test-token-123';
    process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID = '17841472205103640';
});

afterAll(() => {
    global.fetch = originalFetch;
    delete process.env.INSTAGRAM_ACCESS_TOKEN;
    delete process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID;
});

// ═════════════════════════════════════════════════════════════════════
// sendInstagramDMViaAPI
// ═════════════════════════════════════════════════════════════════════

describe('sendInstagramDMViaAPI', () => {
    it('sends a text message successfully', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ recipient_id: 'igsid_123', message_id: 'mid_abc' })
        });

        const result = await sendInstagramDMViaAPI('igsid_123', 'Hello there!');

        expect(result.success).toBe(true);
        expect(result.recipientId).toBe('igsid_123');
        expect(result.messageId).toBe('mid_abc');

        // Verify correct endpoint and payload
        expect(mockFetch).toHaveBeenCalledWith(
            'https://graph.instagram.com/v21.0/17841472205103640/messages',
            expect.objectContaining({
                method: 'POST',
                headers: {
                    'Authorization': 'Bearer test-token-123',
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    recipient: { id: 'igsid_123' },
                    message: { text: 'Hello there!' }
                })
            })
        );
    });

    it('returns error when API responds with error', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: false,
            status: 400,
            json: async () => ({
                error: { message: 'This message is sent outside of allowed window', code: 10 }
            })
        });

        const result = await sendInstagramDMViaAPI('igsid_123', 'Hey!');

        expect(result.success).toBe(false);
        expect(result.error).toContain('outside of allowed window');
    });

    it('rejects messages exceeding 1000-byte limit', async () => {
        const longMessage = 'x'.repeat(1001);
        const result = await sendInstagramDMViaAPI('igsid_123', longMessage);

        expect(result.success).toBe(false);
        expect(result.error).toContain('1000-byte limit');
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('allows messages exactly at 1000-byte limit', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ recipient_id: 'igsid_123', message_id: 'mid_exact' })
        });

        const exactMessage = 'a'.repeat(1000);
        const result = await sendInstagramDMViaAPI('igsid_123', exactMessage);

        expect(result.success).toBe(true);
        expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('counts multi-byte characters correctly for limit', async () => {
        // Emoji is 4 bytes in UTF-8, so 251 emojis = 1004 bytes > 1000
        const emojiMessage = '😊'.repeat(251);
        const result = await sendInstagramDMViaAPI('igsid_123', emojiMessage);

        expect(result.success).toBe(false);
        expect(result.error).toContain('1000-byte limit');
    });

    it('handles network errors gracefully', async () => {
        mockFetch.mockRejectedValueOnce(new Error('Network timeout'));

        const result = await sendInstagramDMViaAPI('igsid_123', 'Hello');

        expect(result.success).toBe(false);
        expect(result.error).toBe('Network timeout');
    });

    it('handles rate limit (HTTP 429) response', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: false,
            status: 429,
            json: async () => ({
                error: { message: 'Rate limit exceeded', code: 4 }
            })
        });

        const result = await sendInstagramDMViaAPI('igsid_123', 'Hi');

        expect(result.success).toBe(false);
        expect(result.error).toContain('Rate limit');
    });
});

// ═════════════════════════════════════════════════════════════════════
// getConversations
// ═════════════════════════════════════════════════════════════════════

describe('getConversations', () => {
    it('fetches and parses conversations', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                data: [
                    {
                        id: 'conv_1',
                        participants: { data: [{ id: 'igsid_user1', username: 'alice' }] },
                        updated_time: '2026-03-18T10:00:00Z'
                    },
                    {
                        id: 'conv_2',
                        participants: { data: [{ id: 'igsid_user2', username: 'bob' }] },
                        updated_time: '2026-03-17T08:00:00Z'
                    }
                ]
            })
        });

        const conversations = await getConversations();

        expect(conversations).toHaveLength(2);
        expect(conversations[0].id).toBe('conv_1');
        expect(conversations[0].participants[0].username).toBe('alice');
        expect(conversations[1].participants[0].id).toBe('igsid_user2');
    });

    it('returns empty array on API error', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: false,
            status: 500,
            json: async () => ({ error: { message: 'Internal error' } })
        });

        const conversations = await getConversations();
        expect(conversations).toEqual([]);
    });

    it('handles missing participants data gracefully', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                data: [{ id: 'conv_1' }] // no participants field
            })
        });

        const conversations = await getConversations();
        expect(conversations).toHaveLength(1);
        expect(conversations[0].participants).toEqual([]);
    });

    it('passes limit parameter correctly', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ data: [] })
        });

        await getConversations(25);

        expect(mockFetch).toHaveBeenCalledWith(
            expect.stringContaining('limit=25')
        );
    });
});

// ═════════════════════════════════════════════════════════════════════
// getConversationMessages
// ═════════════════════════════════════════════════════════════════════

describe('getConversationMessages', () => {
    it('fetches messages from a conversation', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                data: [
                    {
                        id: 'msg_1',
                        message: 'Hey there!',
                        from: { id: 'igsid_alice', username: 'alice' },
                        to: { data: [{ id: '17841472205103640' }] },
                        created_time: '2026-03-18T10:30:00Z'
                    }
                ]
            })
        });

        const messages = await getConversationMessages('conv_1');

        expect(messages).toHaveLength(1);
        expect(messages[0].message).toBe('Hey there!');
        expect(messages[0].from.username).toBe('alice');
    });

    it('returns empty array on error', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: false,
            status: 400,
            json: async () => ({ error: { message: 'Invalid conversation' } })
        });

        const messages = await getConversationMessages('bad_conv');
        expect(messages).toEqual([]);
    });
});

// ═════════════════════════════════════════════════════════════════════
// lookupIGSID
// ═════════════════════════════════════════════════════════════════════

describe('lookupIGSID', () => {
    function mockConversationsResponse(conversations: any[]) {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ data: conversations })
        });
    }

    it('finds IGSID for a known user', async () => {
        mockConversationsResponse([
            {
                id: 'conv_1',
                participants: { data: [{ id: 'igsid_alice', username: 'alice' }] }
            }
        ]);

        const result = await lookupIGSID('alice');

        expect(result.igsid).toBe('igsid_alice');
        expect(result.conversationId).toBe('conv_1');
        expect(result.error).toBeUndefined();
    });

    it('returns null for unknown user', async () => {
        mockConversationsResponse([
            {
                id: 'conv_1',
                participants: { data: [{ id: 'igsid_bob', username: 'bob' }] }
            }
        ]);

        const result = await lookupIGSID('unknown_user');

        expect(result.igsid).toBeNull();
        expect(result.conversationId).toBeNull();
        expect(result.error).toContain('No conversation found');
    });

    it('is case-insensitive', async () => {
        mockConversationsResponse([
            {
                id: 'conv_1',
                participants: { data: [{ id: 'igsid_alice', username: 'Alice' }] }
            }
        ]);

        const result = await lookupIGSID('ALICE');
        expect(result.igsid).toBe('igsid_alice');
    });

    it('strips @ prefix from username', async () => {
        mockConversationsResponse([
            {
                id: 'conv_1',
                participants: { data: [{ id: 'igsid_alice', username: 'alice' }] }
            }
        ]);

        const result = await lookupIGSID('@alice');
        expect(result.igsid).toBe('igsid_alice');
    });

    it('uses cached IGSID on second lookup', async () => {
        mockConversationsResponse([
            {
                id: 'conv_1',
                participants: { data: [{ id: 'igsid_alice', username: 'alice' }] }
            }
        ]);

        // First call — hits API
        await lookupIGSID('alice');
        expect(mockFetch).toHaveBeenCalledTimes(1);

        // Second call — uses cache, no new API call
        const result = await lookupIGSID('alice');
        expect(mockFetch).toHaveBeenCalledTimes(1); // still 1
        expect(result.igsid).toBe('igsid_alice');
    });

    it('re-fetches after cache is cleared', async () => {
        mockConversationsResponse([
            {
                id: 'conv_1',
                participants: { data: [{ id: 'igsid_alice', username: 'alice' }] }
            }
        ]);

        await lookupIGSID('alice');
        clearIGSIDCache();

        mockConversationsResponse([
            {
                id: 'conv_1',
                participants: { data: [{ id: 'igsid_alice_new', username: 'alice' }] }
            }
        ]);

        const result = await lookupIGSID('alice');
        expect(mockFetch).toHaveBeenCalledTimes(2);
        expect(result.igsid).toBe('igsid_alice_new');
    });
});

// ═════════════════════════════════════════════════════════════════════
// sendInstagramDMByUsername (high-level: lookup + send)
// ═════════════════════════════════════════════════════════════════════

describe('sendInstagramDMByUsername', () => {
    it('looks up IGSID then sends message', async () => {
        // First call: getConversations (for IGSID lookup)
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                data: [{
                    id: 'conv_1',
                    participants: { data: [{ id: 'igsid_alice', username: 'alice' }] }
                }]
            })
        });

        // Second call: sendInstagramDMViaAPI
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ recipient_id: 'igsid_alice', message_id: 'mid_123' })
        });

        const result = await sendInstagramDMByUsername('alice', 'Hey Alice!');

        expect(result.success).toBe(true);
        expect(result.messageId).toBe('mid_123');
        expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('returns error when user has no conversation (cold outreach)', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ data: [] }) // no conversations
        });

        const result = await sendInstagramDMByUsername('stranger', 'Hi!');

        expect(result.success).toBe(false);
        expect(result.error).toContain('No conversation found');
        // Should not attempt to send
        expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('uses cached IGSID for subsequent sends', async () => {
        // Lookup call
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                data: [{
                    id: 'conv_1',
                    participants: { data: [{ id: 'igsid_bob', username: 'bob' }] }
                }]
            })
        });
        // First send
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ recipient_id: 'igsid_bob', message_id: 'mid_1' })
        });

        await sendInstagramDMByUsername('bob', 'First message');

        // Second send — should only call sendDM (1 fetch), not lookup again
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ recipient_id: 'igsid_bob', message_id: 'mid_2' })
        });

        const result = await sendInstagramDMByUsername('bob', 'Second message');
        expect(result.success).toBe(true);
        expect(mockFetch).toHaveBeenCalledTimes(3); // 1 lookup + 2 sends
    });
});

// ═════════════════════════════════════════════════════════════════════
// Missing credentials
// ═════════════════════════════════════════════════════════════════════

describe('missing credentials', () => {
    it('throws when INSTAGRAM_ACCESS_TOKEN is missing', async () => {
        delete process.env.INSTAGRAM_ACCESS_TOKEN;

        await expect(sendInstagramDMViaAPI('igsid_123', 'test'))
            .rejects.toThrow('Missing INSTAGRAM_ACCESS_TOKEN');
    });

    it('throws when INSTAGRAM_BUSINESS_ACCOUNT_ID is missing', async () => {
        delete process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID;

        await expect(sendInstagramDMViaAPI('igsid_123', 'test'))
            .rejects.toThrow('Missing INSTAGRAM_ACCESS_TOKEN or INSTAGRAM_BUSINESS_ACCOUNT_ID');
    });
});

// ═════════════════════════════════════════════════════════════════════
// API-first fallback pattern (integration-style)
// ═════════════════════════════════════════════════════════════════════

describe('API-first with browser fallback pattern', () => {
    it('returns null-like error for cold outreach, enabling browser fallback', async () => {
        // User never messaged us → no IGSID → API fails → browser should handle
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ data: [] })
        });

        const result = await sendInstagramDMByUsername('cold_target', 'Hey check out my page!');

        expect(result.success).toBe(false);
        expect(result.error).toContain('No conversation found');
        // This is the signal that browser automation should take over
    });

    it('succeeds for existing conversation within 24h window', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                data: [{
                    id: 'conv_warm',
                    participants: { data: [{ id: 'igsid_warm_user', username: 'warm_user' }] }
                }]
            })
        });
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ recipient_id: 'igsid_warm_user', message_id: 'mid_warm' })
        });

        const result = await sendInstagramDMByUsername('warm_user', 'Thanks for reaching out!');

        expect(result.success).toBe(true);
        expect(result.messageId).toBe('mid_warm');
    });

    it('fails gracefully when outside 24h window', async () => {
        // IGSID found but message rejected (outside window)
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                data: [{
                    id: 'conv_stale',
                    participants: { data: [{ id: 'igsid_stale', username: 'stale_user' }] }
                }]
            })
        });
        mockFetch.mockResolvedValueOnce({
            ok: false,
            status: 400,
            json: async () => ({
                error: { message: 'This message is sent outside of allowed window', code: 10 }
            })
        });

        const result = await sendInstagramDMByUsername('stale_user', 'Following up!');

        expect(result.success).toBe(false);
        expect(result.error).toContain('outside of allowed window');
    });
});
