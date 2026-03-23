/**
 * Conversation Depth Analysis — Tracks conversation quality for tier promotion.
 */

import { logger } from '../utils/logger';
import { formatError } from '../utils/errors';
import { ConversationDepthMetrics } from '../types/nurture';
import { loadNurtureProfile, saveNurtureProfile } from './store';
import { chatCompletion } from '../utils/ai';
import dotenv from 'dotenv';

dotenv.config({ override: true });

// OpenAI replaced by shared Anthropic wrapper (chatCompletion)

// ── Analyze conversation depth ──────────────────────────────────────

export async function analyzeConversationDepth(
    username: string,
    platform: 'twitter' | 'instagram',
    messages: Array<{ text: string; direction: 'inbound' | 'outbound'; timestamp: string }>
): Promise<ConversationDepthMetrics> {
    const theirMessages = messages.filter(m => m.direction === 'inbound');
    const allTexts = messages.map(m => m.text);

    // Average message length (their messages only)
    const avgMessageLength = theirMessages.length > 0
        ? Math.round(theirMessages.reduce((sum, m) => sum + m.text.length, 0) / theirMessages.length)
        : 0;

    // Question asking ratio
    const theirQuestions = theirMessages.filter(m => m.text.includes('?')).length;
    const questionAskingRatio = theirMessages.length > 0
        ? Math.round((theirQuestions / theirMessages.length) * 100) / 100
        : 0;

    // Topic variety + disclosure level via AI (batched in one call)
    let topicVariety = 0;
    let personalDisclosureLevel = 0;

    if (allTexts.length >= 3) {
        try {
            const analysis = await analyzeWithAI(allTexts, username);
            topicVariety = analysis.topicVariety;
            personalDisclosureLevel = analysis.disclosureLevel;
        } catch (e) {
            logger.warn(`[depth] AI analysis failed for @${username}: ${formatError(e)}`);
        }
    }

    // Composite quality score
    const conversationQualityScore = Math.round(
        personalDisclosureLevel * 0.30 +
        Math.min(topicVariety * 10, 100) * 0.25 +
        Math.min(avgMessageLength / 2, 100) * 0.25 +
        questionAskingRatio * 100 * 0.20
    );

    const metrics: ConversationDepthMetrics = {
        username: username.toLowerCase(),
        platform,
        avgMessageLength,
        topicVariety,
        personalDisclosureLevel,
        questionAskingRatio,
        conversationQualityScore,
        exchangeCount: messages.length,
        lastCalculated: new Date().toISOString(),
    };

    // Update nurture profile
    const profile = loadNurtureProfile(username, platform);
    profile.depth = metrics;
    saveNurtureProfile(profile);

    logger.info(`[depth] @${username} (${platform}): quality=${conversationQualityScore}, topics=${topicVariety}, disclosure=${personalDisclosureLevel}`);
    return metrics;
}

// ── AI analysis (single call for topic variety + disclosure) ────────

async function analyzeWithAI(texts: string[], username: string): Promise<{
    topicVariety: number;
    disclosureLevel: number;
}> {
    const sample = texts.slice(-20).join('\n---\n'); // last 20 messages max

    const raw = await chatCompletion({
        messages: [
            {
                role: 'system',
                content: 'Analyze conversation messages and return JSON only. No explanation.',
            },
            {
                role: 'user',
                content: `Analyze these DM messages with @${username}:

${sample}

Return JSON with:
1. "topicVariety": number of distinct topics discussed (1-20)
2. "disclosureLevel": how personal/vulnerable the messages are (0-100, where 0=purely transactional, 50=sharing opinions/experiences, 100=deeply personal)

Reply ONLY with valid JSON like: {"topicVariety": 5, "disclosureLevel": 40}`,
            },
        ],
        max_tokens: 50,
        temperature: 0.3,
    }) || '{}';
    try {
        const parsed = JSON.parse(raw);
        return {
            topicVariety: Math.min(Math.max(parsed.topicVariety || 0, 0), 20),
            disclosureLevel: Math.min(Math.max(parsed.disclosureLevel || 0, 0), 100),
        };
    } catch {
        return { topicVariety: 0, disclosureLevel: 0 };
    }
}

// ── Depth promotion bonus ───────────────────────────────────────────

/**
 * Returns 0-30 bonus points toward tier promotion.
 * Deep conversations (quality > 70) get max bonus.
 */
export function getDepthPromoBonus(metrics: ConversationDepthMetrics): number {
    if (metrics.conversationQualityScore >= 70) return 30;
    if (metrics.conversationQualityScore >= 50) return 20;
    if (metrics.conversationQualityScore >= 30) return 10;
    return 0;
}

/**
 * Whether depth metrics should be recalculated (stale > 24h or significant new messages).
 */
export function shouldRecalculateDepth(
    username: string,
    platform: 'twitter' | 'instagram',
    currentMessageCount: number
): boolean {
    const profile = loadNurtureProfile(username, platform);
    const hoursSinceCalc = (Date.now() - new Date(profile.depth.lastCalculated).getTime()) / (1000 * 60 * 60);

    // Recalculate if stale (>24h) or 5+ new messages
    if (hoursSinceCalc > 24) return true;
    if (currentMessageCount - profile.depth.exchangeCount >= 5) return true;
    return false;
}
