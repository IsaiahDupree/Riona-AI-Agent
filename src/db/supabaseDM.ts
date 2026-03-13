/**
 * Supabase DM Sync — Syncs DM data to existing cloud Supabase tables
 *
 * Uses the production tables from the autonomous-outreach-agent project:
 *   - crm_contacts: relationship/contact data (has warmth, stage, tags, bio, etc.)
 *   - crm_conversations: conversation threads
 *   - crm_messages: individual messages
 *   - platform_dms: raw DM records
 *   - dm_message_performance: message effectiveness tracking
 *
 * Falls back gracefully if Supabase is not configured.
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { logger } from '../utils/logger';
import { withRetry, formatError } from '../utils/errors';
import { TrackedDM } from '../types/dm';
import { MessageFeedback } from '../client/Instagram-DM-AI';
import { Conversion } from '../client/Instagram-DM-Analytics';
import * as fs from 'fs';
import * as path from 'path';

let client: SupabaseClient | null = null;

function getClient(): SupabaseClient | null {
    if (client) return client;
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_KEY;
    if (!url || !key) return null;

    try {
        client = createClient(url, key);
        return client;
    } catch (e) {
        logger.warn(`[supabase-dm] Client creation failed: ${formatError(e)}`);
        return null;
    }
}

// ── Ensure a CRM contact exists for a username ─────────────────────

async function ensureContact(sb: SupabaseClient, username: string): Promise<string | null> {
    return withRetry(async () => {
        return await _ensureContactInner(sb, username);
    }, { maxRetries: 2, baseDelay: 1000, label: `ensureContact(@${username})` }).catch(e => {
        logger.warn(`[supabase-dm] Failed to ensure contact for @${username} after retries: ${formatError(e)}`);
        return null;
    });
}

async function _ensureContactInner(sb: SupabaseClient, username: string): Promise<string | null> {
    try {
        // Check by instagram_handle or username
        const { data: existing } = await sb
            .from('crm_contacts')
            .select('id, instagram_handle')
            .or(`instagram_handle.eq.${username.toLowerCase()},username.eq.${username.toLowerCase()}`)
            .limit(1)
            .single();

        if (existing) {
            // Backfill instagram_handle if missing
            if (!existing.instagram_handle) {
                await sb.from('crm_contacts').update({
                    instagram_handle: username.toLowerCase(),
                    platform: 'instagram'
                }).eq('id', existing.id);
            }
            return existing.id;
        }

        // Create new contact
        const { data: created, error } = await sb
            .from('crm_contacts')
            .insert({
                username: username.toLowerCase(),
                instagram_handle: username.toLowerCase(),
                display_name: username,
                platform: 'instagram',
                source: 'riona_dm_system',
                pipeline_stage: 'first_touch',
                relationship_stage: 'cold_outreach'
            })
            .select('id')
            .single();

        if (error) throw error;
        logger.info(`[supabase-dm] Created CRM contact for @${username}: ${created.id}`);
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
            .eq('platform', 'instagram')
            .limit(1)
            .single();

        if (existing) return existing.id;

        const { data: created, error } = await sb
            .from('crm_conversations')
            .insert({
                contact_id: contactId,
                platform: 'instagram',
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
        logger.warn(`[supabase-dm] Failed to ensure conversation for @${username}:`, e);
        return null;
    }
}

// ── Sync a DM message to Supabase ──────────────────────────────────

export async function syncDMToSupabase(dm: TrackedDM): Promise<void> {
    const sb = getClient();
    if (!sb) return;

    try {
        const contactId = await ensureContact(sb, dm.recipientUsername);
        if (!contactId) {
            logger.warn(`[supabase-dm] Skipping DM sync for @${dm.recipientUsername} — contact creation failed`);
            return;
        }

        const convId = await ensureConversation(sb, contactId, dm.recipientUsername);
        if (!convId) {
            logger.warn(`[supabase-dm] Skipping message sync for @${dm.recipientUsername} — conversation creation failed`);
        }

        // Write to crm_messages
        if (convId) {
            await sb.from('crm_messages').insert({
                conversation_id: convId,
                contact_id: contactId,
                platform: 'instagram',
                message_text: dm.messageText,
                is_outbound: dm.direction === 'outbound',
                sent_by_automation: true,
                sent_at: dm.timestamp,
                username: dm.recipientUsername.toLowerCase(),
                metadata: {
                    verified: dm.verified,
                    session_id: dm.sessionId,
                    relationship_category: dm.relationshipCategory,
                    source: 'riona_dm_system'
                }
            });
        }

        // Also write to platform_dms for raw tracking
        await sb.from('platform_dms').insert({
            platform: 'instagram',
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
                source: 'riona_dm_system'
            }
        });

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
        logger.warn('[supabase-dm] Failed to sync DM:', e);
    }
}

// ── Sync feedback to Supabase ──────────────────────────────────────

export async function syncFeedbackToSupabase(feedback: MessageFeedback): Promise<void> {
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
            platform: 'instagram',
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
        logger.warn('[supabase-dm] Failed to sync feedback:', e);
    }
}

// ── Sync conversion to Supabase ────────────────────────────────────

export async function syncConversionToSupabase(conversion: Conversion): Promise<void> {
    const sb = getClient();
    if (!sb) return;

    try {
        const contactId = await ensureContact(sb, conversion.recipientUsername);
        if (!contactId) return;

        // Update contact with conversion data
        await sb.from('crm_contacts').update({
            offer_outcome: conversion.conversionType,
            last_offer_sent: conversion.offerName,
            last_offer_at: conversion.recordedAt,
            pipeline_stage: 'context_captured',
            metadata: {
                conversion: {
                    type: conversion.conversionType,
                    offer: conversion.offerName,
                    value: conversion.value,
                    dms_before: conversion.dmsSentBeforeConversion,
                    days_since_first: conversion.daysSinceFirstContact,
                    recorded_at: conversion.recordedAt
                }
            }
        }).eq('id', contactId);

    } catch (e) {
        logger.warn('[supabase-dm] Failed to sync conversion:', e);
    }
}

// ── Sync relationship data to Supabase ─────────────────────────────

export async function syncRelationshipToSupabase(
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
                synced_at: new Date().toISOString()
            }
        }).eq('id', contactId);

    } catch (e) {
        logger.warn('[supabase-dm] Failed to sync relationship:', e);
    }
}

// ── Sync profile data to Supabase ──────────────────────────────────

export async function syncProfileToSupabase(username: string, profileData: {
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
        // Only set display_name if it's a real name (not a number like post count)
        if (profileData.fullName && !/^\d+$/.test(profileData.fullName)) {
            update.display_name = profileData.fullName;
        }
        if (profileData.bio) update.bio = profileData.bio;
        if (profileData.followerCount !== undefined) {
            update.follower_count_updated_at = new Date().toISOString();
        }

        await sb.from('crm_contacts').update(update).eq('id', contactId);

    } catch (e) {
        logger.warn('[supabase-dm] Failed to sync profile:', e);
    }
}

// ── Bulk sync all local data to Supabase ───────────────────────────

export async function bulkSyncToSupabase(): Promise<{
    conversations: number;
    messages: number;
    feedback: number;
    errors: string[];
}> {
    const sb = getClient();
    if (!sb) return { conversations: 0, messages: 0, feedback: 0, errors: ['Supabase not configured'] };

    const stats = { conversations: 0, messages: 0, feedback: 0, errors: [] as string[] };

    // Sync relationships → crm_contacts
    const relDir = path.join(process.cwd(), 'logs', 'tracking', 'dm', 'relationships');
    if (fs.existsSync(relDir)) {
        for (const f of fs.readdirSync(relDir).filter(f => f.endsWith('.json'))) {
            try {
                const username = f.replace('.json', '');
                const rel = JSON.parse(fs.readFileSync(path.join(relDir, f), 'utf8'));
                await syncRelationshipToSupabase(username, rel.category, rel.warmth, rel.stage, rel.tags || []);
                stats.conversations++;
            } catch (e) {
                stats.errors.push(`rel: ${f}: ${e}`);
            }
        }
    }

    // Sync profiles → crm_contacts
    const profileDir = path.join(process.cwd(), 'logs', 'tracking', 'dm', 'profiles');
    if (fs.existsSync(profileDir)) {
        for (const f of fs.readdirSync(profileDir).filter(f => f.endsWith('.json'))) {
            try {
                const data = JSON.parse(fs.readFileSync(path.join(profileDir, f), 'utf8'));
                await syncProfileToSupabase(data.username, data);
            } catch (e) {
                stats.errors.push(`profile: ${f}: ${e}`);
            }
        }
    }

    // Sync messages → crm_messages + platform_dms
    const msgFile = path.join(process.cwd(), 'logs', 'tracking', 'dm', 'messages.json');
    if (fs.existsSync(msgFile)) {
        try {
            const messages: TrackedDM[] = JSON.parse(fs.readFileSync(msgFile, 'utf8'));
            for (const msg of messages) {
                await syncDMToSupabase(msg);
                stats.messages++;
            }
        } catch (e) {
            stats.errors.push(`msgs: ${e}`);
        }
    }

    // Sync feedback → dm_message_performance
    const fbFile = path.join(process.cwd(), 'logs', 'tracking', 'dm', 'feedback.json');
    if (fs.existsSync(fbFile)) {
        try {
            const feedbacks: MessageFeedback[] = JSON.parse(fs.readFileSync(fbFile, 'utf8'));
            for (const fb of feedbacks) {
                await syncFeedbackToSupabase(fb);
                stats.feedback++;
            }
        } catch (e) {
            stats.errors.push(`feedback: ${e}`);
        }
    }

    logger.info(`[supabase-dm] Bulk sync: ${stats.conversations} contacts, ${stats.messages} msgs, ${stats.feedback} feedback, ${stats.errors.length} errors`);
    return stats;
}
