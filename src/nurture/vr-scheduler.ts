/**
 * Skinner-Inspired Variable-Ratio / Variable-Interval Scheduler
 *
 * Core engine for nurture engagement (comments, DM replies).
 * Uses geometric distribution for VR thresholds, multi-arm bandits
 * for style selection, relationship health tracking, and thinning.
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../utils/logger';
import { safeReadJSON, safeWriteJSON } from '../utils/errors';

// ── Types ────────────────────────────────────────────────────────────

export type CommentStyle =
    | 'short_value'       // Quick useful insight
    | 'thoughtful_question' // Genuine question about their content
    | 'humor'             // Light humor / wit
    | 'contrarian_take'   // Respectful disagreement / alternative view
    | 'personal_story'    // Brief personal anecdote relating to their post
    | 'encouragement'     // Supportive / congratulatory
    | 'resource_share';   // Share relevant resource / link

export interface BanditArm {
    style: CommentStyle;
    pulls: number;       // Times selected
    rewards: number;     // Cumulative reward (replies, likes on our comment)
    avgReward: number;   // rewards / pulls
}

export interface VRContactState {
    username: string;
    platform: 'twitter' | 'instagram';

    // VR state (comments)
    counter: number;           // Interactions since last reinforcement
    nextThreshold: number;     // Next N to trigger comment
    meanN: number;             // Current mean for geometric distribution (starts ~3)

    // VR state (DM replies — for jackpot mechanics)
    dmReplyCounter: number;       // DM replies since last jackpot
    dmNextThreshold: number;      // Next N to trigger jackpot reply

    // Relationship health (0.0 - 1.0)
    health: number;
    healthHistory: Array<{ value: number; delta: number; reason: string; at: string }>;

    // Thinning — gradually increase meanN over time
    totalReinforcements: number; // Total times we've commented
    thinningStage: number;       // 0=early, 1=mid, 2=mature

    // Multi-arm bandit for comment style
    commentBandit: BanditArm[];

    // Guardrails
    commentsToday: number;
    lastCommentDate: string;   // YYYY-MM-DD
    consecutiveIgnored: number; // Comments with no engagement back
    lastCommentAt: string | null;
    pausedUntil: string | null; // ISO — paused if health too low or too many ignored

    // Tracking
    totalComments: number;
    totalRepliesReceived: number;
    createdAt: string;
    updatedAt: string;
}

export interface VRDecision {
    shouldEngage: boolean;
    reason: string;
    style?: CommentStyle;
    contactState: VRContactState;
}

// ── Constants ────────────────────────────────────────────────────────

const VR_STATE_DIR = path.join(process.cwd(), 'logs', 'tracking', 'nurture', 'vr-states');

const DEFAULT_MEAN_N = 3;              // Start: comment roughly every 3rd interaction opportunity
const MIN_MEAN_N = 2;
const MAX_MEAN_N = 20;
const HEALTH_FLOOR = 0.55;             // Below this → pause engagement
const HEALTH_CEILING = 1.0;
const HEALTH_INITIAL = 0.7;
const MAX_COMMENTS_PER_DAY_PER_USER = 2;
const MAX_CONSECUTIVE_IGNORED = 4;     // Pause after 4 ignored comments
const PAUSE_DURATION_HOURS = 72;       // 3-day cooldown
const EPSILON = 0.15;                  // Exploration rate for bandit

// Thinning: increase meanN as relationship matures
const THINNING_SCHEDULE: Array<{ afterReinforcements: number; meanMultiplier: number }> = [
    { afterReinforcements: 0, meanMultiplier: 1.0 },   // Stage 0: normal
    { afterReinforcements: 10, meanMultiplier: 1.5 },   // Stage 1: start thinning
    { afterReinforcements: 25, meanMultiplier: 2.0 },   // Stage 2: mature relationship
];

// Health deltas
const HEALTH_DELTAS = {
    reply_received: 0.08,       // They replied to our comment
    like_received: 0.03,        // They liked our comment
    comment_ignored: -0.04,     // No engagement on our comment
    they_engaged_our_content: 0.06, // They engaged with our tweets/posts
    time_decay_per_day: -0.005, // Slow decay without interaction
    dm_reply_received: 0.10,    // They replied to our DM
    dm_ignored: -0.06,          // DM got no reply
    we_replied: 0.05,           // We replied to their reply (strengthens relationship)
};

// ── File persistence ─────────────────────────────────────────────────

function ensureDir() {
    if (!fs.existsSync(VR_STATE_DIR)) fs.mkdirSync(VR_STATE_DIR, { recursive: true });
}

function statePath(username: string, platform: string): string {
    return path.join(VR_STATE_DIR, `${platform}_${username.toLowerCase()}.json`);
}

function todayStr(): string {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ── Geometric distribution ───────────────────────────────────────────

/**
 * Draw from Geom(p) where p = 1/meanN.
 * Returns minimum 1.
 */
