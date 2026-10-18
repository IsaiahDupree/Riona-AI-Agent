/**
 * Niche Performance Tracker
 *
 * Tracks engagement metrics per niche/hashtag and provides weighted selection
 * so top-performing niches get more runs.
 */
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../utils/logger';
import { safeReadJSON, safeWriteJSON } from '../utils/errors';

// ── Types ─────────────────────────────────────────────────────────────

export interface NicheStats {
    term: string;
    platform: 'twitter' | 'instagram' | 'threads';
    runs: number;
    totalReplies: number;
    verifiedReplies: number;
    totalEngagement: number;   // likes + replies received on our comments
    lastRun: string;           // ISO 8601
    avgRepliesPerRun: number;
    engagementRate: number;    // engagement per reply
}

// ── File path ─────────────────────────────────────────────────────────

const DATA_DIR = path.join(process.cwd(), 'logs', 'tracking');
const NICHE_FILE = path.join(DATA_DIR, 'niche_performance.json');

function ensureDir() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadStats(): NicheStats[] {
    ensureDir();
    return safeReadJSON<NicheStats[]>(NICHE_FILE, [], 'niche_performance');
}

function saveStats(stats: NicheStats[]) {
    ensureDir();
    safeWriteJSON(NICHE_FILE, stats, 'niche_performance');
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Record the results of a niche run.
 */
export function recordNicheRun(
    term: string,
    platform: 'twitter' | 'instagram' | 'threads',
    replies: number,
    verified: number,
): void {
    const stats = loadStats();
    let entry = stats.find(s => s.term === term && s.platform === platform);

    if (!entry) {
        entry = {
            term,
            platform,
            runs: 0,
            totalReplies: 0,
            verifiedReplies: 0,
            totalEngagement: 0,
            lastRun: '',
            avgRepliesPerRun: 0,
            engagementRate: 0,
        };
        stats.push(entry);
    }

    entry.runs++;
    entry.totalReplies += replies;
    entry.verifiedReplies += verified;
    entry.lastRun = new Date().toISOString();
    entry.avgRepliesPerRun = Math.round((entry.totalReplies / entry.runs) * 100) / 100;

    saveStats(stats);
    logger.info(`[niche-perf] Recorded ${term} (${platform}): ${replies} replies, ${verified} verified — avg ${entry.avgRepliesPerRun}/run`);
}

/**
 * Add engagement data to a niche (e.g., from check-backs).
 */
export function addNicheEngagement(
    term: string,
    platform: 'twitter' | 'instagram' | 'threads',
    engagement: number,
): void {
    const stats = loadStats();
    const entry = stats.find(s => s.term === term && s.platform === platform);
    if (entry) {
        entry.totalEngagement += engagement;
        entry.engagementRate = entry.totalReplies > 0
            ? Math.round((entry.totalEngagement / entry.totalReplies) * 100) / 100
            : 0;
        saveStats(stats);
    }
}

/**
 * Select the next niche term using weighted probability.
 * Higher-performing niches (more replies + engagement per run) get selected more often.
 * New/untested niches get a bonus to ensure exploration.
 */
export function selectWeightedNiche(
    allTerms: string[],
    platform: 'twitter' | 'instagram' | 'threads',
): string {
    if (allTerms.length === 0) return '';
    if (allTerms.length === 1) return allTerms[0];

    const stats = loadStats();
    const weights: number[] = allTerms.map(term => {
        const entry = stats.find(s => s.term === term && s.platform === platform);
        if (!entry || entry.runs < 3) {
            // Exploration bonus: untested niches get a high default weight
            return 5;
        }
        // Score = avg replies per run + engagement rate bonus
        // Minimum weight of 1 so no niche gets completely starved
        return Math.max(1, entry.avgRepliesPerRun + entry.engagementRate * 2);
    });

    // Weighted random selection
    const totalWeight = weights.reduce((s, w) => s + w, 0);
    let roll = Math.random() * totalWeight;
    for (let i = 0; i < allTerms.length; i++) {
        roll -= weights[i];
        if (roll <= 0) return allTerms[i];
    }

    return allTerms[allTerms.length - 1];
}

/**
 * Get the top N performing niches for a platform.
 */
export function getTopNiches(
    platform: 'twitter' | 'instagram' | 'threads',
    limit = 5,
): NicheStats[] {
    const stats = loadStats().filter(s => s.platform === platform && s.runs >= 3);
    return stats
        .sort((a, b) => (b.avgRepliesPerRun + b.engagementRate) - (a.avgRepliesPerRun + a.engagementRate))
        .slice(0, limit);
}
