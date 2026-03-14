/**
 * Twitter/X DM Pipeline — Autonomous outreach system
 *
 * Wires together: profile scraping → categorization → AI message generation
 * → approval flow → DM sending → tracking → feedback loop
 */

import { TwitterDM } from './Twitter-DM';
import { scrapeTwitterProfile, scrapeOurTwitterProfile } from './Twitter-Profile';
import {
    generateDMMessage, categorizeContact, loadRelationship, saveRelationship,
    updateWarmth, recordFeedback, getFeedbackStats, MessageFeedback
} from './Twitter-DM-AI';
import {
    trackTwitterDM, hasSentTwitterDMTo, createTwitterDMSession, saveTwitterDMSession,
    getTwitterDMsForUser, getTodayTwitterDMCount
} from '../tracking/twitterDMTracker';
import { notifyDMSent, notifyDMApprovalNeeded } from '../utils/telegram';
import { syncTwitterDMToSupabase, syncTwitterProfileToSupabase } from '../db/supabaseTwitterDM';
import { logger } from '../utils/logger';
import { formatError } from '../utils/errors';
import { ProfileInfo, RelationshipInfo, DMMessage, TrackedDM } from '../types/dm';
import * as fs from 'fs';
import * as path from 'path';

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

// ── Offer Catalog ───────────────────────────────────────────────────

export interface Offer {
    id: string;
    name: string;
    description: string;
    targetCategories: RelationshipInfo['category'][];
    targetTags: string[];
    targetNiches: string[];
    minWarmth: number;
    minStage: RelationshipInfo['stage'];
    messageHint: string;
    active: boolean;
    timesOffered: number;
    conversions: number;
}

const OFFERS_FILE = path.join(process.cwd(), 'logs', 'tracking', 'twitter-dm', 'offers.json');

export function loadOffers(): Offer[] {
    try {
        if (fs.existsSync(OFFERS_FILE)) {
            return JSON.parse(fs.readFileSync(OFFERS_FILE, 'utf8'));
        }
    } catch (e) { logger.warn('[twitter-pipeline] Failed to load offers: ' + formatError(e)); }
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
        if (relationship.warmth < offer.minWarmth) continue;

        const stageOrder = ['cold_outreach', 'initial_contact', 'building', 'warm', 'active'];
        if (stageOrder.indexOf(relationship.stage) < stageOrder.indexOf(offer.minStage)) continue;

        if (offer.targetCategories.length > 0 && !offer.targetCategories.includes(relationship.category)) continue;

        if (offer.targetTags.length > 0 && !offer.targetTags.some(t => relationship.tags.includes(t))) {
            const nicheMatch = offer.targetNiches.some(n => bio.includes(n));
            if (!nicheMatch) continue;
        }

        return offer;
    }
    return null;
}

// ── Pipeline Configuration ──────────────────────────────────────────

export interface PipelineConfig {
    autoApprove: boolean;
    maxDMsPerDay: number;
    minDelayBetweenDMs: number;
    cooldownHoursPerUser: number;
    skipIfNoReplyAfterDays: number;
    maxFollowUps: number;
    offerEnabled: boolean;
}

const DEFAULT_CONFIG: PipelineConfig = {
    autoApprove: true,
    maxDMsPerDay: 10,
    minDelayBetweenDMs: 60000,
    cooldownHoursPerUser: 48,
    skipIfNoReplyAfterDays: 7,
    maxFollowUps: 3,
    offerEnabled: true
};

const CONFIG_FILE = path.join(process.cwd(), 'logs', 'tracking', 'twitter-dm', 'pipeline_config.json');
const PENDING_FILE = path.join(process.cwd(), 'logs', 'tracking', 'twitter-dm', 'pending_sends.json');

export function loadConfig(): PipelineConfig {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) };
        }
    } catch (e) { logger.warn('[twitter-pipeline] Failed to load config: ' + formatError(e)); }
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
    } catch (e) { logger.warn('[twitter-pipeline] Failed to load pending sends: ' + formatError(e)); }
    return [];
}

