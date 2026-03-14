/**
 * Cross-Platform Identity — Link Twitter ↔ Instagram identities, coordinate messaging.
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../utils/logger';
import { safeReadJSON, safeWriteJSON, formatError } from '../utils/errors';
import { CrossPlatformIdentity, CrossPlatformState, FriendshipTier } from '../types/nurture';
import { loadNurtureProfile } from './store';

// ── File paths ──────────────────────────────────────────────────────

const CROSS_DIR = path.join(process.cwd(), 'logs', 'tracking', 'nurture', 'cross-platform');
const IDENTITIES_FILE = path.join(CROSS_DIR, 'identities.json');

function ensureDir() {
    if (!fs.existsSync(CROSS_DIR)) fs.mkdirSync(CROSS_DIR, { recursive: true });
}

// ── Identity persistence ────────────────────────────────────────────

export function loadIdentities(): CrossPlatformIdentity[] {
    ensureDir();
    return safeReadJSON<CrossPlatformIdentity[]>(IDENTITIES_FILE, [], 'cross_platform_identities');
}

export function saveIdentities(identities: CrossPlatformIdentity[]): void {
    ensureDir();
    safeWriteJSON(IDENTITIES_FILE, identities, 'cross_platform_identities');
}

// ── Link identities ─────────────────────────────────────────────────

export function linkIdentity(
    twitterHandle: string,
    instagramHandle: string,
    evidence: string[],
    confidence: 'manual' | 'high' | 'medium' = 'medium'
): CrossPlatformIdentity {
    const identities = loadIdentities();

    // Check if link already exists
    const existing = identities.find(i =>
        (i.twitterHandle?.toLowerCase() === twitterHandle.toLowerCase()) ||
        (i.instagramHandle?.toLowerCase() === instagramHandle.toLowerCase())
    );

    if (existing) {
        existing.twitterHandle = twitterHandle.toLowerCase();
        existing.instagramHandle = instagramHandle.toLowerCase();
        existing.linkEvidence = [...new Set([...existing.linkEvidence, ...evidence])];
        if (confidence === 'manual' || (confidence === 'high' && existing.linkConfidence !== 'manual')) {
            existing.linkConfidence = confidence;
        }
        saveIdentities(identities);
        logger.info(`[cross-platform] Updated link: @${twitterHandle} ↔ @${instagramHandle}`);
        return existing;
    }

    const identity: CrossPlatformIdentity = {
        id: `person_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        twitterHandle: twitterHandle.toLowerCase(),
        instagramHandle: instagramHandle.toLowerCase(),
        linkedAt: new Date().toISOString(),
        linkConfidence: confidence,
        linkEvidence: evidence,
    };

    identities.push(identity);
    saveIdentities(identities);
    logger.info(`[cross-platform] Linked: @${twitterHandle} (Twitter) ↔ @${instagramHandle} (IG) [${confidence}]`);
    return identity;
}

// ── Find person by handle ───────────────────────────────────────────

export function findPersonByHandle(handle: string, platform: 'twitter' | 'instagram'): CrossPlatformIdentity | null {
    const identities = loadIdentities();
    const lower = handle.toLowerCase();

    return identities.find(i => {
        if (platform === 'twitter') return i.twitterHandle === lower;
        return i.instagramHandle === lower;
    }) || null;
}

// ── Auto-detect links ───────────────────────────────────────────────

export function autoDetectLinks(): CrossPlatformIdentity[] {
    const newLinks: CrossPlatformIdentity[] = [];

    // Scan relationship files for cross-references
    const twitterRelDir = path.join(process.cwd(), 'logs', 'tracking', 'twitter-dm', 'relationships');
    const igRelDir = path.join(process.cwd(), 'logs', 'tracking', 'dm', 'relationships');

    const twitterUsers = readUsernamesFromDir(twitterRelDir);
    const igUsers = readUsernamesFromDir(igRelDir);

    // Strategy 1: Exact username match
    for (const twUser of twitterUsers) {
        if (igUsers.includes(twUser) && !findPersonByHandle(twUser, 'twitter')) {
            const link = linkIdentity(twUser, twUser, ['exact username match'], 'medium');
            newLinks.push(link);
        }
    }

    // Strategy 2: Bio cross-references (would need bio data — skip if not available)

    if (newLinks.length > 0) {
        logger.info(`[cross-platform] Auto-detected ${newLinks.length} new cross-platform links`);
    }

    return newLinks;
}

function readUsernamesFromDir(dir: string): string[] {
    try {
        if (!fs.existsSync(dir)) return [];
        return fs.readdirSync(dir)
            .filter(f => f.endsWith('.json'))
            .map(f => f.replace('.json', '').toLowerCase());
    } catch {
        return [];
    }
}

// ── Cross-platform state ────────────────────────────────────────────

export function getCrossState(personId: string): CrossPlatformState | null {
    const identities = loadIdentities();
    const identity = identities.find(i => i.id === personId);
    if (!identity) return null;

    let combinedWarmth = 0;
    let highestTier: FriendshipTier = 'acquaintance';
    let lastTwitter: string | undefined;
    let lastIG: string | undefined;

    const tierOrder: FriendshipTier[] = ['acquaintance', 'casual_friend', 'close_friend', 'inner_circle'];

    if (identity.twitterHandle) {
        const twProfile = loadNurtureProfile(identity.twitterHandle, 'twitter');
        if (tierOrder.indexOf(twProfile.tier) > tierOrder.indexOf(highestTier)) {
            highestTier = twProfile.tier;
        }
        lastTwitter = twProfile.lastCheckIn;
    }

    if (identity.instagramHandle) {
        const igProfile = loadNurtureProfile(identity.instagramHandle, 'instagram');
        if (tierOrder.indexOf(igProfile.tier) > tierOrder.indexOf(highestTier)) {
            highestTier = igProfile.tier;
        }
        lastIG = igProfile.lastCheckIn;
    }

    return {
        personId,
        combinedWarmth,
        highestTier,
        lastMessagedTwitter: lastTwitter,
        lastMessagedInstagram: lastIG,
    };
}

// ── Cross-platform messaging guard ──────────────────────────────────

/**
 * Check if we can message this person on the given platform.
 * Prevents double-messaging the same person on both platforms in 24h.
 */
