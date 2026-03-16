import OpenAI from 'openai';
import { logger } from '../utils/logger';
import { formatError, sanitizeForPrompt } from '../utils/errors';
import { ProfileInfo, RelationshipInfo, DMMessage } from '../types/dm';
import { getLearningContextForAI, recordTimingStat } from './Twitter-DM-Analytics';
import { syncTwitterRelationshipToSupabase, syncTwitterFeedbackToSupabase } from '../db/supabaseTwitterDM';
import * as fs from 'fs';
import * as path from 'path';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ── Relationship Store ──────────────────────────────────────────────

const RELATIONSHIPS_DIR = path.join(process.cwd(), 'logs', 'tracking', 'twitter-dm', 'relationships');

function ensureDir() {
    if (!fs.existsSync(RELATIONSHIPS_DIR)) fs.mkdirSync(RELATIONSHIPS_DIR, { recursive: true });
}

export function loadRelationship(username: string): RelationshipInfo {
    try {
        ensureDir();
        const filePath = path.join(RELATIONSHIPS_DIR, `${username.toLowerCase()}.json`);
        if (fs.existsSync(filePath)) {
            return JSON.parse(fs.readFileSync(filePath, 'utf8'));
        }
    } catch (e) { logger.warn('[twitter-dm-ai] Failed to load relationship: ' + formatError(e)); }
    return {
        category: 'personal',
        warmth: 0,
        stage: 'cold_outreach',
        notes: [],
        tags: []
    };
}

export function saveRelationship(username: string, rel: RelationshipInfo) {
    try {
        ensureDir();
        const filePath = path.join(RELATIONSHIPS_DIR, `${username.toLowerCase()}.json`);
        rel.lastInteraction = new Date().toISOString();
        fs.writeFileSync(filePath, JSON.stringify(rel, null, 2));
        logger.info(`[twitter-dm-ai] Saved relationship for @${username}: ${rel.category}, warmth=${rel.warmth}, stage=${rel.stage}`);

        // Sync to Supabase (fire-and-forget)
        syncTwitterRelationshipToSupabase(username, rel.category, rel.warmth, rel.stage, rel.tags || []).catch(() => {});
    } catch (e) {
        logger.error('[twitter-dm-ai] Failed to save relationship', e);
    }
}

export function getAllRelationships(): Record<string, RelationshipInfo> {
    try {
        ensureDir();
        const files = fs.readdirSync(RELATIONSHIPS_DIR).filter(f => f.endsWith('.json'));
        const rels: Record<string, RelationshipInfo> = {};
        for (const f of files) {
            const username = f.replace('.json', '');
            rels[username] = JSON.parse(fs.readFileSync(path.join(RELATIONSHIPS_DIR, f), 'utf8'));
        }
        return rels;
    } catch (e) { logger.warn('[twitter-dm-ai] Failed to load all relationships: ' + formatError(e)); }
    return {};
}

// ── Auto-categorize a contact based on their profile ────────────────

export function categorizeContact(theirProfile: ProfileInfo): Partial<RelationshipInfo> {
    const bio = (theirProfile.bio || '').toLowerCase();
    const followers = theirProfile.followerCount || 0;

    const businessKeywords = ['founder', 'ceo', 'cto', 'entrepreneur', 'agency', 'consulting',
        'marketing', 'growth', 'startup', 'investor', 'coach', 'business',
        'digital marketing', 'saas', 'venture', 'mentor', 'strategist'];

    const creatorKeywords = ['creator', 'content', 'influencer', 'youtuber', 'podcaster',
        'photographer', 'filmmaker', 'artist', 'designer', 'developer',
        'engineer', 'builder', 'maker'];

    const clientKeywords = ['looking for', 'need help', 'hiring', 'small business',
        'shop', 'store', 'brand', 'local'];

    const hasBusiness = businessKeywords.some(k => bio.includes(k));
    const hasCreator = creatorKeywords.some(k => bio.includes(k));
    const hasClient = clientKeywords.some(k => bio.includes(k));

    let category: RelationshipInfo['category'] = 'personal';
    const tags: string[] = [];

    if (hasBusiness && followers > 5000) {
        category = 'business_networking';
        tags.push('high_value');
    } else if (hasBusiness) {
        category = 'business_networking';
    } else if (hasCreator && followers > 1000) {
        category = 'collaborator';
        tags.push('creator');
    } else if (hasClient) {
        category = 'potential_client';
    } else if (hasCreator) {
        category = 'collaborator';
    }

    if (followers > 100000) tags.push('macro_influencer');
    else if (followers > 10000) tags.push('micro_influencer');
    if (theirProfile.isVerified) tags.push('verified');

    return { category, tags };
}

