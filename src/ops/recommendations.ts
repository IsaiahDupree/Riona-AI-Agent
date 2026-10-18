/**
 * Recommendation Engine — analyzes system state and produces actionable suggestions
 * Each recommendation includes the exact API endpoint + payload so a bot can act on it.
 */

import { serviceRegistry } from '../services/ServiceRegistry';
import { browserPool } from '../browser/BrowserPool';
import type { ServiceId, ServiceState, ErrorRecord } from '../services/ServiceState';

export type Urgency = 'critical' | 'high' | 'medium' | 'low';

export interface Recommendation {
    id: string;
    action: string;
    reason: string;
    urgency: Urgency;
    endpoint: string;
    method: 'GET' | 'POST' | 'PUT';
    payload?: Record<string, unknown>;
}

export function generateRecommendations(): Recommendation[] {
    const recs: Recommendation[] = [];
    const states = serviceRegistry.getAllStates();
    const browserStatus = browserPool.getStatus();
    const now = new Date();
    const hour = now.getHours();

    for (const svc of states) {
        // 1. Failed services — critical
        if (svc.status === 'failed') {
            const lastErr = svc.lastError;
            if (lastErr?.category === 'auth') {
                recs.push({
                    id: `failed-auth-${svc.id}`,
                    action: `Re-authenticate ${svc.id}`,
                    reason: `Service failed with auth error: ${lastErr.message.slice(0, 120)}. Manual browser login required.`,
                    urgency: 'critical',
                    endpoint: `/api/ops/pause/${svc.id}`,
                    method: 'POST',
                });
            } else if (lastErr?.category === 'blocked') {
                recs.push({
                    id: `failed-blocked-${svc.id}`,
                    action: `Pause ${svc.id} — account may be restricted`,
                    reason: `Platform may have blocked/restricted the account. Wait 24-48h.`,
                    urgency: 'critical',
                    endpoint: `/api/ops/pause/${svc.id}`,
                    method: 'POST',
                });
            } else {
                recs.push({
                    id: `failed-retry-${svc.id}`,
                    action: `Retry ${svc.id}`,
                    reason: `5+ consecutive errors. Last: ${lastErr?.message?.slice(0, 120) || 'unknown'}`,
                    urgency: 'critical',
                    endpoint: `/api/ops/retry/${svc.id}`,
                    method: 'POST',
                });
            }
        }

        // 2. Error state — high
        if (svc.status === 'error') {
            recs.push({
                id: `error-retry-${svc.id}`,
                action: `Retry ${svc.id}`,
                reason: `${svc.counters.errors} errors today, currently in error state. Recovery may succeed.`,
                urgency: 'high',
                endpoint: `/api/ops/retry/${svc.id}`,
                method: 'POST',
            });
        }

        // 3. Stopped during active hours — medium
        if (svc.status === 'stopped' && hour >= svc.config.activeHoursStart && hour < svc.config.activeHoursEnd) {
            recs.push({
                id: `stopped-active-${svc.id}`,
                action: `Resume ${svc.id}`,
                reason: `Service is stopped but current hour (${hour}) is within active hours (${svc.config.activeHoursStart}-${svc.config.activeHoursEnd}).`,
                urgency: 'medium',
                endpoint: `/api/ops/resume/${svc.id}`,
                method: 'POST',
            });
        }

        // 4. Daily target approaching — low
        if (svc.counters.count > 0 && svc.config.dailyTarget > 0) {
            const pct = svc.counters.count / svc.config.dailyTarget;
            if (pct >= 0.9 && pct < 1.0) {
                recs.push({
                    id: `target-near-${svc.id}`,
                    action: `Reduce postsPerRun for ${svc.id}`,
                    reason: `${svc.counters.count}/${svc.config.dailyTarget} daily target (${Math.round(pct * 100)}%). Consider reducing to finish smoothly.`,
                    urgency: 'low',
                    endpoint: `/api/ops/adjust-config/${svc.id}`,
                    method: 'PUT',
                    payload: { postsPerRun: Math.max(3, Math.floor(svc.config.postsPerRun / 2)) },
                });
            }
        }
    }

    // 5. Recurring error patterns — high
    const allErrors = serviceRegistry.getAllErrors(100);
    const recentErrors = allErrors.filter(e => {
        const age = now.getTime() - new Date(e.timestamp).getTime();
        return age < 60 * 60 * 1000; // last hour
    });

    const categoryGroups = new Map<string, Array<{ serviceId: ServiceId } & ErrorRecord>>();
    for (const err of recentErrors) {
        const key = err.category;
        if (!categoryGroups.has(key)) categoryGroups.set(key, []);
        categoryGroups.get(key)!.push(err);
    }

    for (const [category, errors] of categoryGroups) {
        if (errors.length >= 3) {
            const services = [...new Set(errors.map(e => e.serviceId))];
            const isSystemic = services.length >= 2;
            recs.push({
                id: `pattern-${category}`,
                action: isSystemic ? `Emergency pause — systemic ${category} errors` : `Investigate ${category} errors on ${services.join(', ')}`,
                reason: `${errors.length}x ${category} errors in the last hour across ${services.length} service(s). ${isSystemic ? 'This is a systemic issue.' : 'Concentrated on one service.'}`,
                urgency: isSystemic ? 'critical' : 'high',
                endpoint: isSystemic ? '/api/ops/pause-all' : `/api/ops/pause/${services[0]}`,
                method: 'POST',
            });
        }
    }

    // 6. Browser health — medium
    for (const [key, info] of Object.entries(browserStatus)) {
        if (info && info.status === 'busy' && info.uptime > 10 * 60 * 1000) {
            recs.push({
                id: `browser-hung-${key}`,
                action: `Close hung browser: ${key}`,
                reason: `Browser has been busy for ${Math.round(info.uptime / 60000)}min — may be stuck.`,
                urgency: 'medium',
                endpoint: `/api/browsers/${key}/close`,
                method: 'POST',
            });
        }
    }

    // 7. Memory — medium
    const mem = process.memoryUsage();
    if (mem.rss > 1024 * 1024 * 1024) {
        recs.push({
            id: 'memory-high',
            action: 'High memory usage — consider restart',
            reason: `RSS: ${Math.round(mem.rss / 1024 / 1024)}MB. May cause instability.`,
            urgency: 'medium',
            endpoint: '/api/ops/pause-all',
            method: 'POST',
        });
    }

    // Sort by urgency
    const urgencyOrder: Record<Urgency, number> = { critical: 0, high: 1, medium: 2, low: 3 };
    recs.sort((a, b) => urgencyOrder[a.urgency] - urgencyOrder[b.urgency]);

    return recs;
}
