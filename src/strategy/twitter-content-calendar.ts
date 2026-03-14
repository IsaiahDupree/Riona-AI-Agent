/**
 * Twitter Content Calendar — Strategic content scheduling with content mix ratios.
 * 60% value / 25% engagement / 15% promotional
 */

import { logger } from '../utils/logger';
import { safeReadJSON, safeWriteJSON } from '../utils/errors';
import { BrandIdentity } from './twitter-brand';
import * as path from 'path';
import * as fs from 'fs';

// ── Interfaces ──────────────────────────────────────────────────────

export interface ContentSlot {
    type: 'value' | 'engagement' | 'promotional';
    style: 'informative' | 'opinion' | 'question' | 'tip' | 'story' | 'thread';
    topic?: string;
    offerId?: string;
    niche?: string;
}

export interface ContentCalendar {
    slots: ContentSlot[];
    tweetsPerDay: number;
    lastGeneratedAt: string;
    contentMix: { value: number; engagement: number; promotional: number };
}

// ── File path ───────────────────────────────────────────────────────

const CALENDAR_FILE = path.join(process.cwd(), 'logs', 'config', 'content-calendar.json');

function ensureDir() {
    const dir = path.dirname(CALENDAR_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ── Load / Save ─────────────────────────────────────────────────────

export function loadCalendar(): ContentCalendar | null {
    ensureDir();
    return safeReadJSON<ContentCalendar | null>(CALENDAR_FILE, null, 'content_calendar');
}

export function saveCalendar(cal: ContentCalendar): void {
    ensureDir();
    if (!safeWriteJSON(CALENDAR_FILE, cal, 'content_calendar')) {
        logger.warn('[content-calendar] Failed to save calendar');
    }
}

// ── Calendar generation ─────────────────────────────────────────────

const VALUE_STYLES: ContentSlot['style'][] = ['informative', 'tip', 'story'];
const ENGAGEMENT_STYLES: ContentSlot['style'][] = ['question', 'opinion'];
const PROMOTIONAL_STYLES: ContentSlot['style'][] = ['informative', 'story'];

export function generateWeeklyCalendar(brand: BrandIdentity): ContentCalendar {
    const tweetsPerDay = parseInt(process.env.TWITTER_TWEETS_PER_DAY || '3', 10);
    const totalSlots = tweetsPerDay * 7;
    const allNiches = [brand.niche, ...brand.subNiches].filter(Boolean);

    const mix = { value: 60, engagement: 25, promotional: 15 };

    const valueCount = Math.round(totalSlots * mix.value / 100);
    const engagementCount = Math.round(totalSlots * mix.engagement / 100);
    const promotionalCount = totalSlots - valueCount - engagementCount;

    const slots: ContentSlot[] = [];

    // Value slots
    for (let i = 0; i < valueCount; i++) {
        const isThread = i % 5 === 0; // ~20% of value are threads
        slots.push({
            type: 'value',
            style: isThread ? 'thread' : VALUE_STYLES[i % VALUE_STYLES.length],
            niche: allNiches[i % allNiches.length],
        });
    }

    // Engagement slots
    for (let i = 0; i < engagementCount; i++) {
        slots.push({
            type: 'engagement',
            style: ENGAGEMENT_STYLES[i % ENGAGEMENT_STYLES.length],
            niche: allNiches[i % allNiches.length],
        });
    }

    // Promotional slots
    for (let i = 0; i < promotionalCount; i++) {
        const offer = brand.offers[i % Math.max(brand.offers.length, 1)];
        slots.push({
            type: 'promotional',
            style: PROMOTIONAL_STYLES[i % PROMOTIONAL_STYLES.length],
            offerId: offer?.id,
            niche: allNiches[i % allNiches.length],
        });
    }

    // Shuffle slots for natural mix
    for (let i = slots.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [slots[i], slots[j]] = [slots[j], slots[i]];
    }

    const calendar: ContentCalendar = {
        slots,
        tweetsPerDay,
        lastGeneratedAt: new Date().toISOString(),
        contentMix: mix,
    };

    saveCalendar(calendar);
    logger.info(`[content-calendar] Generated weekly calendar: ${valueCount} value, ${engagementCount} engagement, ${promotionalCount} promotional`);
    return calendar;
}

// ── Slot selection ──────────────────────────────────────────────────

export function getNextContentSlot(runNumber: number): ContentSlot {
    let calendar = loadCalendar();

    // Regenerate weekly (or on first run)
    if (!calendar || isCalendarExpired(calendar)) {
        const { loadBrandIdentity } = require('./twitter-brand');
        calendar = generateWeeklyCalendar(loadBrandIdentity());
    }

    const slotIndex = runNumber % calendar.slots.length;
    return calendar.slots[slotIndex];
}

function isCalendarExpired(cal: ContentCalendar): boolean {
    const generated = new Date(cal.lastGeneratedAt).getTime();
    const weekMs = 7 * 24 * 60 * 60 * 1000;
    return Date.now() - generated > weekMs;
}

// ── Frequency control ───────────────────────────────────────────────

/**
 * Whether to post content this run. Posts every 4-6 runs (randomized).
 */
export function shouldPostContent(runNumber: number, lastPostRun: number): boolean {
    const minGap = 4;
    const maxGap = 6;
    const gap = runNumber - lastPostRun;
    if (gap < minGap) return false;
    if (gap >= maxGap) return true;
    // Between min and max: 50% chance
    return Math.random() > 0.5;
}

/**
 * Whether to post a thread this run. Every 12-18 runs.
 */
export function shouldPostThread(runNumber: number): boolean {
    const period = 12 + Math.floor(Math.random() * 7); // 12-18
    return runNumber % period === 0;
}
