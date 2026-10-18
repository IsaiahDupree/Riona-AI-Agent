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
    type: 'value' | 'engagement' | 'promotional' | 'personal';
    style: 'informative' | 'opinion' | 'question' | 'tip' | 'story' | 'thread' | 'personal_story' | 'insight' | 'hot_take' | 'quote_tweet';
    topic?: string;
    offerId?: string;
    niche?: string;
}

export interface ContentCalendar {
    slots: ContentSlot[];
    tweetsPerDay: number;
    lastGeneratedAt: string;
    contentMix: { value: number; engagement: number; personal: number; promotional: number };
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

const VALUE_STYLES: ContentSlot['style'][] = ['informative', 'tip', 'story', 'insight'];
const ENGAGEMENT_STYLES: ContentSlot['style'][] = ['question', 'opinion', 'hot_take', 'quote_tweet'];
const PERSONAL_STYLES: ContentSlot['style'][] = ['personal_story', 'insight', 'story'];
const PROMOTIONAL_STYLES: ContentSlot['style'][] = ['informative', 'story', 'insight'];

export function generateWeeklyCalendar(brand: BrandIdentity): ContentCalendar {
    const tweetsPerDay = parseInt(process.env.TWITTER_TWEETS_PER_DAY || '12', 10);
    const totalSlots = tweetsPerDay * 7;
    const allNiches = [brand.niche, ...brand.subNiches].filter(Boolean);

    // Thought leadership mix: value + engagement heavy, personal stories for authenticity
    const mix = { value: 35, engagement: 30, personal: 20, promotional: 15 };

    const valueCount = Math.round(totalSlots * mix.value / 100);
    const engagementCount = Math.round(totalSlots * mix.engagement / 100);
    const personalCount = Math.round(totalSlots * mix.personal / 100);
    const promotionalCount = totalSlots - valueCount - engagementCount - personalCount;

    const slots: ContentSlot[] = [];

    // Value slots (tips, insights, threads)
    for (let i = 0; i < valueCount; i++) {
        const isThread = i % 7 === 0; // ~14% of value are threads
        slots.push({
            type: 'value',
            style: isThread ? 'thread' : VALUE_STYLES[i % VALUE_STYLES.length],
            niche: allNiches[i % allNiches.length],
        });
    }

    // Engagement slots (questions, opinions, hot takes, quote tweets)
    for (let i = 0; i < engagementCount; i++) {
        slots.push({
            type: 'engagement',
            style: ENGAGEMENT_STYLES[i % ENGAGEMENT_STYLES.length],
            niche: allNiches[i % allNiches.length],
        });
    }

    // Personal slots (stories, insights, behind-the-scenes)
    for (let i = 0; i < personalCount; i++) {
        slots.push({
            type: 'personal',
            style: PERSONAL_STYLES[i % PERSONAL_STYLES.length],
            niche: allNiches[i % allNiches.length],
        });
    }

    // Promotional slots (offer mentions woven into value)
    for (let i = 0; i < promotionalCount; i++) {
        const offers = brand.offers || [];
        const offer = offers.length > 0 ? offers[i % offers.length] : undefined;
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
    logger.info(`[content-calendar] Generated weekly calendar: ${valueCount} value, ${engagementCount} engagement, ${personalCount} personal, ${promotionalCount} promotional (${tweetsPerDay}/day)`);
    return calendar;
}

// ── Slot selection ──────────────────────────────────────────────────

export async function getNextContentSlot(runNumber: number): Promise<ContentSlot> {
    let calendar = loadCalendar();

    // Regenerate weekly (or on first run)
    if (!calendar || isCalendarExpired(calendar)) {
        const { loadBrandIdentity } = await import('./twitter-brand');
        calendar = generateWeeklyCalendar(loadBrandIdentity());
    }

    if (!calendar.slots || calendar.slots.length === 0) {
        return { type: 'value', style: 'informative' };
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
 * Whether to post content this run. Posts every 2-3 runs (randomized).
 * With 20-min intervals and 13 active hours: ~39 runs/day → ~13-19 posts/day.
 */
export function shouldPostContent(runNumber: number, lastPostRun: number): boolean {
    const minGap = 2;
    const maxGap = 3;
    const gap = runNumber - lastPostRun;
    if (gap < minGap) return false;
    if (gap >= maxGap) return true;
    return Math.random() > 0.4;
}

/**
 * Whether to post a thread this run. Every 8-12 runs (~3-4 threads/day).
 */
export function shouldPostThread(runNumber: number): boolean {
    const period = 8 + Math.floor(Math.random() * 5); // 8-12
    return runNumber % period === 0;
}
