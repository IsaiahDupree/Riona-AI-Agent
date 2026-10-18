/**
 * Nurture Profile Store — Central persistence for friendship nurture profiles.
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../utils/logger';
import { safeReadJSON, safeWriteJSON } from '../utils/errors';
import {
    NurtureProfile, FriendshipTier, InterestProfile, ConversationDepthMetrics,
} from '../types/nurture';

// ── File paths ──────────────────────────────────────────────────────

const NURTURE_DIR = path.join(process.cwd(), 'logs', 'tracking', 'nurture', 'profiles');

function ensureDir() {
    if (!fs.existsSync(NURTURE_DIR)) fs.mkdirSync(NURTURE_DIR, { recursive: true });
}

function profilePath(username: string, platform: string): string {
    return path.join(NURTURE_DIR, `${platform}_${username.toLowerCase()}.json`);
}

// ── Default profile ─────────────────────────────────────────────────

function createDefaultProfile(username: string, platform: 'twitter' | 'instagram'): NurtureProfile {
    const now = new Date().toISOString();
    return {
        username: username.toLowerCase(),
        platform,
        tier: 'acquaintance',
        tierHistory: [{ tier: 'acquaintance', at: now }],
        interests: {
            username: username.toLowerCase(),
            platform,
            interests: [],
            lastUpdated: now,
        },
        depth: {
            username: username.toLowerCase(),
            platform,
            avgMessageLength: 0,
            topicVariety: 0,
            personalDisclosureLevel: 0,
            questionAskingRatio: 0,
            conversationQualityScore: 0,
            exchangeCount: 0,
            lastCalculated: now,
        },
        checkIns: [],
        interestMessagePerformance: {},
        createdAt: now,
    };
}

// ── CRUD ────────────────────────────────────────────────────────────

/**
 * Load a nurture profile, auto-creating if it doesn't exist.
 * Validates username to prevent ghost profiles from typos/bad input.
 */
export function loadNurtureProfile(username: string, platform: 'twitter' | 'instagram'): NurtureProfile {
    // Sanitize: trim whitespace, strip @ prefix, lowercase
    const cleaned = (username || '').trim().replace(/^@/, '').toLowerCase();

    if (!cleaned || cleaned.length < 2 || cleaned.length > 50 || /\s/.test(cleaned)) {
        logger.warn(`[nurture-store] Invalid username "${username}" — returning ephemeral profile`);
        return createDefaultProfile(cleaned || 'unknown', platform);
    }

    ensureDir();
    const filePath = profilePath(cleaned, platform);
    const saved = safeReadJSON<NurtureProfile | null>(filePath, null, 'nurture_profile');
    if (saved) return saved;

    const profile = createDefaultProfile(cleaned, platform);
    saveNurtureProfile(profile);
    return profile;
}

export function saveNurtureProfile(profile: NurtureProfile): void {
    ensureDir();
    const filePath = profilePath(profile.username, profile.platform);
    if (!safeWriteJSON(filePath, profile, 'nurture_profile')) {
        logger.warn(`[nurture-store] Failed to save profile for ${profile.platform}/@${profile.username}`);
    }
}

export function getAllNurtureProfiles(platform?: 'twitter' | 'instagram'): NurtureProfile[] {
    ensureDir();
    const profiles: NurtureProfile[] = [];

    try {
        const files = fs.readdirSync(NURTURE_DIR).filter(f => f.endsWith('.json'));
        for (const file of files) {
            if (platform && !file.startsWith(`${platform}_`)) continue;
            const data = safeReadJSON<NurtureProfile | null>(path.join(NURTURE_DIR, file), null, 'nurture_profiles');
            if (data) profiles.push(data);
        }
    } catch (e) {
        logger.warn(`[nurture-store] Error reading profiles directory`);
    }

    return profiles;
}

export function getProfilesByTier(tier: FriendshipTier, platform?: 'twitter' | 'instagram'): NurtureProfile[] {
    return getAllNurtureProfiles(platform).filter(p => p.tier === tier);
}

export function getStaleProfiles(daysInactive: number, platform?: 'twitter' | 'instagram'): NurtureProfile[] {
    const cutoff = new Date(Date.now() - daysInactive * 24 * 60 * 60 * 1000).toISOString();
    return getAllNurtureProfiles(platform).filter(p => {
        const lastActivity = p.lastCheckIn || p.createdAt;
        return lastActivity < cutoff;
    });
}

export function profileExists(username: string, platform: 'twitter' | 'instagram'): boolean {
    return fs.existsSync(profilePath(username, platform));
}
