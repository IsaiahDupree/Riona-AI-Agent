/**
 * Instagram Graph API Client — DM Sending via Official API
 *
 * Uses the Instagram Messaging API (graph.instagram.com) to send DMs
 * instead of browser automation, which triggers account lockouts.
 *
 * Constraints:
 * - Can only message users who have messaged us first (24-hour window)
 * - Need the user's IGSID (Instagram-Scoped ID), obtained from conversations
 * - 200 messages/hour rate limit
 * - 1000 bytes max per text message
 */

import { logger } from './logger';

const GRAPH_API_BASE = 'https://graph.instagram.com/v21.0';

export interface IGConversation {
    id: string;
    participants: Array<{ id: string; username?: string }>;
    updatedTime?: string;
}

export interface IGMessage {
    id: string;
    message: string;
    from: { id: string; username?: string };
    to: { data: Array<{ id: string; username?: string }> };
    created_time: string;
}

export interface IGSendResult {
    success: boolean;
    recipientId?: string;
    messageId?: string;
    error?: string;
}

export interface IGSIDLookupResult {
    igsid: string | null;
    conversationId: string | null;
    error?: string;
}

// ── Config ───────────────────────────────────────────────────────────

function getConfig() {
    const accessToken = process.env.INSTAGRAM_ACCESS_TOKEN;
    const igBusinessId = process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID;
    if (!accessToken || !igBusinessId) {
        throw new Error('Missing INSTAGRAM_ACCESS_TOKEN or INSTAGRAM_BUSINESS_ACCOUNT_ID in env');
    }
    return { accessToken, igBusinessId };
}

// ── Send a text DM via Graph API ─────────────────────────────────────

export async function sendInstagramDMViaAPI(igsid: string, text: string): Promise<IGSendResult> {
    const { accessToken, igBusinessId } = getConfig();

    // Enforce 1000-byte limit
    const encoded = new TextEncoder().encode(text);
    if (encoded.length > 1000) {
        return { success: false, error: `Message exceeds 1000-byte limit (${encoded.length} bytes)` };
    }

    const url = `${GRAPH_API_BASE}/${igBusinessId}/messages`;
    const body = {
        recipient: { id: igsid },
        message: { text }
    };

    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(body)
        });

        const data = await res.json();

        if (!res.ok) {
            const errMsg = data?.error?.message || `HTTP ${res.status}`;
            const errCode = data?.error?.code;
            logger.error(`[ig-api] Send failed: ${errMsg} (code=${errCode})`);
            return { success: false, error: errMsg };
        }

        logger.info(`[ig-api] DM sent to IGSID ${igsid} — messageId=${data.message_id}`);
        return {
            success: true,
            recipientId: data.recipient_id,
            messageId: data.message_id
        };
    } catch (e) {
        const err = e instanceof Error ? e.message : String(e);
        logger.error(`[ig-api] Send error: ${err}`);
        return { success: false, error: err };
    }
}

// ── Get conversations to find IGSIDs ─────────────────────────────────

export async function getConversations(limit: number = 50): Promise<IGConversation[]> {
    const { accessToken, igBusinessId } = getConfig();
    const url = `${GRAPH_API_BASE}/${igBusinessId}/conversations?fields=id,participants,updated_time&limit=${limit}&access_token=${accessToken}`;

    try {
        const res = await fetch(url);
        const data = await res.json();

        if (!res.ok) {
            logger.error(`[ig-api] getConversations failed: ${data?.error?.message || res.status}`);
            return [];
        }

        return (data.data || []).map((c: any) => ({
            id: c.id,
            participants: c.participants?.data || [],
            updatedTime: c.updated_time
        }));
    } catch (e) {
        logger.error(`[ig-api] getConversations error: ${e instanceof Error ? e.message : e}`);
        return [];
    }
}

// ── Get messages in a conversation ───────────────────────────────────

export async function getConversationMessages(conversationId: string, limit: number = 20): Promise<IGMessage[]> {
    const { accessToken } = getConfig();
    const url = `${GRAPH_API_BASE}/${conversationId}/messages?fields=id,message,from,to,created_time&limit=${limit}&access_token=${accessToken}`;

    try {
        const res = await fetch(url);
        const data = await res.json();

        if (!res.ok) {
            logger.error(`[ig-api] getConversationMessages failed: ${data?.error?.message || res.status}`);
            return [];
        }

        return data.data || [];
    } catch (e) {
        logger.error(`[ig-api] getConversationMessages error: ${e instanceof Error ? e.message : e}`);
        return [];
    }
}

// ── Look up IGSID by username ────────────────────────────────────────
// Scans conversations to find the IGSID for a given username.
// Returns null if the user has never messaged us.

// In-memory cache: username → { igsid, conversationId, timestamp }
const igsidCache = new Map<string, { igsid: string; conversationId: string; ts: number }>();
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

export async function lookupIGSID(username: string): Promise<IGSIDLookupResult> {
    const lower = username.toLowerCase().replace(/^@/, '');

    // Check cache first
    const cached = igsidCache.get(lower);
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
        return { igsid: cached.igsid, conversationId: cached.conversationId };
    }

    const conversations = await getConversations(100);

    for (const conv of conversations) {
        for (const p of conv.participants) {
            if (p.username?.toLowerCase() === lower) {
                igsidCache.set(lower, { igsid: p.id, conversationId: conv.id, ts: Date.now() });
                return { igsid: p.id, conversationId: conv.id };
            }
        }
    }

    return { igsid: null, conversationId: null, error: `No conversation found for @${username} — they may not have messaged us` };
}

// ── High-level: send DM by username (lookup IGSID + send) ───────────

export async function sendInstagramDMByUsername(username: string, text: string): Promise<IGSendResult> {
    const lookup = await lookupIGSID(username);

    if (!lookup.igsid) {
        return { success: false, error: lookup.error || `No IGSID found for @${username}` };
    }

    return sendInstagramDMViaAPI(lookup.igsid, text);
}

// ── Clear IGSID cache (for testing) ──────────────────────────────────

export function clearIGSIDCache(): void {
    igsidCache.clear();
}
