/**
 * ServiceOrchestrator — state machine for a single service
 * Manages lifecycle, scheduling, error tracking, and recovery
 */

import { logger } from '../utils/logger';
import { formatError } from '../utils/errors';
import { eventBus, EVENTS } from './EventBus';
import { diagnoseError, buildErrorRecord } from './ErrorFeedback';
import type {
    ServiceId, ServiceStatus, ServiceState, ServiceConfig,
    RunRecord, ErrorRecord, RunTrigger, RunResult,
} from './ServiceState';
import { SERVICE_DISPLAY_NAMES } from './ServiceState';

export type RunFunction = (trigger: RunTrigger) => Promise<{
    posted: number;
    skipped: number;
    errors: number;
    verified?: number;
    duplicatesSkipped?: number;
    result: RunResult;
    errorSummary?: string;
}>;

export class ServiceOrchestrator {
    readonly id: ServiceId;
    private status: ServiceStatus = 'stopped';
    private config: ServiceConfig;
    private runFn: RunFunction | null = null;
    private timer: ReturnType<typeof setInterval> | null = null;
    private errorHistory: ErrorRecord[] = [];
    private runHistory: RunRecord[] = [];
    private lastError: ErrorRecord | null = null;
    private counters = { date: '', count: 0, verified: 0, runs: 0, errors: 0 };
    private schedulerEnabled = false;
    private nextScheduledRun: Date | null = null;
    private startedAt: Date | null = null;
    private consecutiveErrors = 0;
    private cooldownUntil: number = 0;
    private isRunning = false;

    constructor(id: ServiceId, config: ServiceConfig) {
        this.id = id;
        this.config = config;
        this.resetCountersIfNewDay();
    }

    /**
     * Register the function that performs a single run
     */
    setRunFunction(fn: RunFunction): void {
        this.runFn = fn;
    }

    /**
     * Start the scheduler — begins periodic runs
     */
    start(): void {
        if (this.status === 'running' || this.schedulerEnabled) {
            logger.warn(`[${this.id}] Already running`);
            return;
        }

        this.schedulerEnabled = true;
        this.startedAt = new Date();
        this.setStatus('idle');
        this.consecutiveErrors = 0;

        const intervalMs = this.config.intervalMinutes * 60 * 1000;
        this.scheduleNext(5000); // first run after 5s

        this.timer = setInterval(() => {
            this.tryRun('scheduled');
        }, intervalMs);

        logger.info(`[${this.id}] Scheduler started (every ${this.config.intervalMinutes}min)`);
        eventBus.emit(EVENTS.SERVICE_STATE_CHANGE, {
            serviceId: this.id,
            oldState: 'stopped',
            newState: 'idle',
        });
    }

    /**
     * Stop the scheduler — gracefully stops periodic runs
     */
    stop(): void {
        this.schedulerEnabled = false;
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        this.nextScheduledRun = null;
        this.setStatus('stopped');
        logger.info(`[${this.id}] Scheduler stopped`);
    }

    /**
     * Trigger an immediate run (from API)
     */
    async triggerRun(): Promise<RunRecord | null> {
        return this.tryRun('manual');
    }

    /**
     * Attempt error recovery
     */
    async recover(): Promise<{ success: boolean; message: string }> {
        if (this.status !== 'error' && this.status !== 'failed') {
            return { success: false, message: `Service is ${this.status}, not in error state` };
        }

        this.setStatus('recovering');
        this.consecutiveErrors = 0;
        this.cooldownUntil = 0;

        // Mark last error as resolved
        if (this.lastError) {
            this.lastError.resolved = true;
        }

        try {
            const result = await this.tryRun('recovery');
            if (result && result.result !== 'error') {
                this.setStatus('idle');
                return { success: true, message: 'Recovery successful — service resumed' };
            }
            this.setStatus('error');
            return { success: false, message: 'Recovery run failed — check error history' };
        } catch (e) {
            this.setStatus('failed');
            return { success: false, message: `Recovery failed: ${formatError(e)}` };
        }
    }

    /**
     * Update service config (live, no restart needed)
     */
    updateConfig(partial: Partial<ServiceConfig>): void {
        Object.assign(this.config, partial);

        // Restart interval if it changed
        if (partial.intervalMinutes && this.timer) {
            clearInterval(this.timer);
            const intervalMs = this.config.intervalMinutes * 60 * 1000;
            this.timer = setInterval(() => this.tryRun('scheduled'), intervalMs);
        }

        logger.info(`[${this.id}] Config updated: ${JSON.stringify(partial)}`);
    }

    /**
     * Get full service state for API
     */
    getState(): ServiceState {
        this.resetCountersIfNewDay();
        return {
            id: this.id,
            status: this.status,
            browserProfile: this.config.browserProfile,
            lastRunAt: this.runHistory.length > 0 ? this.runHistory[this.runHistory.length - 1].completedAt : null,
            lastRunResult: this.runHistory.length > 0 ? this.runHistory[this.runHistory.length - 1].result : null,
            lastError: this.lastError,
            errorHistory: [...this.errorHistory],
            runHistory: [...this.runHistory],
            counters: { ...this.counters },
            config: { ...this.config },
            schedulerEnabled: this.schedulerEnabled,
            nextScheduledRun: this.nextScheduledRun?.toISOString() || null,
            startedAt: this.startedAt?.toISOString() || null,
            pid: process.pid,
        };
    }

    /**
     * Clear all errors and reset error state
     */
    clearErrors(): void {
        for (const err of this.errorHistory) { err.resolved = true; }
        this.lastError = null;
        this.consecutiveErrors = 0;
        this.cooldownUntil = 0;
        if (this.status === 'error' || this.status === 'cooling_down') {
            this.setStatus('idle');
        }
    }

