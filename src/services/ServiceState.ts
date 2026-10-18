/**
 * Service State Types — state machine, error records, run history
 */

export type ServiceId = 'instagram-feed' | 'instagram-dm' | 'threads' | 'twitter-feed' | 'twitter-dm';

export type ServiceStatus = 'idle' | 'starting' | 'running' | 'cooling_down' | 'error' | 'recovering' | 'failed' | 'stopped';

export type RunTrigger = 'scheduled' | 'manual' | 'recovery' | 'startup';

export type RunResult = 'success' | 'partial' | 'error';

export type RecoveryAction = 'auto_retry' | 'backoff_and_retry' | 'restart_browser' | 'pause_service' | 'reauth_needed' | 'manual_intervention' | 'none';

export interface ErrorRecord {
    id: string;
    timestamp: string;
    category: string;       // from classifyError()
    message: string;
    stack?: string;
    context: string;        // which operation was running
    recoveryAction: RecoveryAction;
    resolved: boolean;
    troubleshooting: string[];
}

export interface RunRecord {
    id: string;
    startedAt: string;
    completedAt: string;
    duration: number;       // ms
    trigger: RunTrigger;
    result: RunResult;
    metrics: {
        posted: number;
        skipped: number;
        errors: number;
        verified?: number;
        duplicatesSkipped?: number;
    };
    errorSummary?: string;
}

export interface ServiceConfig {
    intervalMinutes: number;
    dailyTarget: number;
    activeHoursStart: number;
    activeHoursEnd: number;
    postsPerRun: number;
    browserProfile: string;
}

export interface ServiceState {
    id: ServiceId;
    status: ServiceStatus;
    browserProfile: string;
    lastRunAt: string | null;
    lastRunResult: RunResult | null;
    lastError: ErrorRecord | null;
    errorHistory: ErrorRecord[];      // last 50
    runHistory: RunRecord[];          // last 100
    counters: {
        date: string;
        count: number;
        verified: number;
        runs: number;
        errors: number;
    };
    config: ServiceConfig;
    schedulerEnabled: boolean;
    nextScheduledRun: string | null;
    startedAt: string | null;
    pid: number;
}

export const SERVICE_PROFILES: Record<ServiceId, string> = {
    'instagram-feed': 'chrome-profile',
    'instagram-dm': 'chrome-profile-instagram-dm',
    'threads': 'chrome-profile-threads',
    'twitter-feed': 'chrome-profile-twitter',
    'twitter-dm': 'chrome-profile-twitter-dm',
};

export const SERVICE_DISPLAY_NAMES: Record<ServiceId, string> = {
    'instagram-feed': 'Instagram Comments',
    'instagram-dm': 'Instagram DMs',
    'threads': 'Threads Comments',
    'twitter-feed': 'Twitter Replies',
    'twitter-dm': 'Twitter DMs',
};
