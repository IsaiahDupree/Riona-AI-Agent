/**
 * Supabase Twitter DM Sync — Syncs Twitter DM data to Supabase cloud tables
 *
 * Mirrors supabaseDM.ts but uses platform: 'twitter' for all records.
 * Uses the same production tables:
 *   - crm_contacts: relationship/contact data
 *   - crm_conversations: conversation threads
 *   - crm_messages: individual messages
 *   - platform_dms: raw DM records
 *   - dm_message_performance: message effectiveness tracking
 *   - dm_conversations: local DM schema tables
 *   - dm_messages: local DM schema messages
 *   - dm_feedback: local DM feedback tracking
 *
 * Falls back gracefully if Supabase is not configured.
 */

import { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseClient } from './supabaseClient';
import { logger } from '../utils/logger';
import { withRetry, formatError } from '../utils/errors';
import { TrackedDM, ProfileInfo, RelationshipInfo } from '../types/dm';
import { MessageFeedback } from '../client/Twitter-DM-AI';
import * as fs from 'fs';
import * as path from 'path';

function getClient(): SupabaseClient | null {
    return getSupabaseClient();
}

// ── Ensure a CRM contact exists for a Twitter username ──────────────

async function ensureContact(sb: SupabaseClient, username: string): Promise<string | null> {
    return withRetry(async () => {
        return await _ensureContactInner(sb, username);
    }, { maxRetries: 2, baseDelay: 1000, label: `ensureTwitterContact(@${username})` }).catch(e => {
        logger.warn(`[supabase-twitter-dm] Failed to ensure contact for @${username} after retries: ${formatError(e)}`);
        return null;
    });
}

async function _ensureContactInner(sb: SupabaseClient, username: string): Promise<string | null> {
    try {
        // Check by twitter_handle or username
        const { data: existing } = await sb
            .from('crm_contacts')
            .select('id, twitter_handle')
            .or(`twitter_handle.eq.${username.toLowerCase()},username.eq.${username.toLowerCase()}`)
            .limit(1)
            .single();

        if (existing) {
            // Backfill twitter_handle if missing
            if (!existing.twitter_handle) {
                await sb.from('crm_contacts').update({
                    twitter_handle: username.toLowerCase(),
                    platform: 'twitter'
                }).eq('id', existing.id);
            }
            return existing.id;
        }

        // Create new contact
        const { data: created, error } = await sb
            .from('crm_contacts')
            .insert({
                username: username.toLowerCase(),
                twitter_handle: username.toLowerCase(),
                display_name: username,
                platform: 'twitter',
                source: 'riona_twitter_dm_system',
                pipeline_stage: 'first_touch',
                relationship_stage: 'cold_outreach'
            })
            .select('id')
            .single();

        if (error) throw error;
        logger.info(`[supabase-twitter-dm] Created CRM contact for @${username}: ${created.id}`);
        return created.id;
    } catch (e) {
        throw e;
    }
}

// ── Ensure a CRM conversation exists ────────────────────────────────

async function ensureConversation(sb: SupabaseClient, contactId: string, username: string): Promise<string | null> {
    try {
        const { data: existing } = await sb
            .from('crm_conversations')
            .select('id')
            .eq('contact_id', contactId)
            .eq('platform', 'twitter')
            .limit(1)
            .single();

        if (existing) return existing.id;

        const { data: created, error } = await sb
            .from('crm_conversations')
            .insert({
                contact_id: contactId,
                platform: 'twitter',
                tab_type: 'primary',
                is_active: true,
                last_message_preview: '',
                message_count: 0
            })
            .select('id')
            .single();

        if (error) throw error;
        return created.id;
    } catch (e) {
        logger.warn(`[supabase-twitter-dm] Failed to ensure conversation for @${username}:`, e);
        return null;
    }
}

// ── Sync a Twitter DM message to Supabase ───────────────────────────