export async function canMessageOnPlatform(
    handle: string,
    platform: 'twitter' | 'instagram'
): Promise<{ allowed: boolean; reason: string }> {
    const identity = findPersonByHandle(handle, platform);
    if (!identity) return { allowed: true, reason: 'no cross-platform link' };

    const otherPlatform = platform === 'twitter' ? 'instagram' : 'twitter';
    const otherHandle = platform === 'twitter' ? identity.instagramHandle : identity.twitterHandle;
    if (!otherHandle) return { allowed: true, reason: 'no handle on other platform' };

    // Check if we messaged them on the other platform today
    const cutoff24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    try {
        if (otherPlatform === 'twitter') {
            const { hasSentTwitterDMTo } = await import('../tracking/twitterDMTracker');
            if (hasSentTwitterDMTo(otherHandle, 24)) {
                return { allowed: false, reason: `Already DMed @${otherHandle} on Twitter in last 24h` };
            }
        } else {
            // Check Instagram DM tracker
            const dmFile = path.join(process.cwd(), 'logs', 'tracking', 'dm', 'messages.json');
            if (fs.existsSync(dmFile)) {
                const messages = safeReadJSON<any[]>(dmFile, [], 'ig_dm_check');
                const recent = messages.find((m: any) =>
                    m.recipientUsername?.toLowerCase() === otherHandle &&
                    m.direction === 'outbound' &&
                    m.timestamp > cutoff24h
                );
                if (recent) {
                    return { allowed: false, reason: `Already DMed @${otherHandle} on Instagram in last 24h` };
                }
            }
        }
    } catch (e) {
        // If check fails, allow (fail-open)
        logger.warn(`[cross-platform] Guard check failed: ${formatError(e)}`);
    }

    return { allowed: true, reason: 'clear' };
}

// ── Cross-platform context for AI prompts ───────────────────────────

export function getCrossContext(handle: string, currentPlatform: 'twitter' | 'instagram'): string {
    const identity = findPersonByHandle(handle, currentPlatform);
    if (!identity) return '';

    const otherPlatform = currentPlatform === 'twitter' ? 'instagram' : 'twitter';
    const otherHandle = currentPlatform === 'twitter' ? identity.instagramHandle : identity.twitterHandle;
    if (!otherHandle) return '';

    const otherProfile = loadNurtureProfile(otherHandle, otherPlatform);

    const parts: string[] = [];
    parts.push(`You also interact with this person on ${otherPlatform} as @${otherHandle}.`);

    if (otherProfile.tier !== 'acquaintance') {
        parts.push(`On ${otherPlatform}, they are a ${otherProfile.tier.replace('_', ' ')}.`);
    }

    if (otherProfile.interests.interests.length > 0) {
        const topics = otherProfile.interests.interests.slice(0, 3).map(i => i.topic).join(', ');
        parts.push(`Their interests on ${otherPlatform}: ${topics}.`);
    }

    return parts.join(' ');
}