export function savePendingSends(sends: PendingSend[]) {
    const dir = path.dirname(PENDING_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(PENDING_FILE, JSON.stringify(sends, null, 2));
}

// ── The Pipeline ────────────────────────────────────────────────────

export class TwitterDMPipeline {
    private dm: TwitterDM;
    private config: PipelineConfig;
    private ourProfile: ProfileInfo | null = null;

    constructor(dm: TwitterDM, config?: Partial<PipelineConfig>) {
        this.dm = dm;
        this.config = { ...loadConfig(), ...config };
    }

    // ── Process a single target: scrape → categorize → generate → queue/send ──

    async processTarget(username: string): Promise<PendingSend | null> {
        const page = this.dm.getPage()!;

        // Check cooldown
        const recentDM = hasSentTwitterDMTo(username, this.config.cooldownHoursPerUser);
        if (recentDM) {
            logger.info(`[twitter-pipeline] Skipping @${username} — DM sent within ${this.config.cooldownHoursPerUser}h`);
            return null;
        }

        // Check max follow-ups
        const pastDMs = getTwitterDMsForUser(username).filter(d => d.direction === 'outbound');
        if (pastDMs.length >= this.config.maxFollowUps) {
            const theirDMs = getTwitterDMsForUser(username).filter(d => d.direction === 'inbound');
            if (theirDMs.length === 0) {
                logger.info(`[twitter-pipeline] Skipping @${username} — ${pastDMs.length} follow-ups with no reply`);
                return null;
            }
        }

        // Scrape profiles
        if (!this.ourProfile) {
            this.ourProfile = await scrapeOurTwitterProfile(page);
        }
        const theirProfile = await scrapeTwitterProfile(page, username);
        await delay(2000);

        // Sync profile to Supabase (fire-and-forget)
        syncTwitterProfileToSupabase(username, theirProfile).catch(() => {});

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
                logger.info(`[twitter-pipeline] Matched offer "${offer.name}" for @${username}`);
            }
        }

        // Load conversation history
        let conversationHistory: DMMessage[] = [];
        try {
            const messages = await this.dm.scrapeThread(username, 3);
            conversationHistory = messages;
        } catch (e) { logger.warn('[twitter-pipeline] Failed to scrape conversation thread: ' + formatError(e)); }

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
            id: `twitter_send_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
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
            return await this.executeSend(pending);
        } else {
            const sends = loadPendingSends();
            sends.push(pending);
            savePendingSends(sends);
            await notifyDMApprovalNeeded(username, message, pending.id);
            logger.info(`[twitter-pipeline] Queued DM for @${username} — awaiting approval (${pending.id})`);
            return pending;
        }
    }

    // ── Execute an approved send ────────────────────────────────────

    async executeSend(pending: PendingSend): Promise<PendingSend> {
        try {
            logger.info(`[twitter-pipeline] Sending DM to @${pending.recipientUsername}...`);
            const result = await this.dm.sendDM(pending.recipientUsername, pending.message);

            pending.sentAt = new Date().toISOString();

            if (result.success) {
                pending.status = 'sent';
                updateWarmth(pending.recipientUsername, 'message_sent');
                await notifyDMSent(pending.recipientUsername, pending.message, result.verified);

                // Track the DM
                const tracked: TrackedDM = {
                    recipientUsername: pending.recipientUsername,
                    messageText: pending.message,
                    timestamp: pending.sentAt,
                    direction: 'outbound',
                    verified: result.verified,
                    sessionId: pending.id,
                    conversationId: pending.recipientUsername,
                    relationshipCategory: pending.context.relationship.category,
                    approvalStatus: this.config.autoApprove ? 'auto' : 'manual_approved'
                };
                trackTwitterDM(tracked);

                // Sync to Supabase (fire-and-forget)
                syncTwitterDMToSupabase(tracked).catch(() => {});

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
        const session = createTwitterDMSession();
        const stats = { queued: 0, sent: 0, skipped: 0, failed: 0 };

        logger.info(`[twitter-pipeline] Starting batch outreach to ${usernames.length} targets`);

        for (const username of usernames) {
            // Check daily limit
            if (getTodayTwitterDMCount() >= this.config.maxDMsPerDay) {
                logger.info(`[twitter-pipeline] Daily limit reached (${this.config.maxDMsPerDay})`);
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
                logger.error(`[twitter-pipeline] Error processing @${username}:`, e);
            }

            await delay(this.config.minDelayBetweenDMs);
        }

        saveTwitterDMSession(session);
        logger.info(`[twitter-pipeline] Batch complete: ${stats.sent} sent, ${stats.queued} queued, ${stats.skipped} skipped, ${stats.failed} failed`);
        return stats;
    }

    // ── Check for replies and update feedback loop ──────────────────

    async checkRepliesAndUpdateFeedback(): Promise<number> {
        let repliesFound = 0;

        // Get existing feedback
        const feedbackFile = path.join(process.cwd(), 'logs', 'tracking', 'twitter-dm', 'feedback.json');
        let existingFeedback: MessageFeedback[] = [];
        try {
            if (fs.existsSync(feedbackFile)) {
                existingFeedback = JSON.parse(fs.readFileSync(feedbackFile, 'utf8'));
            }
        } catch (e) { logger.warn('[twitter-pipeline] Failed to load existing feedback: ' + formatError(e)); }

        const trackedUsers = new Set(existingFeedback.map(f => f.recipientUsername.toLowerCase()));

        // Check each user we have a relationship with
        const relationshipsDir = path.join(process.cwd(), 'logs', 'tracking', 'twitter-dm', 'relationships');
        if (!fs.existsSync(relationshipsDir)) return 0;

        const userFiles = fs.readdirSync(relationshipsDir).filter(f => f.endsWith('.json'));
        for (const file of userFiles) {
            const username = file.replace('.json', '');
            const userDMs = getTwitterDMsForUser(username);
            const outbound = userDMs.filter(d => d.direction === 'outbound');

            if (outbound.length === 0) continue;
            if (trackedUsers.has(username)) continue;

            // Scrape the conversation to check for replies
            try {
                const messages = await this.dm.scrapeThread(username, 2);
                const theirReplies = messages.filter(m => !m.isOurs);

                if (theirReplies.length > 0) {
                    const latestReply = theirReplies[theirReplies.length - 1];
                    const sentiment = analyzeSentiment(latestReply.text);
                    const lastOutbound = outbound[outbound.length - 1];
                    const hoursSince = (Date.now() - new Date(lastOutbound.timestamp).getTime()) / (1000 * 60 * 60);

                    recordFeedback({
                        messageId: lastOutbound.sessionId,
                        recipientUsername: username,
                        messageSentAt: lastOutbound.timestamp,
                        gotReply: true,
                        replyText: latestReply.text,
                        replySentiment: sentiment,
                        replyWithinHours: Math.round(hoursSince * 10) / 10
                    });
                    repliesFound++;
                }
            } catch (e) { logger.warn(`[twitter-pipeline] Failed to check replies for @${username}: ` + formatError(e)); }
        }

        logger.info(`[twitter-pipeline] Feedback check: ${repliesFound} new replies found`);
        return repliesFound;
    }
}

// ── Simple sentiment analysis ───────────────────────────────────────

export function analyzeSentiment(text: string): 'positive' | 'neutral' | 'negative' {
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

export async function runTwitterOutreachPipeline(
    targets: string[],
    config?: Partial<PipelineConfig>
): Promise<void> {
    const dm = new TwitterDM();
    try {
        await dm.initialize();
        const pipeline = new TwitterDMPipeline(dm, config);
        const stats = await pipeline.runBatchOutreach(targets);
        console.log('[twitter-pipeline] Results:', JSON.stringify(stats));
    } finally {
        await dm.close();
    }
}