export async function syncTwitterDMToSupabase(dm: TrackedDM): Promise<void> {
    const sb = getClient();
    if (!sb) return;

    try {
        const contactId = await ensureContact(sb, dm.recipientUsername);
        if (!contactId) {
            logger.warn(`[supabase-twitter-dm] Skipping DM sync for @${dm.recipientUsername} — contact creation failed`);
            return;
        }

        const convId = await ensureConversation(sb, contactId, dm.recipientUsername);

        // Write to crm_messages
        if (convId) {
            await sb.from('crm_messages').insert({
                conversation_id: convId,
                contact_id: contactId,
                platform: 'twitter',
                message_text: dm.messageText,
                is_outbound: dm.direction === 'outbound',
                sent_by_automation: true,
                sent_at: dm.timestamp,
                username: dm.recipientUsername.toLowerCase(),
                metadata: {
                    verified: dm.verified,
                    session_id: dm.sessionId,
                    relationship_category: dm.relationshipCategory,
                    source: 'riona_twitter_dm_system'
                }
            });
        }

        // Write to platform_dms for raw tracking (upsert to prevent duplicates on re-sync)
        await sb.from('platform_dms').upsert({
            platform: 'twitter',
            username: dm.recipientUsername.toLowerCase(),
            direction: dm.direction === 'outbound' ? 'outbound' : 'inbound',
            message_text: dm.messageText,
            message_type: 'text',
            is_read: true,
            is_replied: false,
            reply_needed: dm.direction === 'inbound',
            platform_timestamp: dm.timestamp,
            synced_at: new Date().toISOString(),
            raw_data: {
                verified: dm.verified,
                session_id: dm.sessionId,
                source: 'riona_twitter_dm_system'
            }
        }, { onConflict: 'platform,username,platform_timestamp' });

        // Update contact stats
        const updateFields: Record<string, any> = {
            last_message_at: dm.timestamp,
            last_message: dm.messageText.slice(0, 200)
        };
        if (dm.direction === 'outbound') {
            updateFields.last_outbound_at = dm.timestamp;
        } else {
            updateFields.last_inbound_at = dm.timestamp;
        }
        await sb.from('crm_contacts').update(updateFields).eq('id', contactId);

        // Update conversation
        if (convId) {
            await sb.from('crm_conversations').update({
                last_message_at: dm.timestamp,
                last_message_preview: dm.messageText.slice(0, 200),
                is_active: true
            }).eq('id', convId);
        }

    } catch (e) {
        logger.warn('[supabase-twitter-dm] Failed to sync DM:', e);
    }
}

// ── Sync feedback to Supabase ───────────────────────────────────────

export async function syncTwitterFeedbackToSupabase(feedback: MessageFeedback): Promise<void> {
    const sb = getClient();
    if (!sb) return;

    try {
        const contactId = await ensureContact(sb, feedback.recipientUsername);
        if (!contactId) return;

        // Update contact with reply data
        const update: Record<string, any> = {
            last_inbound_at: feedback.gotReply ? new Date().toISOString() : undefined,
            metadata: {
                last_feedback: {
                    got_reply: feedback.gotReply,
                    sentiment: feedback.replySentiment,
                    reply_within_hours: feedback.replyWithinHours,
                    recorded_at: new Date().toISOString()
                }
            }
        };

        if (feedback.gotReply) {
            update.reply_detected = true;
        }

        await sb.from('crm_contacts').update(update).eq('id', contactId);

        // Write to dm_message_performance for tracking
        await sb.from('dm_message_performance').insert({
            platform: 'twitter',
            username: feedback.recipientUsername.toLowerCase(),
            message_text: feedback.replyText || '',
            sent_at: feedback.messageSentAt,
            replied: feedback.gotReply,
            replied_at: feedback.gotReply ? new Date().toISOString() : null,
            reply_text: feedback.replyText || null,
            reply_latency_hours: feedback.replyWithinHours || null,
            ai_quality_score: feedback.replySentiment === 'positive' ? 1.0 : feedback.replySentiment === 'negative' ? 0.0 : 0.5
        });

    } catch (e) {
        logger.warn('[supabase-twitter-dm] Failed to sync feedback:', e);
    }
}

// ── Sync relationship data to Supabase ──────────────────────────────

export async function syncTwitterRelationshipToSupabase(
    username: string,
    category: string,
    warmth: number,
    stage: string,
    tags: string[]
): Promise<void> {
    const sb = getClient();
    if (!sb) return;

    try {
        const contactId = await ensureContact(sb, username);
        if (!contactId) return;

        await sb.from('crm_contacts').update({
            relationship_score: warmth,
            relationship_stage: stage,
            pipeline_stage: 'context_captured',
            tags,
            metadata: {
                riona_category: category,
                riona_warmth: warmth,
                riona_stage: stage,
                platform: 'twitter',
                synced_at: new Date().toISOString()
            }
        }).eq('id', contactId);

    } catch (e) {
        logger.warn('[supabase-twitter-dm] Failed to sync relationship:', e);
    }
}

