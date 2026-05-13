/**
 * Instagram DM Pipeline — Autonomous outreach system
 *
 * Wires together: profile scraping → categorization → AI message generation
 * → approval flow → DM sending → tracking → feedback loop
 */

import { Page } from 'puppeteer';
import { InstagramDM } from './Instagram-DM';
import { scrapeProfile, scrapeOurProfile } from './Instagram-Profile';
import {
    generateDMMessage, generateColdOutreach, generateFollowUp,
    categorizeContact, loadRelationship, saveRelationship, updateWarmth,
    recordFeedback, getFeedbackStats, MessageFeedback, getReplyObjective
} from './Instagram-DM-AI';
import { scrapeConversationThread, checkForNewDMs, StoredConversation } from './Instagram-DM-Watcher';
import { trackDM, hasSentDMTo, hasContactedToday, createDMSession, saveDMSession, getDMsForUser, getTodayDMCount } from '../tracking/dmTracker';
import { syncDMToSupabase } from '../db/supabaseDM';
import { notifyDMSent, notifyDMApprovalNeeded, notifyDMAutoReply, notifyDMReplyReceived } from '../utils/telegram';
import { logger } from '../utils/logger';
import { formatError } from '../utils/errors';
import { ProfileInfo, RelationshipInfo, DMMessage, DMSendResult, TrackedDM } from '../types/dm';
import { isJackpotReply, computeOfferReadiness } from '../nurture/vr-scheduler';
import { computeReplyDelay, scheduleDelayedReply, getReadyReplies, markReplySent, markReplyFailed, cleanupDelayedQueue, hasPendingReply } from '../nurture/vi-delays';
import * as fs from 'fs';
import * as path from 'path';

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

// ── Auto-Reply Constants ─────────────────────────────────────────────

const AUTO_REPLY_MAX_PER_RUN = 5;
const AUTO_REPLY_COOLDOWN_HOURS = 1;
const AUTO_REPLY_DELAY_MS = 60000;
const OPT_OUT_KEYWORDS = ['stop', 'unsubscribe', 'leave me alone', 'block', 'report', 'spam', "don't message", 'no thanks'];

export interface DMAutoReplyResult {
    processed: number;
    replied: number;
    skipped: number;
    failed: number;
    details: Array<{ username: string; action: 'replied' | 'skipped' | 'failed'; reason?: string }>;
    dryRunMessages?: Array<{ username: string; message: string; delayMinutes: number; isJackpot: boolean }>;
}

// ── Bot / Automated Account Detection ───────────────────────────────

const BOT_LINK_PATTERNS = ['http://', 'https://', 'www.', 'bit.ly/', '.com/', '.co/'];
const BOT_DOWNLOAD_PHRASES = [
    'download', 'free guide', 'free ebook', 'click here', 'click below',
    'click on', 'link in bio', 'grab your', 'get your free', 'tap the link', 'tap here'
];
const BOT_WELCOME_PHRASES = [
    'thanks for following', 'thank you for following', 'thanks for connecting',
    'thanks for the follow', 'welcome!', 'welcome to'
];
const BOT_LEAD_MAGNET_PHRASES = [
    'exclusive access', 'limited time', 'sign up', 'register now',
    'claim your', 'free trial', 'discount code', 'use code', 'promo code',
    'join my newsletter', 'join our newsletter', 'subscribe to'
];
const BOT_USERNAME_PATTERNS = [
    /\d{5,}$/,              // ends with 5+ digits
    /_bot$/i,               // ends with _bot
    /_official\d+$/i,       // _official123
    /^(marketing|growth|leads|sales)\d+/i, // marketing123, growth99
    /__.*__/,               // double underscores
];

export function isLikelyBot(preview: string, username?: string): { isBot: boolean; reason: string } {
    const lower = (preview || '').toLowerCase();

    // Check link/spam patterns
    if (BOT_LINK_PATTERNS.some(p => lower.includes(p))) {
        return { isBot: true, reason: 'contains link/URL' };
    }

    // Check download/freebie language
    const dlMatch = BOT_DOWNLOAD_PHRASES.find(p => lower.includes(p));
    if (dlMatch) {
        return { isBot: true, reason: `download/freebie language: "${dlMatch}"` };
    }

    // Check automated welcome messages
    const welcomeMatch = BOT_WELCOME_PHRASES.find(p => lower.includes(p));
    if (welcomeMatch) {
        return { isBot: true, reason: `automated welcome: "${welcomeMatch}"` };
    }

    // Check lead magnet language
    const leadMatch = BOT_LEAD_MAGNET_PHRASES.find(p => lower.includes(p));
    if (leadMatch) {
        return { isBot: true, reason: `lead magnet language: "${leadMatch}"` };
    }

    // Check username patterns
    if (username) {
        const uLower = username.toLowerCase();
        for (const pattern of BOT_USERNAME_PATTERNS) {
            if (pattern.test(uLower)) {
                return { isBot: true, reason: `bot-like username pattern: ${pattern}` };
            }
        }
    }

    return { isBot: false, reason: '' };
}

// ── Username Validation ─────────────────────────────────────────────

/** Words that are Twitter/Instagram UI elements, not real usernames */
const INVALID_USERNAMES = new Set([
    'chat', 'search', 'all', 'requests', 'messages', 'compose', 'new message',
    'home', 'explore', 'notifications', 'settings', 'primary', 'general',
    'inbox', 'direct', 'unread', 'pinned', 'muted', 'active', 'online',
    'typing', 'message', 'new', 'edit', 'you', 'sent', 'your note',
]);

