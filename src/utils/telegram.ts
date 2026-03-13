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
    platform: 'Instagram' | 'Threads';
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
    const icon = summary.platform === 'Instagram' ? '📸' : '🧵';
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
    const icon = platform === 'Instagram' ? '📸' : '🧵';
    const msg = `🎯 ${icon} <b>${platform} Daily Target Reached!</b>\n\n` +
        `💬 Total: <b>${total}/${target}</b>\n` +
        `✅ Verified: ${verified}\n` +
        `🕐 Idling until tomorrow`;

    await sendTelegram(msg);
}

export async function notifyError(platform: string, error: string): Promise<void> {
    const icon = platform === 'Instagram' ? '📸' : '🧵';
    const msg = `🚨 ${icon} <b>${platform} Error</b>\n\n${escapeHtml(error.slice(0, 500))}`;
    await sendTelegram(msg);
}

export async function notifyStartup(platform: string, target: number, postsPerRun: number, intervalMin: number): Promise<void> {
    const icon = platform === 'Instagram' ? '📸' : '🧵';
    const msg = `🟢 ${icon} <b>${platform} Scheduler Started</b>\n\n` +
        `🎯 Target: ${target}/day\n` +
        `📝 Posts/run: ${postsPerRun}\n` +
        `⏰ Interval: ${intervalMin}min`;

    await sendTelegram(msg);
}

// ── DM Notifications ─────────────────────────────────────────────────

export async function notifyNewDM(from: string, preview: string): Promise<void> {
    const msg = `📩 <b>New Instagram DM</b>\n\n` +
        `From: <b>@${escapeHtml(from)}</b>\n` +
        `Message: ${escapeHtml(preview.slice(0, 200))}`;
    await sendTelegram(msg);
}

export async function notifyDMSent(to: string, message: string, verified: boolean): Promise<void> {
    const icon = verified ? '✅' : '⚠️';
    const msg = `${icon} <b>DM Sent</b>\n\n` +
        `To: <b>@${escapeHtml(to)}</b>\n` +
        `Message: ${escapeHtml(message.slice(0, 200))}\n` +
        `Verified: ${verified ? 'Yes' : 'No'}`;
    await sendTelegram(msg);
}

export async function notifyDMApprovalNeeded(to: string, proposedMessage: string, approvalId: string): Promise<void> {
    const msg = `🔔 <b>DM Approval Needed</b>\n\n` +
        `To: <b>@${escapeHtml(to)}</b>\n` +
        `Proposed: ${escapeHtml(proposedMessage.slice(0, 200))}\n\n` +
        `ID: <code>${approvalId}</code>`;
    await sendTelegram(msg);
}

function progressBar(pct: number): string {
    const filled = Math.min(Math.round(pct / 5), 20);
    const empty = 20 - filled;
    return '▓'.repeat(filled) + '░'.repeat(empty) + ` ${pct}%`;
}

function escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