    /**
     * Get error history
     */
    getErrors(limit: number = 50): ErrorRecord[] {
        return this.errorHistory.slice(-limit);
    }

    /**
     * Get run history
     */
    getRuns(limit: number = 100): RunRecord[] {
        return this.runHistory.slice(-limit);
    }

    // ── Internal ──────────────────────────────────────────────────────

    private async tryRun(trigger: RunTrigger): Promise<RunRecord | null> {
        if (this.isRunning) {
            logger.debug(`[${this.id}] Previous run still active, skipping`);
            return null;
        }

        if (!this.runFn) {
            logger.warn(`[${this.id}] No run function registered`);
            return null;
        }

        // Check cooldown
        if (Date.now() < this.cooldownUntil) {
            const remaining = Math.round((this.cooldownUntil - Date.now()) / 1000);
            logger.debug(`[${this.id}] In cooldown (${remaining}s remaining)`);
            return null;
        }

        // Check active hours (for scheduled runs only)
        if (trigger === 'scheduled') {
            const hour = new Date().getHours();
            if (hour < this.config.activeHoursStart || hour >= this.config.activeHoursEnd) {
                return null;
            }
        }

        // Check daily target
        this.resetCountersIfNewDay();
        if (trigger === 'scheduled' && this.counters.count >= this.config.dailyTarget) {
            logger.debug(`[${this.id}] Daily target reached (${this.counters.count}/${this.config.dailyTarget})`);
            return null;
        }

        this.isRunning = true;
        this.setStatus('running');

        const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const startedAt = new Date();

        eventBus.emit(EVENTS.SERVICE_RUN_START, {
            serviceId: this.id,
            runId,
            trigger,
        });

        try {
            const result = await this.runFn(trigger);

            const completedAt = new Date();
            const runRecord: RunRecord = {
                id: runId,
                startedAt: startedAt.toISOString(),
                completedAt: completedAt.toISOString(),
                duration: completedAt.getTime() - startedAt.getTime(),
                trigger,
                result: result.result,
                metrics: {
                    posted: result.posted,
                    skipped: result.skipped,
                    errors: result.errors,
                    verified: result.verified,
                    duplicatesSkipped: result.duplicatesSkipped,
                },
                errorSummary: result.errorSummary,
            };

            this.addRunRecord(runRecord);
            this.counters.count += result.posted;
            this.counters.verified += (result.verified || 0);
            this.counters.runs++;
            this.counters.errors += result.errors;

            if (result.result === 'error') {
                this.consecutiveErrors++;
                this.handleConsecutiveErrors();
            } else {
                this.consecutiveErrors = 0;
                this.setStatus('idle');
            }

            eventBus.emit(EVENTS.SERVICE_RUN_COMPLETE, {
                serviceId: this.id,
                runId,
                result: result.result,
                metrics: runRecord.metrics,
                duration: runRecord.duration,
            });

            return runRecord;
        } catch (error) {
            const errRecord = buildErrorRecord(error, this.id, `run:${trigger}`);
            this.addErrorRecord(errRecord);
            this.consecutiveErrors++;
            this.handleConsecutiveErrors();

            const diagnosis = diagnoseError(error, this.id);
            if (diagnosis.cooldownMs > 0) {
                this.cooldownUntil = Date.now() + diagnosis.cooldownMs;
                logger.warn(`[${this.id}] Cooldown ${diagnosis.cooldownMs / 1000}s after ${diagnosis.category} error`);
            }

            eventBus.emit(EVENTS.SERVICE_ERROR, {
                serviceId: this.id,
                error: errRecord,
            });

            logger.error(`[${this.id}] Run failed: ${formatError(error)}`);
            return null;
        } finally {
            this.isRunning = false;
            this.scheduleNext();
        }
    }

    private handleConsecutiveErrors(): void {
        if (this.consecutiveErrors >= 5) {
            this.setStatus('failed');
            logger.error(`[${this.id}] 5 consecutive errors — service marked as FAILED. Manual recovery needed.`);
        } else if (this.consecutiveErrors >= 3) {
            this.setStatus('error');
            logger.warn(`[${this.id}] ${this.consecutiveErrors} consecutive errors — service in ERROR state`);
        } else {
            this.setStatus('cooling_down');
        }
    }

    private setStatus(newStatus: ServiceStatus): void {
        const oldStatus = this.status;
        if (oldStatus === newStatus) return;
        this.status = newStatus;

        if (oldStatus !== newStatus) {
            eventBus.emit(EVENTS.SERVICE_STATE_CHANGE, {
                serviceId: this.id,
                oldState: oldStatus,
                newState: newStatus,
                displayName: SERVICE_DISPLAY_NAMES[this.id],
            });
        }
    }

    private addErrorRecord(record: ErrorRecord): void {
        this.lastError = record;
        this.errorHistory.push(record);
        if (this.errorHistory.length > 50) {
            this.errorHistory = this.errorHistory.slice(-50);
        }
    }

    private addRunRecord(record: RunRecord): void {
        this.runHistory.push(record);
        if (this.runHistory.length > 100) {
            this.runHistory = this.runHistory.slice(-100);
        }
    }

    private scheduleNext(delayMs?: number): void {
        if (!this.schedulerEnabled) return;
        const next = delayMs || this.config.intervalMinutes * 60 * 1000;
        this.nextScheduledRun = new Date(Date.now() + next);
    }

    private resetCountersIfNewDay(): void {
        const today = new Date().toISOString().slice(0, 10);
        if (this.counters.date !== today) {
            this.counters = { date: today, count: 0, verified: 0, runs: 0, errors: 0 };
        }
    }
}
