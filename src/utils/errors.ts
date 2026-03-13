/**
 * Error handling utilities — retry logic, safe file I/O, and error classification
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { logger } from './logger';

// ── Error Classification ─────────────────────────────────────────────

export type ErrorCategory = 'transient' | 'rate_limit' | 'blocked' | 'auth' | 'not_found' | 'fatal' | 'unknown';

export function classifyError(error: unknown): ErrorCategory {
    const msg = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();

    if (msg.includes('rate limit') || msg.includes('too many requests') || msg.includes('429')) return 'rate_limit';
    if (msg.includes('action blocked') || msg.includes('temporarily blocked') || msg.includes('challenge_required')) return 'blocked';
    if (msg.includes('login') || msg.includes('unauthorized') || msg.includes('401') || msg.includes('authentication')) return 'auth';
    if (msg.includes('not found') || msg.includes('404') || msg.includes('does not exist')) return 'not_found';
    if (msg.includes('timeout') || msg.includes('ETIMEDOUT') || msg.includes('ECONNRESET') ||
        msg.includes('ECONNREFUSED') || msg.includes('network') || msg.includes('ENOTFOUND') ||
        msg.includes('socket hang up') || msg.includes('EPIPE')) return 'transient';
    if (msg.includes('ENOMEM') || msg.includes('ENOSPC') || msg.includes('fatal')) return 'fatal';

    return 'unknown';
}

export function isRetryable(error: unknown): boolean {
    const category = classifyError(error);
    return category === 'transient' || category === 'rate_limit';
}

// ── Retry with Exponential Backoff ───────────────────────────────────

export interface RetryOptions {
    maxRetries?: number;
    baseDelay?: number;       // ms, default 1000
    maxDelay?: number;        // ms, default 30000
    backoffFactor?: number;   // default 2
    retryOn?: (error: unknown, attempt: number) => boolean;
    onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
    label?: string;           // for logging
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
    const {
        maxRetries = 3,
        baseDelay = 1000,
        maxDelay = 30000,
        backoffFactor = 2,
        retryOn = isRetryable,
        onRetry,
        label = 'operation',
    } = opts;

    let lastError: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;

            if (attempt >= maxRetries || !retryOn(error, attempt)) {
                break;
            }

            // Exponential backoff with jitter
            const exponentialDelay = Math.min(maxDelay, baseDelay * Math.pow(backoffFactor, attempt));
            const jitter = exponentialDelay * 0.1 * Math.random();
            const delayMs = Math.round(exponentialDelay + jitter);

            if (onRetry) {
                onRetry(error, attempt + 1, delayMs);
            } else {
                const errMsg = error instanceof Error ? error.message : String(error);
                logger.warn(`[retry] ${label} failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delayMs}ms: ${errMsg}`);
            }

            await new Promise(r => setTimeout(r, delayMs));
        }
    }

    throw lastError;
}

// ── Safe File I/O (atomic writes, corruption prevention) ─────────────

/**
 * Atomically write a file by writing to a temp file first, then renaming.
 * Prevents corruption from interrupted writes.
 */
export function safeWriteFileSync(filePath: string, data: string): void {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
    try {
        fs.writeFileSync(tmpPath, data, 'utf8');
        fs.renameSync(tmpPath, filePath);
    } catch (error) {
        // Clean up temp file on failure
        try { fs.unlinkSync(tmpPath); } catch { /* ignore cleanup error */ }
        throw error;
    }
}

/**
 * Safely read and parse a JSON file with fallback.
 * Returns the fallback value on any error (missing file, corrupt JSON, etc.)
 * and logs the error for visibility.
 */
export function safeReadJSON<T>(filePath: string, fallback: T, label?: string): T {
    try {
        if (!fs.existsSync(filePath)) return fallback;
        const raw = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(raw) as T;
    } catch (e) {
        const tag = label || path.basename(filePath);
        logger.warn(`[safe-io] Failed to read ${tag}: ${e instanceof Error ? e.message : String(e)}`);
        return fallback;
    }
}

/**
 * Safely write JSON to a file atomically.
 * Returns true on success, false on failure.
 */
export function safeWriteJSON(filePath: string, data: unknown, label?: string): boolean {
    try {
        safeWriteFileSync(filePath, JSON.stringify(data, null, 2));
        return true;
    } catch (e) {
        const tag = label || path.basename(filePath);
        logger.error(`[safe-io] Failed to write ${tag}: ${e instanceof Error ? e.message : String(e)}`);
        return false;
    }
}

// ── Cross-platform temp directory ────────────────────────────────────

/**
 * Get a cross-platform screenshot directory.
 * Uses OS temp dir instead of hardcoded /tmp/.
 */
export function getScreenshotDir(): string {
    const dir = path.join(os.tmpdir(), 'riona-screenshots');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
}

export function screenshotPath(name: string): string {
    return path.join(getScreenshotDir(), name);
}

// ── Error formatting ─────────────────────────────────────────────────

export function formatError(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }
    return String(error);
}

/**
 * Wrap a function to catch and log errors instead of throwing.
 * Useful for non-critical operations like tracing/analytics.
 */
export function swallowWith<T>(label: string, fallback: T): (error: unknown) => T {
    return (error: unknown) => {
        logger.debug(`[${label}] Non-critical error: ${formatError(error)}`);
        return fallback;
    };
}
