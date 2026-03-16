/**
 * Telegram notification utility for Riona schedulers
 * Sends session summaries and alerts to the admin via Telegram bot
 */

import { logger } from './logger';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const MAX_RETRIES = 2;

async function sendTelegram(text: string, parseMode: string = 'HTML'): Promise<boolean> {
    if (!BOT_TOKEN || !CHAT_ID) return false;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
            const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: CHAT_ID,
                    text,
                    parse_mode: parseMode,
                    disable_web_page_preview: true
                }),
                signal: AbortSignal.timeout(10000) // 10s timeout
            });

            if (!res.ok) {
                const err = await res.text();
                // Don't retry on client errors (4xx)
                if (res.status >= 400 && res.status < 500) {
                    logger.warn(`[telegram] Send failed (${res.status}): ${err}`);
                    return false;
                }
                // Server errors (5xx) — retry
                if (attempt < MAX_RETRIES) {
                    logger.warn(`[telegram] Server error ${res.status}, retrying (${attempt + 1}/${MAX_RETRIES})...`);
                    await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
                    continue;
                }
                logger.warn(`[telegram] Send failed after retries: ${res.status} ${err}`);
                return false;
            }
            return true;
        } catch (e) {
            if (attempt < MAX_RETRIES) {
                logger.warn(`[telegram] Error (attempt ${attempt + 1}/${MAX_RETRIES + 1}): ${e}`);
                await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
                continue;
            }
            logger.warn(`[telegram] Failed after ${MAX_RETRIES + 1} attempts: ${e}`);
            return false;
        }
    }
    return false;
}

export interface RunSummary {
    platform: 'Instagram' | 'Threads' | 'Twitter';
    runNumber: number;
    commentsPosted: number;
    commentsVerified: number;
    commentsFailed: number;
    duplicatesSkipped: number;
    likesPosted: number;
    durationSec: number;
    todayTotal: number;
    todayVerified: number;
    dailyTarget: number;
    errors: string[];
}

export async function notifyRunComplete(summary: RunSummary): Promise<void> {
    const pct = Math.round((summary.todayTotal / summary.dailyTarget) * 100);
    const icon = summary.platform === 'Instagram' ? '📸' : summary.platform === 'Twitter' ? '🐦' : '🧵';
    const bar = progressBar(pct);

    let msg = `${icon} <b>${summary.platform} Run #${summary.runNumber}</b>\n`;
    msg += `━━━━━━━━━━━━━━━━━━\n`;
    msg += `💬 Comments: <b>${summary.commentsPosted}</b> (${summary.commentsVerified} verified)\n`;
    msg += `❤️ Likes: ${summary.likesPosted}\n`;
    if (summary.commentsFailed > 0) msg += `⚠️ Failed: ${summary.commentsFailed}\n`;
    if (summary.duplicatesSkipped > 0) msg += `🔄 Dupes skipped: ${summary.duplicatesSkipped}\n`;
    msg += `⏱ Duration: ${summary.durationSec}s\n`;
    msg += `━━━━━━━━━━━━━━━━━━\n`;
    msg += `📊 Today: <b>${summary.todayTotal}/${summary.dailyTarget}</b> (${pct}%)\n`;
    msg += `${bar}\n`;
    msg += `✅ Verified: ${summary.todayVerified}`;

    if (summary.errors.length > 0 && summary.errors.length <= 3) {
        msg += `\n\n⚠️ Errors:\n`;
        for (const err of summary.errors.slice(0, 3)) {
            msg += `• ${escapeHtml(err.slice(0, 100))}\n`;
        }
    }

    await sendTelegram(msg);
}

export async function notifyDailyTargetReached(platform: string, total: number, target: number, verified: number): Promise<void> {
    const icon = platformIcon(platform);
    const msg = `🎯 ${icon} <b>${platform} Daily Target Reached!</b>\n\n` +
        `💬 Total: <b>${total}/${target}</b>\n` +
        `✅ Verified: ${verified}\n` +
        `🕐 Idling until tomorrow`;

    await sendTelegram(msg);
}

export async function notifyError(platform: string, error: string): Promise<void> {
    const icon = platformIcon(platform);
    const msg = `🚨 ${icon} <b>${platform} Error</b>\n\n${escapeHtml(error.slice(0, 500))}`;
    await sendTelegram(msg);
}

export async function notifyStartup(platform: string, target: number, postsPerRun: number, intervalMin: number): Promise<void> {
    const icon = platformIcon(platform);
    const msg = `🟢 ${icon} <b>${platform} Scheduler Started</b>\n\n` +
        `🎯 Target: ${target}/day\n` +
        `📝 Posts/run: ${postsPerRun}\n` +
        `⏰ Interval: ${intervalMin}min`;

    await sendTelegram(msg);
}

// ── DM Notifications ─────────────────────────────────────────────────

export async function notifyNewDM(from: string, preview: string, platform: string = 'Instagram'): Promise<void> {
    const icon = platformIcon(platform);
    const msg = `📩 ${icon} <b>New ${platform} DM</b>\n\n` +
        `From: <b>@${escapeHtml(from)}</b>\n` +
        `Message: ${escapeHtml(preview.slice(0, 200))}`;
    await sendTelegram(msg);
}