function drawGeometric(meanN: number): number {
    const p = 1 / Math.max(meanN, MIN_MEAN_N);
    // Inverse CDF: ceil(ln(1-U) / ln(1-p))
    const u = Math.random();
    const result = Math.ceil(Math.log(1 - u) / Math.log(1 - p));
    return Math.max(1, Math.min(result, Math.round(meanN * 4))); // Cap at 4x mean
}

// ── Default bandit arms ──────────────────────────────────────────────

function createDefaultBandit(): BanditArm[] {
    const styles: CommentStyle[] = [
        'short_value', 'thoughtful_question', 'humor',
        'contrarian_take', 'personal_story', 'encouragement', 'resource_share',
    ];
    return styles.map(style => ({
        style,
        pulls: 0,
        rewards: 0,
        avgReward: 0,
    }));
}

// ── State CRUD ───────────────────────────────────────────────────────

export function loadVRState(username: string, platform: 'twitter' | 'instagram'): VRContactState {
    ensureDir();
    const fp = statePath(username, platform);
    const saved = safeReadJSON<VRContactState | null>(fp, null, 'vr_state');
    if (saved) {
        // Backward compat: add DM jackpot fields if missing
        if (saved.dmReplyCounter === undefined) saved.dmReplyCounter = 0;
        if (saved.dmNextThreshold === undefined) saved.dmNextThreshold = drawGeometric(DEFAULT_MEAN_N * 2);
        return saved;
    }

    const now = new Date().toISOString();
    const initialThreshold = drawGeometric(DEFAULT_MEAN_N);

    const state: VRContactState = {
        username: username.toLowerCase(),
        platform,
        counter: 0,
        nextThreshold: initialThreshold,
        meanN: DEFAULT_MEAN_N,
        dmReplyCounter: 0,
        dmNextThreshold: drawGeometric(DEFAULT_MEAN_N * 2),
        health: HEALTH_INITIAL,
        healthHistory: [{ value: HEALTH_INITIAL, delta: 0, reason: 'initial', at: now }],
        totalReinforcements: 0,
        thinningStage: 0,
        commentBandit: createDefaultBandit(),
        commentsToday: 0,
        lastCommentDate: '',
        consecutiveIgnored: 0,
        lastCommentAt: null,
        pausedUntil: null,
        totalComments: 0,
        totalRepliesReceived: 0,
        createdAt: now,
        updatedAt: now,
    };

    saveVRState(state);
    return state;
}

export function saveVRState(state: VRContactState): void {
    ensureDir();
    state.updatedAt = new Date().toISOString();
    const fp = statePath(state.username, state.platform);
    safeWriteJSON(fp, state, 'vr_state');
}

export function getAllVRStates(platform?: 'twitter' | 'instagram'): VRContactState[] {
    ensureDir();
    const states: VRContactState[] = [];
    try {
        const files = fs.readdirSync(VR_STATE_DIR).filter(f => f.endsWith('.json'));
        for (const file of files) {
            if (platform && !file.startsWith(`${platform}_`)) continue;
            const data = safeReadJSON<VRContactState | null>(path.join(VR_STATE_DIR, file), null, 'vr_states');
            if (data) states.push(data);
        }
    } catch (_) { /* empty dir */ }
    return states;
}