// ── Update warmth score based on interactions ───────────────────────

export function updateWarmth(username: string, event: 'message_sent' | 'reply_received' | 'no_reply' | 'positive_reply' | 'negative_reply'): RelationshipInfo {
    const rel = loadRelationship(username);

    switch (event) {
        case 'message_sent':
            rel.warmth = Math.min(100, rel.warmth + 5);
            if (rel.stage === 'cold_outreach') rel.stage = 'initial_contact';
            break;
        case 'reply_received':
            rel.warmth = Math.min(100, rel.warmth + 15);
            if (rel.stage === 'initial_contact') rel.stage = 'building';
            break;
        case 'positive_reply':
            rel.warmth = Math.min(100, rel.warmth + 25);
            if (rel.stage === 'building') rel.stage = 'warm';
            break;
        case 'negative_reply':
            rel.warmth = Math.max(0, rel.warmth - 20);
            break;
        case 'no_reply':
            rel.warmth = Math.max(0, rel.warmth - 5);
            break;
    }

    // Auto-advance stage based on warmth
    if (rel.warmth >= 70 && rel.stage !== 'active') rel.stage = 'warm';
    if (rel.warmth >= 90) rel.stage = 'active';

    saveRelationship(username, rel);
    return rel;
}

// ── AI Message Generation ───────────────────────────────────────────

export async function generateDMMessage(context: {
    ourProfile: ProfileInfo;
    theirProfile: ProfileInfo;
    conversationHistory: DMMessage[];
    relationship: RelationshipInfo;
    objective?: string;
    isJackpot?: boolean;
}): Promise<string> {
    const { ourProfile, theirProfile, conversationHistory, relationship, objective, isJackpot } = context;

    // Build conversation history string
    const recentMessages = conversationHistory.slice(-10);
    const historyStr = recentMessages.length > 0
        ? recentMessages.map(m => `${m.isOurs ? 'You' : 'Them'}: ${sanitizeForPrompt(m.text, 300)}`).join('\n')
        : '(No prior conversation — this is the first message)';

    const autoObjective = getStageObjective(relationship);
    const messageObjective = objective || autoObjective;

    // Get feedback-informed learning context
    let learningContext = '';
    try {
        learningContext = getLearningContextForAI(relationship.category, relationship.stage);
    } catch (e) { logger.warn('[twitter-dm-ai] Failed to load learning context: ' + formatError(e)); }

    // ── Nurture context enrichment ──────────────────────────────
    let tierContext = '';
    let interestContext = '';
    let crossPlatformContext = '';
    try {
        const { getTierForMessage } = await import('../nurture/tiers');
        const { getBestInterestForMessage } = await import('../nurture/interests');
        const { getCrossContext } = await import('../nurture/cross-platform');
        const { loadNurtureProfile } = await import('../nurture/store');

        const nurture = loadNurtureProfile(theirProfile.username, 'twitter');
        const tierHints = getTierForMessage(nurture.tier);
        tierContext = `\nFriendship tier: ${nurture.tier.replace('_', ' ')}. ${tierHints.style} ${tierHints.depthHint}`;

        const interest = getBestInterestForMessage(theirProfile.username, 'twitter');
        if (interest) interestContext = `\n${interest.context}`;

        crossPlatformContext = getCrossContext(theirProfile.username, 'twitter');
        if (crossPlatformContext) crossPlatformContext = `\n${crossPlatformContext}`;
    } catch (e) { /* nurture not initialized yet — no-op */ }

    const systemPrompt = `You are an AI assistant helping craft Twitter/X DMs for a growth-oriented social media strategy. You write messages that are authentic, personable, and never spammy.

About us:
- Username: @${ourProfile.username}
- Name: ${ourProfile.fullName || ourProfile.username}
- Bio: ${ourProfile.bio || 'Tech/AI enthusiast and content creator'}
- Followers: ${ourProfile.followerCount || 'N/A'}

About them:
- Username: @${sanitizeForPrompt(theirProfile.username, 50)}
- Name: ${sanitizeForPrompt(theirProfile.fullName || theirProfile.username, 100)}
- Bio: ${sanitizeForPrompt(theirProfile.bio || 'N/A', 300)}
- Followers: ${theirProfile.followerCount || 'N/A'}
- Verified: ${theirProfile.isVerified ? 'Yes' : 'No'}

Relationship:
- Category: ${relationship.category}
- Warmth: ${relationship.warmth}/100
- Stage: ${relationship.stage}
${relationship.notes.length > 0 ? `- Notes: ${relationship.notes.map(n => sanitizeForPrompt(n, 150)).join('; ')}` : ''}
${relationship.tags.length > 0 ? `- Tags: ${relationship.tags.join(', ')}` : ''}
${tierContext}${interestContext}${crossPlatformContext}

Rules:
1. Be genuine and conversational — no corporate speak
2. Reference something specific about their tweets or bio when possible
3. Keep it concise (1-3 sentences max)
4. Match the tone of the conversation history
5. Don't be pushy or salesy (even if the objective involves an offer)
6. If this is a cold outreach, find genuine common ground
7. Never say "I noticed your profile" or other generic openers
8. Use emojis sparingly (0-2 max)
9. Sound like a real person, not a bot
10. This is Twitter/X — keep it casual and brief, reference tweets or @handles naturally
${isJackpot ? `\n🎰 JACKPOT REPLY: Go above and beyond — write a longer, more thoughtful, more personal message. Reference specific details about them. Share a genuine personal story or insight. Make this reply feel special and memorable. Use 3-5 sentences instead of 1-3.` : ''}
${learningContext ? `\nPerformance Insights:\n${learningContext}` : ''}`;

    const userPrompt = `Conversation history:
${historyStr}

Objective for this message: ${messageObjective}

Generate the next message to send. Just the message text, nothing else.`;

    try {
        const completion = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt }
            ],
            max_tokens: isJackpot ? 300 : 150,
            temperature: isJackpot ? 0.9 : 0.8
        });

        const message = completion.choices[0]?.message?.content?.trim();
        if (!message) throw new Error('OpenAI returned empty response');

        const cleaned = message.replace(/^["']|["']$/g, '').trim();
        logger.info(`[twitter-dm-ai] Generated ${isJackpot ? 'JACKPOT ' : ''}message for @${theirProfile.username}: "${cleaned.slice(0, 50)}..."`);
        return cleaned;
    } catch (e) {
        logger.error('[twitter-dm-ai] Failed to generate message:', e);
        throw e;
    }
}

