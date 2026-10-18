/**
 * DM Limits — Weekly auto-incrementing daily DM limits for both platforms.
 *
 * Starts at BASE_DMS_PER_DAY (10) and increments by INCREMENT_PER_WEEK (10)
 * each week, capped at MAX_DMS_PER_DAY (100).
 *
 * Week 1: 10/day  →  Week 2: 20/day  →  Week 3: 30/day  →  ... → 100/day cap
 */

import { safeReadJSON, safeWriteJSON, formatError } from '../utils/errors';
import { logger } from '../utils/logger';
import * as path from 'path';

const LIMITS_FILE = path.join(process.cwd(), 'logs', 'config', 'dm-limits.json');

interface DMLimitsConfig {
    startDate: string;              // ISO date when the ramp-up started
    baseDMsPerDay: number;          // Starting daily limit (default: 10)
    incrementPerWeek: number;       // How many more DMs per day each week (default: 10)
    maxDMsPerDay: number;           // Hard cap (default: 100)
    manualOverride?: number | null; // If set, overrides the calculated limit
}

const DEFAULT_LIMITS: DMLimitsConfig = {
    startDate: new Date().toISOString().split('T')[0], // Today
    baseDMsPerDay: 10,
    incrementPerWeek: 10,
    maxDMsPerDay: 100,
    manualOverride: null,
};

export function loadDMLimits(): DMLimitsConfig {
    const config = safeReadJSON<DMLimitsConfig | null>(LIMITS_FILE, null, 'dm-limits');
    if (!config) {
        // First run — initialize with defaults
        saveDMLimits(DEFAULT_LIMITS);
        return DEFAULT_LIMITS;
    }
    return { ...DEFAULT_LIMITS, ...config };
}

export function saveDMLimits(config: DMLimitsConfig): void {
    safeWriteJSON(LIMITS_FILE, config, 'dm-limits');
}

/**
 * Calculate today's DM limit based on weeks since start date.
 * Both platforms share the same ramp-up schedule.
 */
export function getTodayDMLimit(): number {
    const config = loadDMLimits();

    // Manual override takes priority
    if (config.manualOverride != null && config.manualOverride > 0) {
        return config.manualOverride;
    }

    const startDate = new Date(config.startDate);
    const today = new Date();
    const daysSinceStart = Math.floor((today.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24));
    const weeksSinceStart = Math.floor(daysSinceStart / 7);

    const calculated = config.baseDMsPerDay + (weeksSinceStart * config.incrementPerWeek);
    const limit = Math.min(calculated, config.maxDMsPerDay);

    return limit;
}

/**
 * Get a summary of the current DM limit schedule.
 */
export function getDMLimitInfo(): {
    todayLimit: number;
    weekNumber: number;
    startDate: string;
    nextIncrease: string;
    schedule: Array<{ week: number; limit: number }>;
} {
    const config = loadDMLimits();
    const startDate = new Date(config.startDate);
    const today = new Date();
    const daysSinceStart = Math.floor((today.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24));
    const weekNumber = Math.floor(daysSinceStart / 7) + 1;
    const daysUntilNextWeek = 7 - (daysSinceStart % 7);
    const nextIncrease = new Date(today.getTime() + daysUntilNextWeek * 86400000).toISOString().split('T')[0];

    const schedule: Array<{ week: number; limit: number }> = [];
    for (let w = 0; w < 10; w++) {
        const limit = Math.min(config.baseDMsPerDay + w * config.incrementPerWeek, config.maxDMsPerDay);
        schedule.push({ week: w + 1, limit });
        if (limit >= config.maxDMsPerDay) break;
    }

    return {
        todayLimit: getTodayDMLimit(),
        weekNumber,
        startDate: config.startDate,
        nextIncrease,
        schedule,
    };
}

/**
 * Override the daily limit manually (set to null to resume auto-increment).
 */
export function setManualOverride(limit: number | null): void {
    const config = loadDMLimits();
    config.manualOverride = limit;
    saveDMLimits(config);
    logger.info(`[dm-limits] Manual override ${limit != null ? `set to ${limit}` : 'cleared (auto-increment resumed)'}`);
}
