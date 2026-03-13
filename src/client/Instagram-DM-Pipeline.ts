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
    recordFeedback, getFeedbackStats, MessageFeedback
} from './Instagram-DM-AI';
import { scrapeConversationThread, checkForNewDMs, StoredConversation } from './Instagram-DM-Watcher';
import { trackDM, hasSentDMTo, createDMSession, saveDMSession, getDMsForUser } from '../tracking/dmTracker';
import { notifyDMSent, notifyDMApprovalNeeded } from '../utils/telegram';
import { logger } from '../utils/logger';
import { formatError } from '../utils/errors';
import { ProfileInfo, RelationshipInfo, DMMessage, DMSendResult, TrackedDM } from '../types/dm';
import * as fs from 'fs';
import * as path from 'path';

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

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
    relationship: RelationshipInfo
): Offer | null {
    const offers = loadOffers().filter(o => o.active);
    const bio = (theirProfile.bio || '').toLowerCase();

    for (const offer of offers) {
        // Check warmth threshold
        if (relationship.warmth < offer.minWarmth) continue;

        // Check stage threshold
        const stageOrder = ['cold_outreach', 'initial_contact', 'building', 'warm', 'active'];
        if (stageOrder.indexOf(relationship.stage) < stageOrder.indexOf(offer.minStage)) continue;

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
        const page = this.dm.getPage()!;

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
            const offer = matchOffer(theirProfile, relationship);
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
            const today = getDMsForUser(username); // TODO: get total today count
            if (stats.sent >= this.config.maxDMsPerDay) {
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

    // ── Check for replies and update feedback loop ──────────────────

    async checkRepliesAndUpdateFeedback(): Promise<number> {
        const page = this.dm.getPage()!;
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

        // Check each conversation we've sent DMs to
        const allDMs = getDMsForUser('').length > 0 ? [] : []; // We need all users
        const relationshipsDir = path.join(process.cwd(), 'logs', 'tracking', 'dm', 'relationships');
        if (!fs.existsSync(relationshipsDir)) return 0;

        const userFiles = fs.readdirSync(relationshipsDir).filter(f => f.endsWith('.json'));
        for (const file of userFiles) {
            const username = file.replace('.json', '');
            const userDMs = getDMsForUser(username);
            const outbound = userDMs.filter(d => d.direction === 'outbound');

            if (outbound.length === 0) continue;
            if (trackedUsers.has(username)) continue; // Already have feedback

            // Check for new messages from this user via inbox
            try {
                const { newMessages } = await checkForNewDMs(this.dm);
                const theirReply = newMessages.find(m => m.from.toLowerCase().includes(username));
                if (theirReply) {
                    // Analyze sentiment
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
                }
            } catch (e) { logger.warn('[pipeline] Failed to check replies for user: ' + formatError(e)); }
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