export async function notifyDMSent(to: string, message: string, verified: boolean, platform: string = 'Instagram'): Promise<void> {
    const statusIcon = verified ? '✅' : '⚠️';
    const icon = platformIcon(platform);
    const msg = `${statusIcon} ${icon} <b>${platform} DM Sent</b>\n\n` +
        `To: <b>@${escapeHtml(to)}</b>\n` +
        `Message: ${escapeHtml(message.slice(0, 200))}\n` +
        `Verified: ${verified ? 'Yes' : 'No'}`;
    await sendTelegram(msg);
}

export async function notifyDMApprovalNeeded(to: string, proposedMessage: string, approvalId: string, platform: string = 'Instagram'): Promise<void> {
    const icon = platformIcon(platform);
    const msg = `🔔 ${icon} <b>${platform} DM Approval Needed</b>\n\n` +
        `To: <b>@${escapeHtml(to)}</b>\n` +
        `Proposed: ${escapeHtml(proposedMessage.slice(0, 200))}\n\n` +
        `ID: <code>${approvalId}</code>`;
    await sendTelegram(msg);
}

export async function notifyDMAutoReply(platform: string, from: string, theirMessage: string, ourReply: string, delayMinutes?: number): Promise<void> {
    const icon = platformIcon(platform);
    let msg = `💬 ${icon} <b>${platform} Auto-Reply</b>\n\n`;
    msg += `👤 <b>@${escapeHtml(from)}</b> said:\n`;
    msg += `<i>${escapeHtml(theirMessage.slice(0, 200))}</i>\n\n`;
    msg += `🤖 Our reply:\n`;
    msg += `${escapeHtml(ourReply.slice(0, 200))}`;
    if (delayMinutes) msg += `\n\n⏱ Scheduled after ${delayMinutes}m delay`;
    await sendTelegram(msg);
}

export async function notifyDMReplyReceived(platform: string, from: string, theirReply: string, sentiment: string, hoursSince?: number): Promise<void> {
    const icon = platformIcon(platform);
    const sentimentIcon = sentiment === 'positive' ? '😊' : sentiment === 'negative' ? '😟' : '😐';
    let msg = `📨 ${icon} <b>${platform} Reply Received</b>\n\n`;
    msg += `👤 <b>@${escapeHtml(from)}</b> replied:\n`;
    msg += `<i>${escapeHtml(theirReply.slice(0, 200))}</i>\n\n`;
    msg += `${sentimentIcon} Sentiment: ${sentiment}`;
    if (hoursSince) msg += `\n⏱ ${Math.round(hoursSince)}h after our message`;
    await sendTelegram(msg);
}

// ── Strategic Content Notifications ──────────────────────────────────

export async function notifyContentPosted(platform: string, contentType: string, style: string, text: string, tweetUrl?: string): Promise<void> {
    const icon = platformIcon(platform);
    let msg = `📝 ${icon} <b>${platform} Content Posted</b>\n\n`;
    msg += `Type: ${contentType}/${style}\n`;
    msg += `Text: ${escapeHtml(text.slice(0, 250))}`;
    if (tweetUrl) msg += `\n🔗 ${escapeHtml(tweetUrl)}`;
    await sendTelegram(msg);
}

export async function notifyNurtureActivity(platform: string, commentsPosted: number, contactsVisited: number, details?: string): Promise<void> {
    if (commentsPosted === 0) return;
    const icon = platformIcon(platform);
    let msg = `🌱 ${icon} <b>${platform} Nurture Activity</b>\n\n`;
    msg += `💬 Comments: ${commentsPosted}\n`;
    msg += `👥 Contacts visited: ${contactsVisited}`;
    if (details) msg += `\n${escapeHtml(details.slice(0, 200))}`;
    await sendTelegram(msg);
}

export async function notifyContentAnalysis(platform: string, learningsCount: number, topTweet?: string, topEngagement?: string): Promise<void> {
    if (learningsCount === 0) return;
    const icon = platformIcon(platform);
    let msg = `📊 ${icon} <b>${platform} Content Analysis</b>\n\n`;
    msg += `📈 ${learningsCount} learning(s) generated\n`;
    if (topTweet) msg += `\n🏆 Top: "${escapeHtml(topTweet.slice(0, 150))}"\n${topEngagement || ''}`;
    await sendTelegram(msg);
}

export async function notifyEngagementCheckBacks(platform: string, processed: number, avgLikes: number, avgRetweets: number): Promise<void> {
    if (processed === 0) return;
    const icon = platformIcon(platform);
    const msg = `🔄 ${icon} <b>${platform} Engagement Check</b>\n\n` +
        `Checked: ${processed} tweet(s)\n` +
        `Avg: ${avgLikes} likes, ${avgRetweets} RTs`;
    await sendTelegram(msg);
}

function platformIcon(platform: string): string {
    const lower = platform.toLowerCase();
    if (lower.includes('instagram')) return '📸';
    if (lower.includes('twitter')) return '🐦';
    if (lower.includes('threads')) return '🧵';
    return '📱';
}

function progressBar(pct: number): string {
    const filled = Math.min(Math.round(pct / 5), 20);
    const empty = 20 - filled;
    return '▓'.repeat(filled) + '░'.repeat(empty) + ` ${pct}%`;
}

function escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
