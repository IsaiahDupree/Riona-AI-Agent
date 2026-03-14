/**
 * Interest Matching — Extract, track, and match interests for friendship nurture.
 */

import { logger } from '../utils/logger';
import { formatError } from '../utils/errors';
import { InterestProfile, InterestEntry, InterestMatchScore } from '../types/nurture';
import { loadNurtureProfile, saveNurtureProfile } from './store';
import OpenAI from 'openai';
import dotenv from 'dotenv';

dotenv.config();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || '' });

// ── Our interests (from env or defaults) ────────────────────────────

export function getOurInterests(): InterestEntry[] {
    const raw = process.env.OUR_INTERESTS || process.env.TWITTER_NICHE_HASHTAGS || 'AI,technology,automation';
    return raw.split(',').map(topic => ({
        topic: topic.trim().toLowerCase(),
        confidence: 1.0,
        source: 'bio' as const,
        firstSeen: new Date().toISOString(),
        mentions: 1,
    }));
}

// ── Extract interests from bio text ─────────────────────────────────

const INTEREST_KEYWORDS: Record<string, string[]> = {
    'artificial intelligence': ['ai', 'artificial intelligence', 'machine learning', 'ml', 'deep learning', 'neural', 'llm', 'gpt'],
    'entrepreneurship': ['founder', 'entrepreneur', 'startup', 'ceo', 'building', 'bootstrapped'],
    'marketing': ['marketing', 'growth', 'seo', 'content', 'brand', 'social media'],
    'design': ['design', 'ux', 'ui', 'figma', 'creative', 'visual'],
    'engineering': ['engineer', 'developer', 'coding', 'programming', 'software', 'fullstack'],
    'crypto': ['crypto', 'web3', 'blockchain', 'defi', 'nft', 'bitcoin', 'ethereum'],
    'finance': ['finance', 'investing', 'trading', 'fintech', 'stocks'],
    'health': ['health', 'fitness', 'wellness', 'biohacking', 'nutrition'],
    'writing': ['writer', 'author', 'writing', 'content creator', 'newsletter', 'blogger'],
    'education': ['teacher', 'education', 'learning', 'mentor', 'coaching'],
    'automation': ['automation', 'no-code', 'low-code', 'workflow', 'productivity'],
    'data science': ['data science', 'analytics', 'data engineering', 'statistics'],
    'photography': ['photography', 'photographer', 'visual storytelling'],
    'music': ['music', 'musician', 'producer', 'beats', 'audio'],
    'gaming': ['gaming', 'game dev', 'esports', 'streamer'],
};

export function extractInterestsFromBio(bio: string): InterestEntry[] {
    if (!bio) return [];
    const lower = bio.toLowerCase();
    const now = new Date().toISOString();
    const interests: InterestEntry[] = [];

    for (const [topic, keywords] of Object.entries(INTEREST_KEYWORDS)) {
        const matched = keywords.filter(kw => lower.includes(kw));
        if (matched.length > 0) {
            interests.push({
                topic,
                confidence: Math.min(matched.length * 0.3, 1.0),
                source: 'bio',
                firstSeen: now,
                mentions: matched.length,
            });
        }
    }

    return interests;
}

// ── Extract interests via AI from post texts ────────────────────────

export async function extractInterestsWithAI(texts: string[]): Promise<InterestEntry[]> {
    if (texts.length === 0) return [];

    const sample = texts.slice(0, 15).join('\n---\n');
    try {
        const completion = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [
                {
                    role: 'system',
                    content: 'Extract interests/topics from these posts. Return JSON array only.',
                },
                {
                    role: 'user',
                    content: `Extract the main interests and topics from these posts:\n\n${sample}\n\nReturn a JSON array of strings, e.g.: ["AI", "startups", "fitness"]\nMax 10 topics. Reply ONLY with the JSON array.`,
                },
            ],
            max_tokens: 100,
            temperature: 0.3,
        });

        const raw = completion.choices[0]?.message?.content?.trim() || '[]';
        const parsed = JSON.parse(raw);
        const now = new Date().toISOString();

        return (Array.isArray(parsed) ? parsed : []).map((topic: string) => ({
            topic: topic.toLowerCase(),
            confidence: 0.7,
            source: 'post' as const,
            firstSeen: now,
            mentions: 1,
        }));
    } catch (e) {
        logger.warn(`[interests] AI extraction failed: ${formatError(e)}`);
        return [];
    }
}

// ── Update interest profile (merge new entries) ─────────────────────

export function updateInterestProfile(
    username: string,
    platform: 'twitter' | 'instagram',
    newEntries: InterestEntry[]
): InterestProfile {
    const profile = loadNurtureProfile(username, platform);
    const existing = profile.interests.interests;

    for (const entry of newEntries) {
        const found = existing.find(e => e.topic === entry.topic);
        if (found) {
            found.mentions += entry.mentions;
            found.confidence = Math.min(found.confidence + 0.1, 1.0);
        } else {
            existing.push(entry);
        }
    }

    profile.interests.lastUpdated = new Date().toISOString();
    saveNurtureProfile(profile);
    return profile.interests;
}

// ── Score interest overlap ──────────────────────────────────────────

export function scoreInterestOverlap(username: string, platform: 'twitter' | 'instagram'): InterestMatchScore {
    const profile = loadNurtureProfile(username, platform);
    const ourInterests = getOurInterests().map(i => i.topic);
    const theirInterests = profile.interests.interests.map(i => i.topic);

    const shared = theirInterests.filter(t => ourInterests.some(o => t.includes(o) || o.includes(t)));
    const unique = theirInterests.filter(t => !shared.includes(t));

    const overlapScore = theirInterests.length > 0
        ? Math.round((shared.length / Math.max(theirInterests.length, ourInterests.length)) * 100)
        : 0;

    // Best interest for DM: highest overlap + best historical performance
    const perf = profile.interestMessagePerformance;
    let bestInterest = shared[0] || theirInterests[0] || '';
    let bestScore = -Infinity;

    for (const topic of shared) {
        const p = perf[topic];
        if (p && p.sent > 0) {
            const rate = (p.replied || 0) / p.sent;
            if (rate > bestScore) {
                bestScore = rate;
                bestInterest = topic;
            }
        }
    }

    return {
        username,
        overlapScore,
        sharedInterests: shared,
        theirUniqueInterests: unique,
        bestInterestForDM: bestInterest,
    };
}

// ── Get best interest for next message ──────────────────────────────

export function getBestInterestForMessage(
    username: string,
    platform: 'twitter' | 'instagram'
): { topic: string; context: string } | null {
    const match = scoreInterestOverlap(username, platform);
    if (!match.bestInterestForDM) return null;

    const shared = match.sharedInterests.length > 0
        ? `Shared interests: ${match.sharedInterests.join(', ')}.`
        : '';

    return {
        topic: match.bestInterestForDM,
        context: `${shared} Reference "${match.bestInterestForDM}" naturally in your message.`,
    };
}

// ── Track interest message performance ──────────────────────────────

export function recordInterestMessageResult(
    username: string,
    platform: 'twitter' | 'instagram',
    topic: string,
    gotReply: boolean
): void {
    const profile = loadNurtureProfile(username, platform);
    if (!profile.interestMessagePerformance[topic]) {
        profile.interestMessagePerformance[topic] = { sent: 0, replied: 0 };
    }
    profile.interestMessagePerformance[topic].sent++;
    if (gotReply) profile.interestMessagePerformance[topic].replied++;
    saveNurtureProfile(profile);
}