// ── Core VR decision engine ──────────────────────────────────────────

/**
 * Record an interaction opportunity (e.g., we saw their post).
 * Returns whether we should engage (comment) this time.
 */
export function recordInteractionAndDecide(
    username: string,
    platform: 'twitter' | 'instagram',
): VRDecision {
    const state = loadVRState(username, platform);
    const today = todayStr();

    // Reset daily counter if new day
    if (state.lastCommentDate !== today) {
        state.commentsToday = 0;
        state.lastCommentDate = today;
    }

    // ── Guardrails ──────────────────────────────────────────────────

    // Check pause
    if (state.pausedUntil && new Date(state.pausedUntil) > new Date()) {
        saveVRState(state);
        return {
            shouldEngage: false,
            reason: `Paused until ${state.pausedUntil}`,
            contactState: state,
        };
    } else if (state.pausedUntil) {
        // Unpause
        state.pausedUntil = null;
        state.consecutiveIgnored = 0;
    }

    // Health floor
    if (state.health < HEALTH_FLOOR) {
        state.pausedUntil = new Date(Date.now() + PAUSE_DURATION_HOURS * 60 * 60 * 1000).toISOString();
        saveVRState(state);
        return {
            shouldEngage: false,
            reason: `Health ${state.health.toFixed(2)} below floor ${HEALTH_FLOOR}. Paused.`,
            contactState: state,
        };
    }

    // Daily cap per user
    if (state.commentsToday >= MAX_COMMENTS_PER_DAY_PER_USER) {
        saveVRState(state);
        return {
            shouldEngage: false,
            reason: `Daily cap reached (${state.commentsToday}/${MAX_COMMENTS_PER_DAY_PER_USER})`,
            contactState: state,
        };
    }

    // Consecutive ignored
    if (state.consecutiveIgnored >= MAX_CONSECUTIVE_IGNORED) {
        state.pausedUntil = new Date(Date.now() + PAUSE_DURATION_HOURS * 60 * 60 * 1000).toISOString();
        saveVRState(state);
        return {
            shouldEngage: false,
            reason: `${state.consecutiveIgnored} consecutive comments ignored. Cooling off.`,
            contactState: state,
        };
    }

    // Minimum interval between comments to same person (2 hours)
    if (state.lastCommentAt) {
        const hoursSince = (Date.now() - new Date(state.lastCommentAt).getTime()) / (1000 * 60 * 60);
        if (hoursSince < 2) {
            saveVRState(state);
            return {
                shouldEngage: false,
                reason: `Too soon since last comment (${hoursSince.toFixed(1)}h < 2h)`,
                contactState: state,
            };
        }
    }

    // ── VR schedule check ───────────────────────────────────────────

    state.counter++;

    if (state.counter < state.nextThreshold) {
        saveVRState(state);
        return {
            shouldEngage: false,
            reason: `Counter ${state.counter}/${state.nextThreshold} — not yet`,
            contactState: state,
        };
    }

    // ── Threshold reached → engage! ─────────────────────────────────

    // Select comment style via bandit
    const style = selectBanditArm(state.commentBandit);

    // Update state
    state.counter = 0;
    state.totalReinforcements++;
    state.totalComments++;
    state.commentsToday++;
    state.lastCommentAt = new Date().toISOString();

    // Apply thinning
    updateThinning(state);

    // Draw next threshold with (possibly thinned) meanN
    state.nextThreshold = drawGeometric(state.meanN);

    saveVRState(state);

    logger.info(
        `[vr-scheduler] ENGAGE @${username} | style=${style} | ` +
        `health=${state.health.toFixed(2)} | meanN=${state.meanN.toFixed(1)} | ` +
        `nextN=${state.nextThreshold} | total=${state.totalComments}`
    );

    return {
        shouldEngage: true,
        reason: `VR threshold reached (counter was ${state.nextThreshold})`,
        style,
        contactState: state,
    };
}

// ── Bandit: epsilon-greedy arm selection ──────────────────────────────