/**
 * Validate that a username looks like a real social media handle.
 * Filters out UI chrome labels, empty strings, and impossible formats.
 */
export function isValidUsername(username: string): { valid: boolean; reason: string } {
    if (!username || username.trim().length === 0) {
        return { valid: false, reason: 'empty username' };
    }

    const clean = username.toLowerCase().replace(/^@/, '').trim();

    if (clean.length === 0) {
        return { valid: false, reason: 'empty after cleanup' };
    }

    // Known UI labels
    if (INVALID_USERNAMES.has(clean)) {
        return { valid: false, reason: `UI label: "${clean}"` };
    }

    // Twitter handles: 1-15 alphanumeric + underscores
    // Instagram handles: 1-30 alphanumeric + underscores + periods
    // Be permissive — allow both formats
    if (clean.length > 30) {
        return { valid: false, reason: 'username too long (>30 chars)' };
    }

    // Must contain at least one letter (pure numbers aren't usernames)
    if (/^\d+$/.test(clean)) {
        return { valid: false, reason: 'all-numeric username' };
    }

    // Reject if it looks like a time indicator (2h, 30m, 1d)
    if (/^\d+[hmd]$/i.test(clean)) {
        return { valid: false, reason: 'time indicator, not username' };
    }

    // Reject if it contains spaces (real handles don't have spaces)
    // Exception: Instagram display names can have spaces, but handles can't
    if (/\s/.test(clean) && clean.length < 5) {
        return { valid: false, reason: 'short text with spaces — likely UI label' };
    }

    return { valid: true, reason: '' };
}

// ── Offer Catalog ───────────────────────────────────────────────────

export interface Offer {
    id: string;
    name: string;
    description: string;
    targetCategories: RelationshipInfo['category'][];
    targetTags: string[];          // e.g. ['creator', 'micro_influencer']
    targetNiches: string[];        // e.g. ['marketing', 'tech', 'ai']
    minWarmth: number;             // Don't pitch until warmth >= this
    minStage: RelationshipInfo['stage'];
    messageHint: string;           // Context for AI when crafting the pitch
    active: boolean;
    timesOffered: number;
    conversions: number;
}

const OFFERS_FILE = path.join(process.cwd(), 'logs', 'tracking', 'dm', 'offers.json');

export function loadOffers(): Offer[] {
    try {
        if (fs.existsSync(OFFERS_FILE)) {
            return JSON.parse(fs.readFileSync(OFFERS_FILE, 'utf8'));
        }
    } catch (e) { logger.warn('[pipeline] Failed to load offers: ' + formatError(e)); }
    return getDefaultOffers();
}

export function saveOffers(offers: Offer[]) {
    const dir = path.dirname(OFFERS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(OFFERS_FILE, JSON.stringify(offers, null, 2));
}

function getDefaultOffers(): Offer[] {
    return [
        {
            id: 'ai_tools_collab',
            name: 'AI Tools Collaboration',
            description: 'Collaboration on AI-powered content creation tools',
            targetCategories: ['collaborator', 'business_networking'],
            targetTags: ['creator', 'micro_influencer', 'macro_influencer'],
            targetNiches: ['ai', 'tech', 'content', 'marketing'],
            minWarmth: 60,
            minStage: 'warm',
            messageHint: 'We build AI-powered tools for content creators. Mention how a collaboration could benefit both sides.',
            active: true,
            timesOffered: 0,
            conversions: 0
        },
        {
            id: 'growth_consulting',
            name: 'Growth Strategy Consulting',
            description: 'Social media growth strategy and automation consulting',
            targetCategories: ['potential_client', 'business_networking'],
            targetTags: [],
            targetNiches: ['marketing', 'business', 'startup', 'entrepreneur'],
            minWarmth: 50,
            minStage: 'building',
            messageHint: 'We help businesses grow their social media presence with AI-driven strategies. Offer a free audit or consultation.',
            active: true,
            timesOffered: 0,
            conversions: 0
        }
    ];
}

// ── Offer Matching ──────────────────────────────────────────────────

export function matchOffer(
    theirProfile: ProfileInfo,
    relationship: RelationshipInfo,
    username?: string,
    platform?: 'twitter' | 'instagram'
): Offer | null {
    const offers = loadOffers().filter(o => o.active);
    const bio = (theirProfile.bio || '').toLowerCase();

    // Check offer readiness — skip for cold outreach (new contacts have no history to score)
    const coldStages = ['cold_outreach', 'initial_contact'];
    if (username && platform && !coldStages.includes(relationship.stage)) {
        try {
            const readiness = computeOfferReadiness(username, platform);
            if (readiness.score < 0.45) {
                logger.info(`[pipeline] Offer readiness too low for @${username}: ${readiness.score.toFixed(2)} (need 0.45+)`);
                return null;
            }
        } catch (e) {
            logger.debug(`[pipeline] Offer readiness check skipped for @${username}: ${formatError(e)}`);
        }
    }

    for (const offer of offers) {
        // Check warmth threshold
        if (relationship.warmth < offer.minWarmth) continue;

        // Check stage threshold
        const stageOrder = ['cold_outreach', 'initial_contact', 'building', 'warm', 'active'];
        const currentStageIdx = stageOrder.indexOf(relationship.stage);
        const minStageIdx = stageOrder.indexOf(offer.minStage);
        if (currentStageIdx === -1 || minStageIdx === -1 || currentStageIdx < minStageIdx) continue;

        // Check category match
        if (offer.targetCategories.length > 0 && !offer.targetCategories.includes(relationship.category)) continue;

        // Check tag match (at least one)
        if (offer.targetTags.length > 0 && !offer.targetTags.some(t => relationship.tags.includes(t))) {
            // Also check bio for niche keywords
            const nicheMatch = offer.targetNiches.some(n => bio.includes(n));
            if (!nicheMatch) continue;
        }

        return offer;
    }
    return null;
}

// ── Pipeline Configuration ──────────────────────────────────────────

export interface PipelineConfig {
    autoApprove: boolean;             // Auto-send or require manual approval
    maxDMsPerDay: number;             // Daily DM limit
    minDelayBetweenDMs: number;       // Milliseconds between DMs
    cooldownHoursPerUser: number;     // Don't DM same user within this window
    skipIfNoReplyAfterDays: number;   // Stop following up if no reply after N days
    maxFollowUps: number;             // Max follow-up messages per contact
    offerEnabled: boolean;            // Include offers when appropriate
}

const DEFAULT_CONFIG: PipelineConfig = {
    autoApprove: false,              // Manual approval by default (safer)
    maxDMsPerDay: 20,
    minDelayBetweenDMs: 60000,       // 1 minute
    cooldownHoursPerUser: 48,        // 2 days between DMs to same person
    skipIfNoReplyAfterDays: 7,
    maxFollowUps: 3,
    offerEnabled: true
};

const CONFIG_FILE = path.join(process.cwd(), 'logs', 'tracking', 'dm', 'pipeline_config.json');
const PENDING_FILE = path.join(process.cwd(), 'logs', 'tracking', 'dm', 'pending_sends.json');

export function loadConfig(): PipelineConfig {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) };
        }
    } catch (e) { logger.warn('[pipeline] Failed to load config: ' + formatError(e)); }
    return DEFAULT_CONFIG;
}

