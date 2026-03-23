/**
 * Proactive Check-ins — Schedule and generate re-engagement messages for warm contacts.
 */

import { logger } from '../utils/logger';
import { formatError } from '../utils/errors';
import { CheckInRecord, CheckInType, FriendshipTier } from '../types/nurture';
import { loadNurtureProfile, saveNurtureProfile, getAllNurtureProfiles } from './store';
import { TIER_CONFIGS, getTierForMessage } from './tiers';
import { getBestInterestForMessage } from './interests';
import { canMessageOnPlatform, getCrossContext } from './cross-platform';
import { chatCompletion } from '../utils/ai';
import dotenv from 'dotenv';

dotenv.config({ override: true });

// OpenAI replaced by shared Anthropic wrapper (chatCompletion)

// ── Check-in templates ──────────────────────────────────────────────

const CHECK_IN_PROMPTS: Record<CheckInType, string> = {
    content_reaction: 'React to something they posted or shared recently. Be specific and genuine. {contentRef}',
    work_question: 'Ask a thoughtful question about their work, project, or current focus. Show genuine curiosity.',
    resource_share: 'Share a resource (article, tool, insight) that would be valuable to them based on their interests.',
    celebrate_win: 'Congratulate them on a recent achievement or milestone. Be specific and genuine.',
};

const CHECK_IN_TYPES: CheckInType[] = ['content_reaction', 'work_question', 'resource_share', 'celebrate_win'];

// ── Get contacts due for check-in ───────────────────────────────────

export function getContactsDueForCheckIn(platform: 'twitter' | 'instagram'): Array<{
    username: string;
    tier: FriendshipTier;
    hoursSinceLastContact: number;
}> {
    const profiles = getAllNurtureProfiles(platform);
    const now = Date.now();
    const due: Array<{ username: string; tier: FriendshipTier; hoursSinceLastContact: number }> = [];

    for (const profile of profiles) {
        // Only check-in with contacts beyond acquaintance, or acquaintances with some engagement
        if (profile.tier === 'acquaintance' && profile.depth.exchangeCount < 2) continue;

        // Prefer nextCheckInDue if set (most accurate), fall back to lastCheckIn + frequency
        if (profile.nextCheckInDue) {
            const dueTime = new Date(profile.nextCheckInDue).getTime();
            if (now < dueTime) continue; // Not due yet
            const hoursSince = (now - dueTime) / (1000 * 60 * 60);
            due.push({
                username: profile.username,
                tier: profile.tier,
                hoursSinceLastContact: Math.round(hoursSince),
            });
        } else {
            const config = TIER_CONFIGS[profile.tier];
            const lastContact = profile.lastCheckIn || profile.createdAt;
            const hoursSince = (now - new Date(lastContact).getTime()) / (1000 * 60 * 60);
            if (hoursSince >= config.checkInFrequencyHours) {
                due.push({
                    username: profile.username,
                    tier: profile.tier,
                    hoursSinceLastContact: Math.round(hoursSince),
                });
            }
        }
    }

    // Sort by most overdue first
    due.sort((a, b) => b.hoursSinceLastContact - a.hoursSinceLastContact);

    return due;
}

// ── Select check-in type (rotate, avoid repeats) ────────────────────

export function selectCheckInType(username: string, platform: 'twitter' | 'instagram'): CheckInType {
    const profile = loadNurtureProfile(username, platform);
    const recent = profile.checkIns.slice(-3).map(c => c.type);

    // Pick the first type not used recently
    for (const type of CHECK_IN_TYPES) {
        if (!recent.includes(type)) return type;
    }

    // All used recently — rotate
    return CHECK_IN_TYPES[profile.checkIns.length % CHECK_IN_TYPES.length];
}

// ── Generate check-in message via AI ────────────────────────────────