function selectBanditArm(arms: BanditArm[]): CommentStyle {
    // Explore with probability EPSILON
    if (Math.random() < EPSILON || arms.every(a => a.pulls === 0)) {
        const idx = Math.floor(Math.random() * arms.length);
        return arms[idx].style;
    }

    // Exploit: pick arm with highest avgReward
    let bestArm = arms[0];
    for (const arm of arms) {
        if (arm.pulls > 0 && arm.avgReward > bestArm.avgReward) {
            bestArm = arm;
        }
    }
    return bestArm.style;
}

/**
 * Record reward for a bandit arm (e.g., our comment got a reply = reward 1).
 */
export function recordBanditReward(
    username: string,
    platform: 'twitter' | 'instagram',
    style: CommentStyle,
    reward: number, // 0 or 1 (or fractional)
): void {
    const state = loadVRState(username, platform);
    const arm = state.commentBandit.find(a => a.style === style);
    if (arm) {
        arm.pulls++;
        arm.rewards += reward;
        arm.avgReward = arm.rewards / arm.pulls;
    }
    saveVRState(state);
}

// ── Record bandit pull without reward yet ─────────────────────────────

export function recordBanditPull(
    username: string,
    platform: 'twitter' | 'instagram',
    style: CommentStyle,
): void {
    const state = loadVRState(username, platform);
    const arm = state.commentBandit.find(a => a.style === style);
    if (arm) {
        arm.pulls++;
        arm.avgReward = arm.pulls > 0 ? arm.rewards / arm.pulls : 0;
    }
    saveVRState(state);
}

// ── Health management ────────────────────────────────────────────────

export function updateHealth(
    username: string,
    platform: 'twitter' | 'instagram',
    event: keyof typeof HEALTH_DELTAS,
    customDelta?: number,
): number {
    const state = loadVRState(username, platform);
    const delta = customDelta ?? HEALTH_DELTAS[event];

    state.health = Math.max(0, Math.min(HEALTH_CEILING, state.health + delta));
    state.healthHistory.push({
        value: state.health,
        delta,
        reason: event,
        at: new Date().toISOString(),
    });

    // Keep history bounded
    if (state.healthHistory.length > 100) {
        state.healthHistory = state.healthHistory.slice(-50);
    }

    // Track consecutive ignored
    if (event === 'comment_ignored') {
        state.consecutiveIgnored++;
    } else if (event === 'reply_received' || event === 'like_received') {
        state.consecutiveIgnored = 0;
        state.totalRepliesReceived++;
    }

    saveVRState(state);

    // RL feedback: auto-adjust meanN based on health trend
    adjustMeanNFromHealth(username, platform);

    return state.health;
}

// ── Thinning ─────────────────────────────────────────────────────────

function updateThinning(state: VRContactState): void {
    for (let i = THINNING_SCHEDULE.length - 1; i >= 0; i--) {
        if (state.totalReinforcements >= THINNING_SCHEDULE[i].afterReinforcements) {
            if (state.thinningStage !== i) {
                state.thinningStage = i;
                const newMean = DEFAULT_MEAN_N * THINNING_SCHEDULE[i].meanMultiplier;
                state.meanN = Math.min(MAX_MEAN_N, newMean);
                logger.info(
                    `[vr-scheduler] Thinning @${state.username}: stage ${i}, ` +
                    `meanN → ${state.meanN.toFixed(1)} (after ${state.totalReinforcements} reinforcements)`
                );
            }
            break;
        }
    }
}

// ── Batch: get contacts ready for engagement ─────────────────────────

/**
 * Returns contacts whose VR counter is at or near threshold.
 * Useful for the scheduler to know who to visit.
 */