// ── Sync profile data to Supabase ───────────────────────────────────

export async function syncTwitterProfileToSupabase(username: string, profileData: {
    fullName?: string;
    bio?: string;
    followerCount?: number;
    isVerified?: boolean;
}): Promise<void> {
    const sb = getClient();
    if (!sb) return;

    try {
        const contactId = await ensureContact(sb, username);
        if (!contactId) return;

        const update: Record<string, any> = {};
        if (profileData.fullName && !/^\d+$/.test(profileData.fullName)) {
            update.display_name = profileData.fullName;
        }
        if (profileData.bio) update.bio = profileData.bio;
        if (profileData.followerCount !== undefined) {
            update.follower_count_updated_at = new Date().toISOString();
        }

        await sb.from('crm_contacts').update(update).eq('id', contactId);

    } catch (e) {
        logger.warn('[supabase-twitter-dm] Failed to sync profile:', e);
    }
}

// ── Bulk sync all local Twitter DM data to Supabase ─────────────────

export async function bulkSyncTwitterToSupabase(): Promise<{
    conversations: number;
    messages: number;
    feedback: number;
    errors: string[];
}> {
    const sb = getClient();
    if (!sb) return { conversations: 0, messages: 0, feedback: 0, errors: ['Supabase not configured'] };

    const stats = { conversations: 0, messages: 0, feedback: 0, errors: [] as string[] };

    // Sync relationships → crm_contacts
    const relDir = path.join(process.cwd(), 'logs', 'tracking', 'twitter-dm', 'relationships');
    if (fs.existsSync(relDir)) {
        for (const f of fs.readdirSync(relDir).filter(f => f.endsWith('.json'))) {
            try {
                const username = f.replace('.json', '');
                const rel = JSON.parse(fs.readFileSync(path.join(relDir, f), 'utf8'));
                await syncTwitterRelationshipToSupabase(username, rel.category, rel.warmth, rel.stage, rel.tags || []);
                stats.conversations++;
            } catch (e) {
                stats.errors.push(`rel: ${f}: ${e}`);
            }
        }
    }

    // Sync profiles → crm_contacts
    const profileDir = path.join(process.cwd(), 'logs', 'tracking', 'twitter-dm', 'profiles');
    if (fs.existsSync(profileDir)) {
        for (const f of fs.readdirSync(profileDir).filter(f => f.endsWith('.json'))) {
            try {
                const data = JSON.parse(fs.readFileSync(path.join(profileDir, f), 'utf8'));
                await syncTwitterProfileToSupabase(data.username, data);
            } catch (e) {
                stats.errors.push(`profile: ${f}: ${e}`);
            }
        }
    }

    // Sync messages → crm_messages + platform_dms (only last 48h for incremental sync)
    const msgFile = path.join(process.cwd(), 'logs', 'tracking', 'twitter-dm', 'messages.json');
    if (fs.existsSync(msgFile)) {
        try {
            const allMessages: TrackedDM[] = JSON.parse(fs.readFileSync(msgFile, 'utf8'));
            const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
            const recentMessages = allMessages.filter(m => m.timestamp > cutoff);
            for (const msg of recentMessages) {
                await syncTwitterDMToSupabase(msg);
                stats.messages++;
                if (stats.messages % 10 === 0) await new Promise(r => setTimeout(r, 200));
            }
        } catch (e) {
            stats.errors.push(`msgs: ${e}`);
        }
    }

    // Sync feedback → dm_message_performance (only last 48h)
    const fbFile = path.join(process.cwd(), 'logs', 'tracking', 'twitter-dm', 'feedback.json');
    if (fs.existsSync(fbFile)) {
        try {
            const allFeedbacks: MessageFeedback[] = JSON.parse(fs.readFileSync(fbFile, 'utf8'));
            const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
            const recentFeedbacks = allFeedbacks.filter(f => f.messageSentAt > cutoff);
            for (const fb of recentFeedbacks) {
                await syncTwitterFeedbackToSupabase(fb);
                stats.feedback++;
                if (stats.feedback % 10 === 0) await new Promise(r => setTimeout(r, 200));
            }
        } catch (e) {
            stats.errors.push(`feedback: ${e}`);
        }
    }

    logger.info(`[supabase-twitter-dm] Bulk sync: ${stats.conversations} contacts, ${stats.messages} msgs, ${stats.feedback} feedback, ${stats.errors.length} errors`);
    return stats;
}