export async function generateCheckInMessage(
    username: string,
    platform: 'twitter' | 'instagram',
    type: CheckInType,
    contentReference?: string
): Promise<string> {
    const profile = loadNurtureProfile(username, platform);
    const tierHints = getTierForMessage(profile.tier);
    const interestContext = getBestInterestForMessage(username, platform);
    const crossContext = getCrossContext(username, platform);

    const templatePrompt = CHECK_IN_PROMPTS[type]
        .replace('{contentRef}', contentReference ? `Reference: "${contentReference}"` : '');

    const systemPrompt = [
        `You are sending a friendly check-in DM to @${username} on ${platform}.`,
        tierHints.style,
        tierHints.depthHint,
        interestContext ? `Their interests: ${interestContext.context}` : '',
        crossContext || '',
        'Write a natural, genuine message. No hashtags. No sales pitch. Just be a good friend.',
    ].filter(Boolean).join(' ');

    try {
        const message = (await chatCompletion({
            messages: [
                { role: 'system', content: systemPrompt },
                {
                    role: 'user',
                    content: `${templatePrompt}\n\nRules:\n1. Max 300 characters\n2. Sound human, not automated\n3. Reference something specific about them if possible\n4. Match the friendship level (${profile.tier.replace('_', ' ')})\n\nReply with ONLY the message text.`,
                },
            ],
            max_tokens: 100,
            temperature: 0.85,
        }))?.trim()?.replace(/^["']|["']$/g, '') || '';
        logger.info(`[check-ins] Generated ${type} check-in for @${username}: "${message.slice(0, 60)}..."`);
        return message;
    } catch (e) {
        logger.warn(`[check-ins] AI generation failed for @${username}: ${formatError(e)}`);
        return '';
    }
}

// ── Schedule a check-in ─────────────────────────────────────────────

export function scheduleCheckIn(
    username: string,
    platform: 'twitter' | 'instagram',
    type: CheckInType,
    scheduledFor?: string
): CheckInRecord {
    const profile = loadNurtureProfile(username, platform);
    const config = TIER_CONFIGS[profile.tier];

    const record: CheckInRecord = {
        username,
        platform,
        type,
        scheduledFor: scheduledFor || new Date(Date.now() + config.checkInFrequencyHours * 60 * 60 * 1000).toISOString(),
    };

    profile.checkIns.push(record);
    saveNurtureProfile(profile);
    return record;
}

// ── Mark check-in as sent ───────────────────────────────────────────

export function markCheckInSent(
    username: string,
    platform: 'twitter' | 'instagram',
    message: string
): void {
    const profile = loadNurtureProfile(username, platform);
    const now = new Date().toISOString();

    // Find the most recent unsent check-in
    const pending = profile.checkIns.find(c => !c.sentAt);
    if (pending) {
        pending.sentAt = now;
        pending.messageUsed = message;
    }

    profile.lastCheckIn = now;

    // Schedule next check-in
    const config = TIER_CONFIGS[profile.tier];
    profile.nextCheckInDue = new Date(Date.now() + config.checkInFrequencyHours * 60 * 60 * 1000).toISOString();

    saveNurtureProfile(profile);
}

// ── Get pending check-in queue ──────────────────────────────────────

export function getCheckInQueue(platform: 'twitter' | 'instagram'): CheckInRecord[] {
    const profiles = getAllNurtureProfiles(platform);
    const queue: CheckInRecord[] = [];

    for (const profile of profiles) {
        const pending = profile.checkIns.filter(c => !c.sentAt && c.scheduledFor <= new Date().toISOString());
        queue.push(...pending);
    }

    return queue.sort((a, b) => a.scheduledFor.localeCompare(b.scheduledFor));
}

// ── Process due check-ins (main entry point for scheduler) ──────────

export async function processDueCheckIns(
    platform: 'twitter' | 'instagram',
    sendFn: (username: string, message: string) => Promise<boolean>,
    maxCheckIns: number = 3
): Promise<number> {
    const due = getContactsDueForCheckIn(platform);

    if (due.length === 0) {
        logger.info(`[check-ins] No ${platform} check-ins due`);
        return 0;
    }

    logger.info(`[check-ins] ${due.length} ${platform} contacts due for check-in, processing up to ${maxCheckIns}`);
    let sent = 0;

    for (const contact of due.slice(0, maxCheckIns)) {
        // Cross-platform guard
        const guard = await canMessageOnPlatform(contact.username, platform);
        if (!guard.allowed) {
            logger.info(`[check-ins] Skipping @${contact.username}: ${guard.reason}`);
            continue;
        }

        const type = selectCheckInType(contact.username, platform);
        const message = await generateCheckInMessage(contact.username, platform, type);

        if (!message) continue;

        // Schedule and attempt send
        scheduleCheckIn(contact.username, platform, type);

        const success = await sendFn(contact.username, message);
        if (success) {
            markCheckInSent(contact.username, platform, message);
            sent++;
            logger.info(`[check-ins] Sent ${type} check-in to @${contact.username} (${contact.tier})`);
        }
    }

    logger.info(`[check-ins] Sent ${sent}/${due.length} check-ins on ${platform}`);
    return sent;
}