export function getContactsReadyForEngagement(
    platform: 'twitter' | 'instagram',
    maxContacts: number = 5,
): Array<{ username: string; counter: number; threshold: number; health: number }> {
    const states = getAllVRStates(platform);
    const today = todayStr();
    const ready: Array<{ username: string; counter: number; threshold: number; health: number; ratio: number }> = [];

    for (const state of states) {
        // Skip paused
        if (state.pausedUntil && new Date(state.pausedUntil) > new Date()) continue;
        // Skip health-floored
        if (state.health < HEALTH_FLOOR) continue;
        // Skip daily-capped
        const todayComments = state.lastCommentDate === today ? state.commentsToday : 0;
        if (todayComments >= MAX_COMMENTS_PER_DAY_PER_USER) continue;
        // Skip consecutive-ignored
        if (state.consecutiveIgnored >= MAX_CONSECUTIVE_IGNORED) continue;

        const ratio = state.counter / Math.max(1, state.nextThreshold);
        // Include contacts that are at 60%+ of their threshold (likely to trigger soon)
        if (ratio >= 0.6) {
            ready.push({
                username: state.username,
                counter: state.counter,
                threshold: state.nextThreshold,
                health: state.health,
                ratio,
            });
        }
    }

    // Sort by ratio descending (closest to threshold first)
    ready.sort((a, b) => b.ratio - a.ratio);
    return ready.slice(0, maxContacts).map(({ ratio, ...rest }) => rest);
}

// ── Get global engagement stats ──────────────────────────────────────

export function getVRStats(platform?: 'twitter' | 'instagram'): {
    totalContacts: number;
    activeContacts: number;
    pausedContacts: number;
    avgHealth: number;
    totalComments: number;
    totalRepliesReceived: number;
    bestArms: Array<{ style: CommentStyle; avgReward: number; pulls: number }>;
} {
    const states = getAllVRStates(platform);
    const now = new Date();

    let active = 0;
    let paused = 0;
    let healthSum = 0;
    let totalComments = 0;
    let totalReplies = 0;
    const armAgg: Record<string, { pulls: number; rewards: number }> = {};

    for (const state of states) {
        if (state.pausedUntil && new Date(state.pausedUntil) > now) {
            paused++;
        } else {
            active++;
        }
        healthSum += state.health;
        totalComments += state.totalComments;
        totalReplies += state.totalRepliesReceived;

        for (const arm of state.commentBandit) {
            if (!armAgg[arm.style]) armAgg[arm.style] = { pulls: 0, rewards: 0 };
            armAgg[arm.style].pulls += arm.pulls;
            armAgg[arm.style].rewards += arm.rewards;
        }
    }

    const bestArms = Object.entries(armAgg)
        .map(([style, { pulls, rewards }]) => ({
            style: style as CommentStyle,
            avgReward: pulls > 0 ? rewards / pulls : 0,
            pulls,
        }))
        .sort((a, b) => b.avgReward - a.avgReward);

    return {
        totalContacts: states.length,
        activeContacts: active,
        pausedContacts: paused,
        avgHealth: states.length > 0 ? healthSum / states.length : 0,
        totalComments,
        totalRepliesReceived: totalReplies,
        bestArms,
    };
}

// ── Feature: RL Meta-Optimization (health → meanN feedback loop) ────

const RL_LEARNING_RATE = 0.12;

/**
 * Auto-adjust meanN based on recent health trend.
 * Declining health → engage more (lower meanN).
 * Rising health → space out (raise meanN).
 */
function adjustMeanNFromHealth(username: string, platform: 'twitter' | 'instagram'): void {
    const state = loadVRState(username, platform);
    const recent = state.healthHistory.slice(-5);
    if (recent.length < 3) return; // Need enough data

    const avgDelta = recent.reduce((sum, h) => sum + h.delta, 0) / recent.length;

    if (avgDelta < -0.02) {
        // Health declining → engage more (lower meanN)
        const oldMean = state.meanN;
        state.meanN = Math.max(MIN_MEAN_N, state.meanN - 0.5);
        if (state.meanN !== oldMean) {
            logger.info(`[vr-scheduler] RL: @${username} health declining (avg delta ${avgDelta.toFixed(3)}) → meanN ${oldMean.toFixed(1)} → ${state.meanN.toFixed(1)}`);
        }
    } else if (avgDelta > 0.02) {
        // Health rising → space out (raise meanN)
        const oldMean = state.meanN;
        state.meanN = Math.min(MAX_MEAN_N, state.meanN + 0.3);
        if (state.meanN !== oldMean) {
            logger.info(`[vr-scheduler] RL: @${username} health rising (avg delta ${avgDelta.toFixed(3)}) → meanN ${oldMean.toFixed(1)} → ${state.meanN.toFixed(1)}`);
        }
    }

    saveVRState(state);
}

