import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../utils/logger';
import { safeReadJSON, safeWriteJSON } from '../utils/errors';
import { TrackedDM, DMSessionLog } from '../types/dm';

// ── File paths ────────────────────────────────────────────────────────

const DM_DATA_DIR = path.join(process.cwd(), 'logs', 'tracking', 'twitter-dm');
const DM_FILE = path.join(DM_DATA_DIR, 'messages.json');
const DM_SESSIONS_DIR = path.join(process.cwd(), 'logs', 'sessions', 'twitter-dm');

function ensureDirs() {
    for (const dir of [DM_DATA_DIR, DM_SESSIONS_DIR]) {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    }
}

// ── DM persistence ───────────────────────────────────────────────────

function loadDMs(): TrackedDM[] {
    ensureDirs();
    return safeReadJSON<TrackedDM[]>(DM_FILE, [], 'twitter_dm_messages');
}

function saveDMs(dms: TrackedDM[]) {
    ensureDirs();
    if (!safeWriteJSON(DM_FILE, dms, 'twitter_dm_messages')) {
        logger.error('[twitter-dm-tracker] DM data may be lost — write failed');
    }
}

// ── Public API ───────────────────────────────────────────────────────

export function hasSentTwitterDMTo(username: string, withinHours = 24): TrackedDM | null {
    if (!username) return null;
    const dms = loadDMs();
    const cutoff = new Date(Date.now() - withinHours * 60 * 60 * 1000).toISOString();
    return dms.find(d =>
        d.recipientUsername.toLowerCase() === username.toLowerCase() &&
        d.direction === 'outbound' &&
        d.timestamp > cutoff
    ) || null;
}

export function trackTwitterDM(dm: TrackedDM) {
    const dms = loadDMs();
    dms.push(dm);
    saveDMs(dms);
    logger.info(`[twitter-dm-tracker] Recorded ${dm.direction} DM to @${dm.recipientUsername}`);
}

export function getTodayTwitterDMCount(): number {
    const today = todayStr();
    const dms = loadDMs();
    return dms.filter(d => d.direction === 'outbound' && d.timestamp.startsWith(today)).length;
}

export function getAllTwitterDMs(): TrackedDM[] {
    return loadDMs();
}

export function getTwitterDMsForUser(username: string): TrackedDM[] {
    const dms = loadDMs();
    return dms.filter(d => d.recipientUsername.toLowerCase() === username.toLowerCase());
}

export function getLastTwitterDMTimestamp(username: string): string | null {
    const dms = loadDMs();
    const userDMs = dms
        .filter(d => d.recipientUsername.toLowerCase() === username.toLowerCase() && d.direction === 'outbound')
        .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    return userDMs.length > 0 ? userDMs[0].timestamp : null;
}

export function cleanupOldTwitterDMs(daysToKeep = 90) {
    const cutoff = new Date(Date.now() - daysToKeep * 24 * 60 * 60 * 1000).toISOString();
    const dms = loadDMs();
    const filtered = dms.filter(d => d.timestamp >= cutoff);
    if (filtered.length < dms.length) {
        saveDMs(filtered);
        logger.info(`[twitter-dm-tracker] Cleaned up ${dms.length - filtered.length} old DMs`);
    }
}

// ── Session logging ──────────────────────────────────────────────────

export function createTwitterDMSession(): DMSessionLog {
    const sessionId = `twitter_dm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    return {
        sessionId,
        startTime: new Date().toISOString(),
        messagesSent: 0,
        messagesReceived: 0,
        messagesVerified: 0,
        messagesFailed: 0,
        errors: [],
        messages: []
    };
}

export function saveTwitterDMSession(session: DMSessionLog) {
    try {
        ensureDirs();
        session.endTime = new Date().toISOString();
        const jsonPath = path.join(DM_SESSIONS_DIR, `${session.sessionId}.json`);
        fs.writeFileSync(jsonPath, JSON.stringify(session, null, 2));
        logger.info(`[twitter-dm-tracker] Session saved: ${session.sessionId}`);
    } catch (e) {
        logger.error('[twitter-dm-tracker] Failed to save session', e);
    }
}

// ── Helpers ──────────────────────────────────────────────────────────

function todayStr(): string {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