export function saveConfig(config: PipelineConfig) {
    const dir = path.dirname(CONFIG_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

// ── Pending Sends (approval queue) ──────────────────────────────────

export interface PendingSend {
    id: string;
    recipientUsername: string;
    message: string;
    context: {
        relationship: RelationshipInfo;
        offer?: Offer;
        objective: string;
    };
    status: 'pending' | 'approved' | 'rejected' | 'sent' | 'failed';
    createdAt: string;
    reviewedAt?: string;
    sentAt?: string;
    error?: string;
}

export function loadPendingSends(): PendingSend[] {
    try {
        if (fs.existsSync(PENDING_FILE)) {
            return JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8'));
        }
    } catch (e) { logger.warn('[pipeline] Failed to load pending sends: ' + formatError(e)); }
    return [];
}

export function savePendingSends(sends: PendingSend[]) {
    const dir = path.dirname(PENDING_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(PENDING_FILE, JSON.stringify(sends, null, 2));
}

// ── The Pipeline ────────────────────────────────────────────────────

export class DMPipeline {
    private dm: InstagramDM;
    private config: PipelineConfig;
    private ourProfile: ProfileInfo | null = null;

    constructor(dm: InstagramDM, config?: Partial<PipelineConfig>) {
        this.dm = dm;
        this.config = { ...loadConfig(), ...config };
    }

    // ── Process a single target: scrape → categorize → generate → queue/send ──

    async processTarget(username: string): Promise<PendingSend | null> {
        let page;
        try { page = await this.dm.ensurePage(); } catch (e) {
            logger.error(`[pipeline] Browser page not available — cannot process target: ${formatError(e)}`);
            return null;
        }

        // Check cooldown
        const recentDM = hasSentDMTo(username, this.config.cooldownHoursPerUser);
        if (recentDM) {
            logger.info(`[pipeline] Skipping @${username} — DM sent ${this.config.cooldownHoursPerUser}h ago`);
            return null;
        }

        // Check max follow-ups
        const pastDMs = getDMsForUser(username).filter(d => d.direction === 'outbound');
        if (pastDMs.length >= this.config.maxFollowUps) {
            // Check if they ever replied
            const theirDMs = getDMsForUser(username).filter(d => d.direction === 'inbound');
            if (theirDMs.length === 0) {
                logger.info(`[pipeline] Skipping @${username} — ${pastDMs.length} follow-ups with no reply`);
                return null;
            }
        }

        // Scrape profiles
        if (!this.ourProfile) {
            this.ourProfile = await scrapeOurProfile(page);
        }
        const theirProfile = await scrapeProfile(page, username);
        await delay(2000);

        // Load/create relationship
        let relationship = loadRelationship(username);
        if (relationship.warmth === 0 && relationship.stage === 'cold_outreach' && pastDMs.length === 0) {
            const auto = categorizeContact(theirProfile);
            relationship.category = auto.category || relationship.category;
            relationship.tags = auto.tags || [];
            saveRelationship(username, relationship);
        }

        // Determine objective
        let objective: string | undefined;
        let matchedOffer: Offer | undefined;

        if (this.config.offerEnabled) {
            const offer = matchOffer(theirProfile, relationship, username, 'instagram');
            if (offer) {
                objective = offer.messageHint;
                matchedOffer = offer;
                logger.info(`[pipeline] Matched offer "${offer.name}" for @${username}`);
            }
        }

        // Load conversation history
        let conversationHistory: DMMessage[] = [];
        try {
            const thread = await scrapeConversationThread(this.dm, username, 3);
            conversationHistory = thread.messages;
        } catch (e) { logger.warn('[pipeline] Failed to scrape conversation thread: ' + formatError(e)); }

        // Generate AI message
        const message = await generateDMMessage({
            ourProfile: this.ourProfile,
            theirProfile,
            conversationHistory,
            relationship,
            objective
        });

        // Create pending send
        const pending: PendingSend = {
            id: `send_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            recipientUsername: username,
            message,
            context: {
                relationship,
                offer: matchedOffer,
                objective: objective || 'General outreach based on relationship stage'
            },
            status: 'pending',
            createdAt: new Date().toISOString()
        };

        if (this.config.autoApprove) {
            // Auto-send
            return await this.executeSend(pending);
        } else {
            // Queue for approval
            const sends = loadPendingSends();
            sends.push(pending);
            savePendingSends(sends);
            await notifyDMApprovalNeeded(username, message, pending.id);
            logger.info(`[pipeline] Queued DM for @${username} — awaiting approval (${pending.id})`);
            return pending;
        }
    }

    // ── Execute an approved send ────────────────────────────────────

    async executeSend(pending: PendingSend): Promise<PendingSend> {
        try {
            logger.info(`[pipeline] Sending DM to @${pending.recipientUsername}...`);
            const result = await this.dm.sendDM(pending.recipientUsername, pending.message);

            pending.sentAt = new Date().toISOString();

            if (result.success) {
                pending.status = 'sent';
                updateWarmth(pending.recipientUsername, 'message_sent');
                await notifyDMSent(pending.recipientUsername, pending.message, result.verified);

                // Track offer if one was matched
                if (pending.context.offer) {
                    const offers = loadOffers();
                    const offer = offers.find(o => o.id === pending.context.offer!.id);
                    if (offer) {
                        offer.timesOffered++;
                        saveOffers(offers);
                    }
                }
            } else {
                pending.status = 'failed';
                pending.error = result.error;
            }

            // Update pending sends file
            const sends = loadPendingSends();
            const idx = sends.findIndex(s => s.id === pending.id);
            if (idx >= 0) sends[idx] = pending;
            else sends.push(pending);
            savePendingSends(sends);

            return pending;
        } catch (e) {
            pending.status = 'failed';
            pending.error = e instanceof Error ? e.message : String(e);
            return pending;
        }
    }

    // ── Process approved sends from the queue ───────────────────────

    async processApprovedSends(): Promise<PendingSend[]> {
        const sends = loadPendingSends();
        const approved = sends.filter(s => s.status === 'approved');
        const results: PendingSend[] = [];

        for (const send of approved) {
            const result = await this.executeSend(send);
            results.push(result);
            await delay(this.config.minDelayBetweenDMs);
        }

        return results;
    }

    // ── Batch outreach: process multiple targets ────────────────────

    async runBatchOutreach(usernames: string[]): Promise<{
        queued: number;
        sent: number;
        skipped: number;
        failed: number;
    }> {
        const session = createDMSession();
        const stats = { queued: 0, sent: 0, skipped: 0, failed: 0 };

        logger.info(`[pipeline] Starting batch outreach to ${usernames.length} targets`);

        for (const username of usernames) {
            // Check daily limit
            if (getTodayDMCount() >= this.config.maxDMsPerDay) {
                logger.info(`[pipeline] Daily limit reached (${this.config.maxDMsPerDay})`);
                break;
            }

            try {
                const result = await this.processTarget(username);
                if (!result) {
                    stats.skipped++;
                } else if (result.status === 'sent') {
                    stats.sent++;
                    session.messagesSent++;
                } else if (result.status === 'pending') {
                    stats.queued++;
                } else if (result.status === 'failed') {
                    stats.failed++;
                    session.messagesFailed++;
                    session.errors.push(result.error || 'Unknown error');
                }
            } catch (e) {
                stats.failed++;
                session.errors.push(e instanceof Error ? e.message : String(e));
                logger.error(`[pipeline] Error processing @${username}:`, e);
            }

            await delay(this.config.minDelayBetweenDMs);
        }

        saveDMSession(session);
        logger.info(`[pipeline] Batch complete: ${stats.sent} sent, ${stats.queued} queued, ${stats.skipped} skipped, ${stats.failed} failed`);
        return stats;
    }

    // ── Auto-reply to incoming DMs ─────────────────────────────────────

    async processDMAutoReplies(options?: { dryRun?: boolean }): Promise<DMAutoReplyResult> {
        const result: DMAutoReplyResult = { processed: 0, replied: 0, skipped: 0, failed: 0, details: [] };
        let page;
        try { page = await this.dm.ensurePage(); } catch (e) {
            logger.warn(`[pipeline] Browser page not available — cannot process auto-replies: ${formatError(e)}`);
            return result;
        }

        const ourUsername = (process.env.INSTAGRAM_BOT_USERNAME || '').toLowerCase();

        // 1. Detect new incoming messages
        let newMessages: Array<{ from: string; preview: string }> = [];
        try {
            const detected = await checkForNewDMs(this.dm);
            newMessages = detected.newMessages;
        } catch (e) {
            logger.error(`[pipeline] Failed to check for new DMs: ${formatError(e)}`);
            return result;
        }

        if (newMessages.length === 0) {
            logger.info('[pipeline] Auto-reply: no new messages to process');
            return result;
        }

        logger.info(`[pipeline] Auto-reply: ${newMessages.length} new message(s) to evaluate`);

        for (const { from, preview } of newMessages) {
            const username = from.toLowerCase().replace('@', '');
            result.processed++;

            // GUARD: skip our own messages
            if (username === ourUsername) {
                result.skipped++;
                result.details.push({ username, action: 'skipped', reason: 'own message' });
                continue;
            }

            // GUARD: invalid username (UI labels like "chat", "search", etc.)
            const usernameCheck = isValidUsername(username);
            if (!usernameCheck.valid) {
                result.skipped++;
                result.details.push({ username, action: 'skipped', reason: `invalid username: ${usernameCheck.reason}` });
                continue;
            }

            // GUARD: already contacted today (sent DM or pending scheduled reply)
            if (hasContactedToday(username)) {
                result.skipped++;
                result.details.push({ username, action: 'skipped', reason: 'already contacted today' });
                continue;
            }

            // GUARD: per-user cooldown
            if (hasSentDMTo(username, AUTO_REPLY_COOLDOWN_HOURS)) {
                result.skipped++;
                result.details.push({ username, action: 'skipped', reason: `cooldown (${AUTO_REPLY_COOLDOWN_HOURS}h)` });
                continue;
            }

            // GUARD: daily limit
            if (getTodayDMCount() >= this.config.maxDMsPerDay) {
                result.skipped++;
                result.details.push({ username, action: 'skipped', reason: 'daily limit reached' });
                continue;
            }

            // GUARD: max replies per run
            if (result.replied >= AUTO_REPLY_MAX_PER_RUN) {
                result.skipped++;
                result.details.push({ username, action: 'skipped', reason: 'max replies per run reached' });
                continue;
            }

            // GUARD: already have a pending delayed reply for this user
            if (hasPendingReply(username, 'instagram')) {
                result.skipped++;
                result.details.push({ username, action: 'skipped', reason: 'reply already scheduled' });
                continue;
            }

            // GUARD: opt-out detection
            const previewLower = preview.toLowerCase();
            if (OPT_OUT_KEYWORDS.some(k => previewLower.includes(k))) {
                logger.info(`[pipeline] Auto-reply: opt-out detected from @${username}`);
                const rel = loadRelationship(username);
                rel.warmth = Math.max(0, rel.warmth - 20);
                rel.notes.push(`Opt-out detected: "${preview.slice(0, 50)}" (${new Date().toISOString()})`);
                saveRelationship(username, rel);
                result.skipped++;
                result.details.push({ username, action: 'skipped', reason: 'opt-out detected' });
                continue;
            }

            // GUARD: bot / automated account detection
            const botCheck = isLikelyBot(preview, username);
            if (botCheck.isBot) {
                logger.info(`[pipeline] Auto-reply: bot detected from @${username}: ${botCheck.reason}`);
                result.skipped++;
                result.details.push({ username, action: 'skipped', reason: `bot: ${botCheck.reason}` });
                continue;
            }

            // Scrape conversation thread to verify it's our turn
            try {
                const thread = await scrapeConversationThread(this.dm, username, 3);
                const messages = thread.messages;

                // Use resolved handle from thread header (falls back to display name)
                const resolvedHandle = (thread as any).handle || username;

                // GUARD: check it's our turn to reply (last message must be theirs)
                if (messages.length > 0 && messages[messages.length - 1].isOurs) {
                    result.skipped++;
                    result.details.push({ username: resolvedHandle, action: 'skipped', reason: 'already replied (their turn)' });
                    continue;
                }

                // Load relationship & profile using resolved handle
                const relationship = loadRelationship(resolvedHandle);
                if (!this.ourProfile) {
                    this.ourProfile = await scrapeOurProfile(page);
                }

                let theirProfile: ProfileInfo;
                try {
                    theirProfile = await scrapeProfile(page, resolvedHandle);
                } catch (e) {
                    logger.warn(`[pipeline] Failed to scrape profile for @${resolvedHandle}, using minimal: ${formatError(e)}`);
                    theirProfile = { username: resolvedHandle, fullName: username, bio: '', followerCount: 0, followingCount: 0, postCount: 0, isVerified: false };
                }

                // Get the last message from them for objective generation
                const lastTheirMessage = [...messages].reverse().find(m => !m.isOurs);
                const objective = getReplyObjective(relationship, lastTheirMessage?.text || preview);

                // Check jackpot mechanics
                const jackpotDecision = isJackpotReply(resolvedHandle, 'instagram');
                const isJackpot = jackpotDecision.jackpot;
                if (isJackpot) {
                    logger.info(`[pipeline] JACKPOT reply for @${resolvedHandle}: ${jackpotDecision.reason}`);
                }

                // Generate AI reply (with jackpot flag for enhanced response)
                const replyMessage = await generateDMMessage({
                    ourProfile: this.ourProfile,
                    theirProfile,
                    conversationHistory: messages,
                    relationship,
                    objective,
                    isJackpot
                });

                // Compute VI delay and schedule instead of sending immediately
                const delayMs = computeReplyDelay(resolvedHandle, 'instagram', relationship.stage, isJackpot);
                const delayMinutes = Math.round(delayMs / 60000);

                if (options?.dryRun) {
                    // Dry-run: log what would be sent but don't schedule
                    if (!result.dryRunMessages) result.dryRunMessages = [];
                    result.dryRunMessages.push({
                        username: resolvedHandle,
                        message: replyMessage,
                        delayMinutes,
                        isJackpot
                    });
                    result.replied++;
                    result.details.push({ username: resolvedHandle, action: 'replied', reason: `dry-run: would schedule in ${delayMinutes}min${isJackpot ? ' (jackpot)' : ''}` });
                    logger.info(`[pipeline] DRY RUN reply to @${resolvedHandle} in ${delayMinutes}min (jackpot=${isJackpot}): "${replyMessage.slice(0, 80)}..."`);
                } else {
                    const sendAfter = new Date(Date.now() + delayMs).toISOString();

                    scheduleDelayedReply({
                        username: resolvedHandle,
                        platform: 'instagram',
                        replyMessage,
                        sendAfter,
                        context: {
                            relationship,
                            objective,
                            isJackpot,
                            theirMessage: lastTheirMessage?.text || preview,
                            displayName: username !== resolvedHandle ? username : undefined
                        }
                    });

                    result.replied++;
                    result.details.push({ username: resolvedHandle, action: 'replied', reason: `scheduled in ${delayMinutes}min${isJackpot ? ' (jackpot)' : ''}` });
                    logger.info(`[pipeline] Scheduled reply to @${resolvedHandle} in ${delayMinutes}min (jackpot=${isJackpot}): "${replyMessage.slice(0, 50)}..."`);
                }

                // Rate limit delay between processing
                if (result.replied < AUTO_REPLY_MAX_PER_RUN) {
                    await delay(5000); // Short delay between scheduling (not sending)
                }

            } catch (e) {
                result.failed++;
                result.details.push({ username, action: 'failed', reason: formatError(e) });
                logger.error(`[pipeline] Auto-reply error for @${username}: ${formatError(e)}`);
            }
        }

        logger.info(`[pipeline] Auto-reply complete: ${result.replied} replied, ${result.skipped} skipped, ${result.failed} failed`);
        return result;
    }

    // ── Catch up on missed replies (backfill) ──────────────────────────

    async catchUpMissedReplies(options?: { dryRun?: boolean; maxConversations?: number }): Promise<DMAutoReplyResult> {
        const result: DMAutoReplyResult = { processed: 0, replied: 0, skipped: 0, failed: 0, details: [] };
        if (options?.dryRun) result.dryRunMessages = [];

        let page;
        try { page = await this.dm.ensurePage(); } catch (e) {
            logger.warn(`[pipeline] Browser page not available — cannot catch up: ${formatError(e)}`);
            return result;
        }

        const ourUsername = (process.env.INSTAGRAM_BOT_USERNAME || '').toLowerCase();
        const maxConvos = options?.maxConversations || 20;

        // 1. Scrape full inbox to get all conversations
        logger.info(`[pipeline] Catch-up: scanning inbox for missed replies...`);
        let inbox: Array<{ username: string; lastMessage: string; lastMessageTime: string; unread: boolean }> = [];
        try {
            inbox = await this.dm.scrapeInbox(true); // full scroll
        } catch (e) {
            logger.error(`[pipeline] Catch-up: failed to scrape inbox: ${formatError(e)}`);
            return result;
        }

        logger.info(`[pipeline] Catch-up: found ${inbox.length} conversations, checking up to ${maxConvos}`);

        let checked = 0;
        for (const convo of inbox) {
            if (checked >= maxConvos) break;
            if (result.replied >= AUTO_REPLY_MAX_PER_RUN) break;

            const displayName = convo.username;
            const username = displayName.toLowerCase().replace('@', '');

            // Skip our own messages
            if (username === ourUsername) continue;

            // GUARD: invalid username
            const usernameCheck = isValidUsername(username);
            if (!usernameCheck.valid) {
                result.skipped++;
                result.details.push({ username, action: 'skipped', reason: `invalid username: ${usernameCheck.reason}` });
                continue;
            }

            // GUARD: already contacted today
            if (hasContactedToday(username)) {
                result.skipped++;
                result.details.push({ username, action: 'skipped', reason: 'already contacted today' });
                continue;
            }

            // Quick filter: if last message starts with "You:" it's our turn — skip
            const lastMsgLower = (convo.lastMessage || '').toLowerCase();
            if (lastMsgLower.startsWith('you:') || lastMsgLower.startsWith('you sent')) {
                continue;
            }

            // Bot filter on preview
            const botCheck = isLikelyBot(convo.lastMessage, username);
            if (botCheck.isBot) {
                result.skipped++;
                result.details.push({ username, action: 'skipped', reason: `bot: ${botCheck.reason}` });
                continue;
            }

            // Opt-out filter on preview
            if (OPT_OUT_KEYWORDS.some(k => lastMsgLower.includes(k))) {
                result.skipped++;
                result.details.push({ username, action: 'skipped', reason: 'opt-out detected' });
                continue;
            }

            // Already have a pending reply scheduled
            if (hasPendingReply(username, 'instagram')) {
                result.skipped++;
                result.details.push({ username, action: 'skipped', reason: 'reply already scheduled' });
                continue;
            }

            // Daily limit
            if (getTodayDMCount() >= this.config.maxDMsPerDay) {
                result.skipped++;
                result.details.push({ username, action: 'skipped', reason: 'daily limit reached' });
                continue;
            }

            // Deep-scrape this thread to verify it's actually our turn
            checked++;
            result.processed++;
            try {
                const thread = await scrapeConversationThread(this.dm, displayName, 3);
                const messages = thread.messages;
                const resolvedHandle = (thread as any).handle || username;

                // Check if pending reply for resolved handle too
                if (resolvedHandle !== username && hasPendingReply(resolvedHandle, 'instagram')) {
                    result.skipped++;
                    result.details.push({ username: resolvedHandle, action: 'skipped', reason: 'reply already scheduled' });
                    continue;
                }

                // Verify last message is theirs
                if (messages.length === 0 || messages[messages.length - 1].isOurs) {
                    result.skipped++;
                    result.details.push({ username: resolvedHandle, action: 'skipped', reason: 'already replied (their turn)' });
                    continue;
                }

                // Re-check bot filter with full thread context
                const lastTheirMessage = [...messages].reverse().find(m => !m.isOurs);
                if (lastTheirMessage) {
                    const threadBotCheck = isLikelyBot(lastTheirMessage.text, resolvedHandle);
                    if (threadBotCheck.isBot) {
                        result.skipped++;
                        result.details.push({ username: resolvedHandle, action: 'skipped', reason: `bot: ${threadBotCheck.reason}` });
                        continue;
                    }
                }

                // Cooldown check on resolved handle
                if (hasSentDMTo(resolvedHandle, AUTO_REPLY_COOLDOWN_HOURS)) {
                    result.skipped++;
                    result.details.push({ username: resolvedHandle, action: 'skipped', reason: `cooldown (${AUTO_REPLY_COOLDOWN_HOURS}h)` });
                    continue;
                }

                // Load relationship & profile
                const relationship = loadRelationship(resolvedHandle);
                if (!this.ourProfile) {
                    this.ourProfile = await scrapeOurProfile(page);
                }

                let theirProfile: ProfileInfo;
                try {
                    theirProfile = await scrapeProfile(page, resolvedHandle);
                } catch (e) {
                    logger.warn(`[pipeline] Catch-up: failed to scrape profile for @${resolvedHandle}, using minimal: ${formatError(e)}`);
                    theirProfile = { username: resolvedHandle, fullName: displayName, bio: '', followerCount: 0, followingCount: 0, postCount: 0, isVerified: false };
                }

                const objective = getReplyObjective(relationship, lastTheirMessage?.text || convo.lastMessage);

                // Jackpot check
                const jackpotDecision = isJackpotReply(resolvedHandle, 'instagram');
                const isJackpot = jackpotDecision.jackpot;

                // Generate AI reply
                const replyMessage = await generateDMMessage({
                    ourProfile: this.ourProfile,
                    theirProfile,
                    conversationHistory: messages,
                    relationship,
                    objective,
                    isJackpot
                });

                // Compute delay
                const delayMs = computeReplyDelay(resolvedHandle, 'instagram', relationship.stage, isJackpot);
                const delayMinutes = Math.round(delayMs / 60000);

                if (options?.dryRun) {
                    result.dryRunMessages!.push({
                        username: resolvedHandle,
                        message: replyMessage,
                        delayMinutes,
                        isJackpot
                    });
                    result.replied++;
                    result.details.push({ username: resolvedHandle, action: 'replied', reason: `dry-run: would schedule in ${delayMinutes}min${isJackpot ? ' (jackpot)' : ''}` });
                    logger.info(`[pipeline] CATCH-UP DRY RUN @${resolvedHandle}: "${replyMessage.slice(0, 80)}..." (${delayMinutes}min)`);
                } else {
                    const sendAfter = new Date(Date.now() + delayMs).toISOString();
                    scheduleDelayedReply({
                        username: resolvedHandle,
                        platform: 'instagram',
                        replyMessage,
                        sendAfter,
                        context: {
                            relationship,
                            objective,
                            isJackpot,
                            theirMessage: lastTheirMessage?.text || convo.lastMessage,
                            displayName: displayName !== resolvedHandle ? displayName : undefined
                        }
                    });
                    result.replied++;
                    result.details.push({ username: resolvedHandle, action: 'replied', reason: `catch-up: scheduled in ${delayMinutes}min${isJackpot ? ' (jackpot)' : ''}` });
                    logger.info(`[pipeline] CATCH-UP scheduled @${resolvedHandle} in ${delayMinutes}min: "${replyMessage.slice(0, 50)}..."`);
                }

                await delay(5000); // Rate limit between processing

            } catch (e) {
                result.failed++;
                result.details.push({ username, action: 'failed', reason: formatError(e) });
                logger.error(`[pipeline] Catch-up error for @${username}: ${formatError(e)}`);
            }
        }

        logger.info(`[pipeline] Catch-up complete: ${result.replied} replied, ${result.skipped} skipped, ${result.failed} failed (checked ${checked} threads)`);
        return result;
    }

    // ── Process delayed replies (VI schedule) ──────────────────────────

    async processDelayedReplies(): Promise<{ sent: number; failed: number }> {
        const stats = { sent: 0, failed: 0 };
        const ready = getReadyReplies('instagram');

        if (ready.length === 0) return stats;

        logger.info(`[pipeline] ${ready.length} delayed reply(ies) ready to send`);

        // Note: replies to incoming DMs are NOT counted against the daily outreach limit.
        // Replying to someone who messaged us is expected behavior, not cold outreach.
        // We still cap at AUTO_REPLY_MAX_PER_RUN (5) per cycle to avoid spam bursts.
        for (const entry of ready) {
            if (stats.sent >= AUTO_REPLY_MAX_PER_RUN) {
                logger.info(`[pipeline] Max replies per run reached — deferring ${ready.length - stats.sent - stats.failed} delayed reply(ies)`);
                break;
            }

            try {
                // Try handle first, fall back to display name if thread not found
                // skipTracking: pipeline handles its own tracking below
                let sendResult = await this.dm.sendToExistingThread(entry.username, entry.replyMessage, { skipTracking: true });
                if (!sendResult.success && sendResult.error?.includes('No existing thread') && entry.context.displayName) {
                    logger.info(`[pipeline] Thread not found by handle @${entry.username}, trying display name "${entry.context.displayName}"...`);
                    sendResult = await this.dm.sendToExistingThread(entry.context.displayName, entry.replyMessage, { skipTracking: true });
                }

                if (sendResult.success) {
                    markReplySent(entry.id);

                    const tracked: TrackedDM = {
                        recipientUsername: entry.username,
                        messageText: entry.replyMessage,
                        timestamp: new Date().toISOString(),
                        direction: 'outbound',
                        verified: sendResult.verified,
                        sessionId: `auto_reply_${Date.now()}`,
                        conversationId: entry.username,
                        relationshipCategory: entry.context.relationship.category,
                        approvalStatus: 'auto'
                    };
                    trackDM(tracked);
                    updateWarmth(entry.username, 'message_sent');
                    syncDMToSupabase(tracked).catch(() => {});
                    await notifyDMAutoReply(
                        'Instagram',
                        entry.username,
                        entry.context.theirMessage || '(unknown)',
                        entry.replyMessage
                    ).catch(() => {});

                    stats.sent++;
                    logger.info(`[pipeline] Sent delayed reply to @${entry.username} (jackpot=${entry.context.isJackpot})`);
                } else {
                    markReplyFailed(entry.id, sendResult.error || 'Send failed');
                    stats.failed++;
                    logger.error(`[pipeline] Delayed reply failed for @${entry.username}: ${sendResult.error}`);
                }

                await delay(AUTO_REPLY_DELAY_MS);
            } catch (e) {
                markReplyFailed(entry.id, formatError(e));
                stats.failed++;
                logger.error(`[pipeline] Delayed reply error for @${entry.username}: ${formatError(e)}`);
            }
        }

        // Periodic cleanup
        cleanupDelayedQueue();

        return stats;
    }

    // ── Check for replies and update feedback loop ──────────────────

    async checkRepliesAndUpdateFeedback(): Promise<number> {
        let page;
        try { page = await this.dm.ensurePage(); } catch (e) {
            logger.error(`[pipeline] Browser page not available — cannot check replies: ${formatError(e)}`);
            return 0;
        }
        let repliesFound = 0;

        // Get all outbound DMs that don't have feedback yet
        const feedbackFile = path.join(process.cwd(), 'logs', 'tracking', 'dm', 'feedback.json');
        let existingFeedback: MessageFeedback[] = [];
        try {
            if (fs.existsSync(feedbackFile)) {
                existingFeedback = JSON.parse(fs.readFileSync(feedbackFile, 'utf8'));
            }
        } catch (e) { logger.warn('[pipeline] Failed to load existing feedback: ' + formatError(e)); }

        const trackedUsers = new Set(existingFeedback.map(f => f.recipientUsername.toLowerCase()));

        // Scrape inbox ONCE, then match against all relationships
        let newMessages: Array<{ from: string; preview: string }> = [];
        try {
            const inboxResult = await checkForNewDMs(this.dm);
            newMessages = inboxResult.newMessages;
        } catch (e) {
            logger.warn('[pipeline] Failed to check inbox for replies: ' + formatError(e));
            return 0;
        }

        const relationshipsDir = path.join(process.cwd(), 'logs', 'tracking', 'dm', 'relationships');
        if (!fs.existsSync(relationshipsDir)) return 0;

        const userFiles = fs.readdirSync(relationshipsDir).filter(f => f.endsWith('.json'));
        for (const file of userFiles) {
            const username = file.replace('.json', '');
            const userDMs = getDMsForUser(username);
            const outbound = userDMs.filter(d => d.direction === 'outbound');

            if (outbound.length === 0) continue;
            if (trackedUsers.has(username)) continue; // Already have feedback

            // Match against the single inbox scrape
            const theirReply = newMessages.find(m => m.from.toLowerCase().includes(username));
            if (theirReply) {
                const sentiment = analyzeSentiment(theirReply.preview);
                const lastOutbound = outbound[outbound.length - 1];
                const hoursSince = (Date.now() - new Date(lastOutbound.timestamp).getTime()) / (1000 * 60 * 60);

                recordFeedback({
                    messageId: lastOutbound.sessionId,
                    recipientUsername: username,
                    messageSentAt: lastOutbound.timestamp,
                    gotReply: true,
                    replyText: theirReply.preview,
                    replySentiment: sentiment,
                    replyWithinHours: Math.round(hoursSince * 10) / 10
                });
                repliesFound++;

                // Notify Telegram about the reply
                await notifyDMReplyReceived('Instagram', username, theirReply.preview, sentiment, hoursSince).catch(() => {});
            }
        }

        logger.info(`[pipeline] Feedback check: ${repliesFound} new replies found`);
        return repliesFound;
    }
}

// ── Simple sentiment analysis ───────────────────────────────────────

function analyzeSentiment(text: string): 'positive' | 'neutral' | 'negative' {
    const lower = text.toLowerCase();

    const positiveWords = ['thanks', 'thank you', 'awesome', 'great', 'love', 'amazing',
        'yes', 'sure', 'absolutely', 'definitely', 'interested', 'cool', 'nice',
        'appreciate', 'sounds good', 'let\'s', 'would love', 'perfect', '😊', '🙏', '❤️', '🔥'];
    const negativeWords = ['no thanks', 'not interested', 'stop', 'don\'t', 'spam',
        'unsubscribe', 'leave me alone', 'block', 'report', 'annoying', 'scam'];

    const posScore = positiveWords.filter(w => lower.includes(w)).length;
    const negScore = negativeWords.filter(w => lower.includes(w)).length;

    if (negScore > 0) return 'negative';
    if (posScore >= 2) return 'positive';
    if (posScore > 0) return 'neutral';
    return 'neutral';
}

// ── Standalone runner for batch outreach ─────────────────────────────

export async function runOutreachPipeline(
    targets: string[],
    config?: Partial<PipelineConfig>
): Promise<void> {
    const dm = new InstagramDM();
    try {
        await dm.initialize();
        const pipeline = new DMPipeline(dm, config);
        const stats = await pipeline.runBatchOutreach(targets);
        console.log('[pipeline] Results:', JSON.stringify(stats));
    } finally {
        await dm.close();
    }
}