// ── Reply-specific objective (for auto-reply pipeline) ──────────────

export function getReplyObjective(relationship: RelationshipInfo, theirLastMessage: string): string {
    const lower = theirLastMessage.toLowerCase();

    const negativeWords = ['no thanks', 'not interested', 'stop', 'don\'t', 'spam',
        'unsubscribe', 'leave me alone', 'block', 'report', 'annoying', 'scam'];
    const isNegative = negativeWords.some(w => lower.includes(w));

    if (isNegative) {
        return 'They seem unhappy or uninterested. Respond gracefully — acknowledge, apologize if needed, offer to back off.';
    }

    switch (relationship.stage) {
        case 'cold_outreach':
        case 'initial_contact':
            return 'They replied! Respond naturally to what they said. Ask a follow-up question. Build rapport — do NOT pitch anything.';
        case 'building':
            return 'Continue the conversation naturally. Respond specifically to their message. Share value or insight.';
        case 'warm':
        case 'active':
            return 'You have a good relationship. Respond conversationally. Be helpful and genuine.';
        default:
            return 'Respond naturally to their message. Be conversational and genuine.';
    }
}

// ── Stage-based objective mapping ────────────────────────────────────

function getStageObjective(rel: RelationshipInfo): string {
    switch (rel.stage) {
        case 'cold_outreach':
            if (rel.category === 'business_networking')
                return 'Start a conversation by finding common ground in business/tech. Be curious about their work. Reference their recent tweets if possible.';
            if (rel.category === 'collaborator')
                return 'Compliment their content genuinely and start a casual conversation. Mention a specific tweet if possible.';
            if (rel.category === 'potential_client')
                return 'Start with genuine interest in their business. Ask about what they do.';
            return 'Start a friendly, casual conversation. Find something in common from their tweets or bio.';

        case 'initial_contact':
            return 'Continue building rapport. Ask a thoughtful question about something they shared or their work.';

        case 'building':
            return 'Deepen the relationship. Share something valuable or relevant to their interests. Offer help or insight.';

        case 'warm':
            if (rel.category === 'business_networking')
                return 'Explore potential collaboration or mutual value. Suggest connecting further.';
            if (rel.category === 'potential_client')
                return 'Naturally bring up how you could help with something relevant to their needs. Be helpful, not pushy.';
            return 'Maintain the relationship with genuine engagement. Share something interesting.';

        case 'active':
            if (rel.category === 'potential_client')
                return 'If appropriate, introduce a specific offer or service that matches their needs. Frame it as helping, not selling.';
            return 'Keep the conversation going naturally. You have a strong relationship.';

        default:
            return 'Send a friendly, genuine message.';
    }
}

