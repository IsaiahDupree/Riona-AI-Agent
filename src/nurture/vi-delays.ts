/**
 * Variable-Interval Reply Delay System
 *
 * Instead of replying to DMs immediately, randomizes reply timing
 * based on relationship tier/stage. Creates a VI-schedule feel:
 * sometimes fast (1-5 min), sometimes slower (15-45 min).
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../utils/logger';
import { safeReadJSON, safeWriteJSON } from '../utils/errors';
import { ProfileInfo, RelationshipInfo, TrackedDM } from '../types/dm';

// ── Types ────────────────────────────────────────────────────────────

export interface DelayedReplyEntry {
    id: string;
    username: string;
    platform: 'twitter' | 'instagram';
    replyMessage: string;
    sendAfter: string;       // ISO timestamp — when to actually send
    createdAt: string;
    status: 'pending' | 'sent' | 'failed';
    error?: string;
    context: {
        relationship: RelationshipInfo;
        objective: string;
        isJackpot: boolean;
        theirMessage?: string;
        displayName?: string;  // original display name from inbox (for thread lookup)
    };
}

// ── Constants ────────────────────────────────────────────────────────

const QUEUE_DIR = path.join(process.cwd(), 'logs', 'tracking', 'nurture');
const QUEUE_FILE = path.join(QUEUE_DIR, 'delayed-replies.json');

// Delay ranges per tier (in minutes) — [min, max]
const TIER_DELAY_RANGES: Record<string, [number, number]> = {
    inner_circle:  [1, 5],
    close_friend:  [2, 12],
    casual_friend: [5, 25],
    acquaintance:  [10, 45],
};

// Fallback delay ranges by relationship stage
const STAGE_DELAY_RANGES: Record<string, [number, number]> = {
    active:          [1, 8],
    warm:            [3, 15],
    building:        [5, 25],
    initial_contact: [8, 35],
    cold_outreach:   [10, 45],
};

// Jackpot replies get a "surprise fast" chance (35% chance of very fast reply)
const JACKPOT_FAST_CHANCE = 0.35;
const JACKPOT_FAST_RANGE: [number, number] = [0.5, 3]; // 30s to 3 min

// ── Delay computation ────────────────────────────────────────────────

/**
 * Compute a randomized reply delay in milliseconds.
 * Uses tier (from nurture profile) if available, falls back to relationship stage.
 * Jackpot replies get a chance of being "surprise fast."
 */
export function computeReplyDelay(
    username: string,
    platform: 'twitter' | 'instagram',
    stage: string = 'initial_contact',
    isJackpot: boolean = false,
): number {
    // Try to load tier from nurture profile
    let range: [number, number] | undefined;
    try {
        const { loadNurtureProfile } = require('./store');
        const profile = loadNurtureProfile(username, platform);
        range = TIER_DELAY_RANGES[profile.tier];
    } catch (_) { /* nurture not initialized */ }

    // Fall back to stage-based delay
    if (!range) {
        range = STAGE_DELAY_RANGES[stage] || STAGE_DELAY_RANGES.initial_contact;
    }

    // Jackpot: 35% chance of surprise-fast reply
    if (isJackpot && Math.random() < JACKPOT_FAST_CHANCE) {
        range = JACKPOT_FAST_RANGE;
    }

    // Uniform random within range, with ±30% jitter
    const base = range[0] + Math.random() * (range[1] - range[0]);
    const jitter = 0.7 + Math.random() * 0.6; // 0.7 - 1.3
    const delayMinutes = base * jitter;

    return Math.round(delayMinutes * 60 * 1000); // Convert to ms
}

// ── Queue persistence ────────────────────────────────────────────────

function ensureDir() {
    if (!fs.existsSync(QUEUE_DIR)) fs.mkdirSync(QUEUE_DIR, { recursive: true });
}

function loadQueue(): DelayedReplyEntry[] {
    ensureDir();
    return safeReadJSON<DelayedReplyEntry[]>(QUEUE_FILE, [], 'delayed_replies');
}

function saveQueue(queue: DelayedReplyEntry[]): void {
    ensureDir();
    safeWriteJSON(QUEUE_FILE, queue, 'delayed_replies');
}

/**
 * Check if a reply is already pending/scheduled for a given user on a given platform.
 * Prevents double-scheduling when the same message is detected across watcher cycles.
 */
export function hasPendingReply(username: string, platform: 'twitter' | 'instagram'): boolean {
    const queue = loadQueue();
    return queue.some(e =>
        e.status === 'pending' &&
        e.username.toLowerCase() === username.toLowerCase() &&
        e.platform === platform
    );
}

/**
 * Schedule a reply to be sent after a computed delay.
 */
export function scheduleDelayedReply(entry: Omit<DelayedReplyEntry, 'id' | 'createdAt' | 'status'>): string {
    const queue = loadQueue();
    const id = `delayed_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const full: DelayedReplyEntry = {
        ...entry,
        id,
        createdAt: new Date().toISOString(),
        status: 'pending',
    };
    queue.push(full);
    saveQueue(queue);

    const delayMs = new Date(entry.sendAfter).getTime() - Date.now();
    logger.info(`[vi-delays] Scheduled reply to @${entry.username} in ${Math.round(delayMs / 60000)}min (jackpot=${entry.context.isJackpot})`);

    return id;
}

/**
 * Get replies whose sendAfter timestamp has passed and are still pending.
 */
export function getReadyReplies(platform?: 'twitter' | 'instagram'): DelayedReplyEntry[] {
    const queue = loadQueue();
    const now = Date.now();
    return queue.filter(e =>
        e.status === 'pending' &&
        new Date(e.sendAfter).getTime() <= now &&
        (!platform || e.platform === platform)
    );
}

/**
 * Mark a delayed reply as sent.
 */
export function markReplySent(id: string): void {
    const queue = loadQueue();
    const entry = queue.find(e => e.id === id);
    if (entry) {
        entry.status = 'sent';
        saveQueue(queue);
    }
}

/**
 * Mark a delayed reply as failed.
 */
export function markReplyFailed(id: string, error: string): void {
    const queue = loadQueue();
    const entry = queue.find(e => e.id === id);
    if (entry) {
        entry.status = 'failed';
        entry.error = error;
        saveQueue(queue);
    }
}

/**
 * Clean up old entries (remove sent/failed older than 7 days, cap at 500).
 */
export function cleanupDelayedQueue(): number {
    const queue = loadQueue();
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const filtered = queue.filter(e =>
        e.status === 'pending' ||
        new Date(e.createdAt).getTime() > sevenDaysAgo
    );

    // Cap to prevent unbounded growth — keep newest, but warn if truncating pending entries
    const MAX_QUEUE_SIZE = 500;
    let cleaned = filtered;
    if (filtered.length > MAX_QUEUE_SIZE) {
        const pendingCount = filtered.filter(e => e.status === 'pending').length;
        cleaned = filtered.slice(-MAX_QUEUE_SIZE);
        const truncatedPending = pendingCount - cleaned.filter(e => e.status === 'pending').length;
        if (truncatedPending > 0) {
            logger.warn(`[vi-delays] Queue overflow: dropped ${truncatedPending} pending entries (cap=${MAX_QUEUE_SIZE})`);
        }
    }

    const removed = queue.length - cleaned.length;
    if (removed > 0) {
        saveQueue(cleaned);
        logger.info(`[vi-delays] Cleaned up ${removed} old delayed reply entries`);
    }
    return removed;
}
