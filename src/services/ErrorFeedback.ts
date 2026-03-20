/**
 * Error Feedback — structured troubleshooting guidance
 * Builds on classifyError() from utils/errors.ts
 */

import { classifyError, type ErrorCategory } from '../utils/errors';
import type { RecoveryAction } from './ServiceState';

export interface ErrorDiagnosis {
    category: ErrorCategory;
    recoveryAction: RecoveryAction;
    troubleshooting: string[];
    autoRecoverable: boolean;
    cooldownMs: number;     // how long to wait before retry
}

const PLATFORM_GUIDANCE: Record<string, Record<ErrorCategory, string[]>> = {
    instagram: {
        transient: ['Network hiccup — auto-retry scheduled', 'Check if proxy is still alive', 'Instagram may be temporarily down'],
        rate_limit: ['Too many actions — backing off 15min', 'Reduce POSTS_PER_RUN', 'Instagram rate-limits typically lift in 15-60min'],
        blocked: ['Account may be action-blocked by Instagram', 'Wait 24-48 hours before resuming', 'Check if CAPTCHA/challenge is required — manual login may be needed', 'Reduce daily targets to avoid future blocks'],
        auth: ['Session expired — browser profile needs re-login', 'Open Chrome with the instagram profile and log in manually', 'Check if password was changed or 2FA required'],
        not_found: ['Page or element not found — Instagram may have updated their UI', 'Try refreshing the page', 'Check if selectors need updating'],
        fatal: ['Out of memory or disk space', 'Restart the service', 'Check system resources with Task Manager'],
        unknown: ['Unexpected error — check logs for details', 'Try restarting the service', 'If persistent, check for Instagram platform changes'],
    },
    twitter: {
        transient: ['Network hiccup — auto-retry scheduled', 'Check internet connection', 'Twitter/X may be experiencing issues'],
        rate_limit: ['Too many actions — backing off 15min', 'Reduce TWITTER_POSTS_PER_RUN', 'X rate-limits are strict — reduce frequency'],
        blocked: ['Account may be restricted by X', 'Check for suspension notices in browser', 'Wait 24-48h before resuming', 'Verify account standing at x.com/settings'],
        auth: ['Session expired — re-login needed', 'Open Chrome with twitter profile and log in', 'Check if PIN prompt is blocking (PIN: 7911)', 'May need to re-verify phone/email'],
        not_found: ['Tweet or element not found', 'Tweet may have been deleted', 'Check if X updated their UI selectors'],
        fatal: ['Out of memory or disk space', 'Restart the service', 'Check system resources'],
        unknown: ['Unexpected error — check logs', 'Try restarting the service', 'If persistent, file an issue'],
    },
    threads: {
        transient: ['Network hiccup — auto-retry scheduled', 'Threads may be temporarily down'],
        rate_limit: ['Too many actions — backing off', 'Reduce THREADS_POSTS_PER_RUN'],
        blocked: ['Account may be action-blocked', 'Wait 24-48h', 'Check for CAPTCHA in browser'],
        auth: ['Session expired — re-login to Threads in browser', 'Uses Instagram credentials'],
        not_found: ['Post or element not found', 'Threads UI may have changed'],
        fatal: ['Out of memory or disk space', 'Restart the service'],
        unknown: ['Unexpected error — check logs', 'Try restarting the service'],
    },
};

const RECOVERY_MAP: Record<ErrorCategory, RecoveryAction> = {
    transient: 'auto_retry',
    rate_limit: 'backoff_and_retry',
    blocked: 'pause_service',
    auth: 'reauth_needed',
    not_found: 'auto_retry',
    fatal: 'manual_intervention',
    unknown: 'auto_retry',
};

const COOLDOWN_MAP: Record<ErrorCategory, number> = {
    transient: 30_000,          // 30s
    rate_limit: 15 * 60_000,    // 15min
    blocked: 24 * 60 * 60_000,  // 24h
    auth: 0,                     // needs manual intervention
    not_found: 60_000,          // 1min
    fatal: 0,                    // needs manual intervention
    unknown: 60_000,            // 1min
};

export function diagnoseError(error: unknown, serviceId: string): ErrorDiagnosis {
    const category = classifyError(error);
    const platform = serviceId.startsWith('instagram') ? 'instagram'
        : serviceId.startsWith('twitter') ? 'twitter'
        : 'threads';

    const platformGuidance = PLATFORM_GUIDANCE[platform]?.[category] || PLATFORM_GUIDANCE.instagram[category];
    const recoveryAction = RECOVERY_MAP[category];
    const cooldownMs = COOLDOWN_MAP[category];
    const autoRecoverable = category === 'transient' || category === 'rate_limit' || category === 'not_found';

    return {
        category,
        recoveryAction,
        troubleshooting: platformGuidance,
        autoRecoverable,
        cooldownMs,
    };
}

export function buildErrorRecord(
    error: unknown,
    serviceId: string,
    context: string,
): import('./ServiceState').ErrorRecord {
    const diagnosis = diagnoseError(error, serviceId);
    const msg = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;

    return {
        id: `err_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        timestamp: new Date().toISOString(),
        category: diagnosis.category,
        message: msg,
        stack,
        context,
        recoveryAction: diagnosis.recoveryAction,
        resolved: false,
        troubleshooting: diagnosis.troubleshooting,
    };
}