// ── Generate first outreach message (convenience function) ──────────

export async function generateColdOutreach(
    ourProfile: ProfileInfo,
    theirProfile: ProfileInfo
): Promise<string> {
    const autoCategory = categorizeContact(theirProfile);
    const relationship: RelationshipInfo = {
        category: autoCategory.category || 'personal',
        warmth: 0,
        stage: 'cold_outreach',
        notes: [],
        tags: autoCategory.tags || []
    };

    return generateDMMessage({
        ourProfile,
        theirProfile,
        conversationHistory: [],
        relationship
    });
}

// ── Generate follow-up message based on conversation ────────────────

export async function generateFollowUp(
    ourProfile: ProfileInfo,
    theirProfile: ProfileInfo,
    conversationHistory: DMMessage[],
    username: string
): Promise<string> {
    const relationship = loadRelationship(username);
    return generateDMMessage({
        ourProfile,
        theirProfile,
        conversationHistory,
        relationship
    });
}

// ── Feedback: track if a message got a reply ────────────────────────

export interface MessageFeedback {
    messageId: string;
    recipientUsername: string;
    messageSentAt: string;
    gotReply: boolean;
    replyText?: string;
    replySentiment?: 'positive' | 'neutral' | 'negative';
    replyWithinHours?: number;
}

const FEEDBACK_FILE = path.join(process.cwd(), 'logs', 'tracking', 'twitter-dm', 'feedback.json');

const MAX_FEEDBACK_ENTRIES = 1000;

export function recordFeedback(feedback: MessageFeedback) {
    try {
        let feedbacks: MessageFeedback[] = [];
        if (fs.existsSync(FEEDBACK_FILE)) {
            feedbacks = JSON.parse(fs.readFileSync(FEEDBACK_FILE, 'utf8'));
        }
        feedbacks.push(feedback);
        // Cap at MAX_FEEDBACK_ENTRIES to prevent unbounded growth
        if (feedbacks.length > MAX_FEEDBACK_ENTRIES) {
            feedbacks = feedbacks.slice(-MAX_FEEDBACK_ENTRIES);
        }
        fs.writeFileSync(FEEDBACK_FILE, JSON.stringify(feedbacks, null, 2));

        // Update warmth based on feedback
        if (feedback.gotReply) {
            if (feedback.replySentiment === 'positive') {
                updateWarmth(feedback.recipientUsername, 'positive_reply');
            } else if (feedback.replySentiment === 'negative') {
                updateWarmth(feedback.recipientUsername, 'negative_reply');
            } else {
                updateWarmth(feedback.recipientUsername, 'reply_received');
            }
        } else {
            updateWarmth(feedback.recipientUsername, 'no_reply');
        }

        // Record timing stats for optimization
        try {
            recordTimingStat(new Date(feedback.messageSentAt), feedback.gotReply);
        } catch (e) { logger.warn('[twitter-dm-ai] Failed to record timing stat: ' + formatError(e)); }

        // Sync to Supabase (fire-and-forget)
        syncTwitterFeedbackToSupabase(feedback).catch(() => {});

        logger.info(`[twitter-dm-ai] Feedback recorded for @${feedback.recipientUsername}: reply=${feedback.gotReply}, sentiment=${feedback.replySentiment || 'n/a'}`);
    } catch (e) {
        logger.error('[twitter-dm-ai] Failed to record feedback', e);
    }
}

export function getFeedbackStats(): { totalSent: number; gotReply: number; replyRate: number; sentimentBreakdown: Record<string, number> } {
    try {
        if (!fs.existsSync(FEEDBACK_FILE)) return { totalSent: 0, gotReply: 0, replyRate: 0, sentimentBreakdown: {} };
        const feedbacks: MessageFeedback[] = JSON.parse(fs.readFileSync(FEEDBACK_FILE, 'utf8'));
        const totalSent = feedbacks.length;
        const gotReply = feedbacks.filter(f => f.gotReply).length;
        const sentimentBreakdown: Record<string, number> = {};
        for (const f of feedbacks.filter(f => f.gotReply && f.replySentiment)) {
            sentimentBreakdown[f.replySentiment!] = (sentimentBreakdown[f.replySentiment!] || 0) + 1;
        }
        return {
            totalSent,
            gotReply,
            replyRate: totalSent > 0 ? Math.round((gotReply / totalSent) * 100) : 0,
            sentimentBreakdown
        };
    } catch (e) { logger.warn('[twitter-dm-ai] Failed to load feedback stats: ' + formatError(e)); }
    return { totalSent: 0, gotReply: 0, replyRate: 0, sentimentBreakdown: {} };
}