// ── Feature: Jackpot DM Reply Mechanics ──────────────────────────────

export interface JackpotDecision {
    jackpot: boolean;
    reason: string;
}

/**
 * Determine if this DM reply should be a "big reward" (jackpot).
 * Uses a separate VR counter from comment engagement.
 * Jackpot replies are longer, more personal, higher-effort AI messages.
 */
export function isJackpotReply(
    username: string,
    platform: 'twitter' | 'instagram',
): JackpotDecision {
    const state = loadVRState(username, platform);

    state.dmReplyCounter++;

    if (state.dmReplyCounter >= state.dmNextThreshold) {
        // Jackpot! Reset and draw next threshold
        state.dmReplyCounter = 0;
        // Jackpots are rarer than comment reinforcements — use 2x meanN
        const jackpotMeanN = Math.max(MIN_MEAN_N, state.meanN * 2);
        state.dmNextThreshold = drawGeometric(jackpotMeanN);

        saveVRState(state);
        logger.info(`[vr-scheduler] JACKPOT reply for @${username} | nextN=${state.dmNextThreshold} | meanN=${jackpotMeanN.toFixed(1)}`);

        return {
            jackpot: true,
            reason: `VR threshold reached (counter was ${state.dmNextThreshold})`,
        };
    }

    saveVRState(state);
    return {
        jackpot: false,
        reason: `Counter ${state.dmReplyCounter}/${state.dmNextThreshold} — standard reply`,
    };
}

// ── Feature: Offer Readiness Score ──────────────────────────────────

export interface OfferReadinessResult {
    score: number; // 0.0 - 1.0
    breakdown: {
        healthComponent: number;
        tierComponent: number;
        velocityComponent: number;
        sentimentComponent: number;
    };
}

const TIER_WEIGHTS: Record<string, number> = {
    acquaintance: 0,
    casual_friend: 0.2,
    close_friend: 0.5,
    inner_circle: 0.8,
};

/**
 * Compute how ready a contact is to receive an offer.
 * Combines health, tier, engagement velocity, and sentiment ratio.
 */
export function computeOfferReadiness(
    username: string,
    platform: 'twitter' | 'instagram',
): OfferReadinessResult {
    const state = loadVRState(username, platform);

    // Health component (0-1)
    const healthComponent = state.health;

    // Tier component — load nurture profile if available
    let tierComponent = 0;
    try {
        const { loadNurtureProfile } = require('./store');
        const profile = loadNurtureProfile(username, platform);
        tierComponent = TIER_WEIGHTS[profile.tier] ?? 0;
    } catch (_) { /* nurture not initialized */ }

    // Engagement velocity: count positive events in last 14 days
    const twoWeeksAgo = Date.now() - 14 * 24 * 60 * 60 * 1000;
    const recentHistory = state.healthHistory.filter(h => new Date(h.at).getTime() > twoWeeksAgo);
    const positiveEvents = recentHistory.filter(h => h.delta > 0).length;
    // Normalize: 10+ positive events in 14 days = max velocity
    const velocityComponent = Math.min(1, positiveEvents / 10);

    // Sentiment ratio: proportion of positive events in recent history
    const totalRecent = recentHistory.length;
    const sentimentComponent = totalRecent > 0 ? positiveEvents / totalRecent : 0.5;

    const score = Math.min(1, Math.max(0,
        (healthComponent * 0.35) +
        (tierComponent * 0.25) +
        (velocityComponent * 0.25) +
        (sentimentComponent * 0.15)
    ));

    return {
        score,
        breakdown: { healthComponent, tierComponent, velocityComponent, sentimentComponent },
    };
}
