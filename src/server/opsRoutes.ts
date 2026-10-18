/**
 * Ops Routes — operational visibility, error diagnosis, corrective actions, decision support
 *
 * GET  /api/ops/snapshot          — complete operational picture (one call)
 * GET  /api/ops/errors            — enhanced error diagnosis with pattern detection
 * GET  /api/ops/errors/:serviceId — per-service error detail
 * GET  /api/ops/recommendations   — AI-friendly suggested actions
 * POST /api/ops/retry/:serviceId  — retry a failed/errored service
 * POST /api/ops/pause/:serviceId  — pause a service
 * POST /api/ops/resume/:serviceId — resume a service
 * POST /api/ops/pause-all         — emergency pause
 * POST /api/ops/resume-all        — resume all
 * POST /api/ops/submit-dm         — queue a DM for sending
 * PUT  /api/ops/adjust-config/:serviceId — live config update
 * POST /api/ops/clear-errors/:serviceId  — acknowledge/clear errors
 */

import { Router, Request, Response, NextFunction } from 'express';
import { serviceRegistry } from '../services/ServiceRegistry';
import { browserPool } from '../browser/BrowserPool';
import { eventBus } from '../services/EventBus';
import { generateRecommendations } from '../ops/recommendations';
import type { ServiceId, ErrorRecord } from '../services/ServiceState';

export const opsRouter = Router();

const asyncHandler = (fn: (req: Request, res: Response) => Promise<void>) =>
    (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };

const VALID_IDS: ServiceId[] = ['instagram-feed', 'instagram-dm', 'threads', 'twitter-feed', 'twitter-dm'];

function validateId(req: Request, res: Response): ServiceId | null {
    const id = req.params.serviceId as ServiceId;
    if (!VALID_IDS.includes(id)) {
        res.status(400).json({ error: `Invalid service ID. Valid: ${VALID_IDS.join(', ')}` });
        return null;
    }
    return id;
}

// ── Snapshot — complete operational picture ─────────────────────────

opsRouter.get('/snapshot', asyncHandler(async (_req, res) => {
    const states = serviceRegistry.getAllStates();
    const health = serviceRegistry.getHealthSummary();
    const browsers = browserPool.getStatus();
    const events = eventBus.getRecentEvents(30);
    const mem = process.memoryUsage();

    // Compute health score: start at 100, deduct for issues
    let healthScore = 100;
    for (const s of states) {
        if (s.status === 'failed') healthScore -= 20;
        else if (s.status === 'error') healthScore -= 10;
        else if (s.status === 'stopped' && s.schedulerEnabled) healthScore -= 5;
    }
    for (const [, info] of Object.entries(browsers)) {
        if (info && info.queueLength > 3) healthScore -= 5;
    }
    if (mem.rss > 1024 * 1024 * 1024) healthScore -= 10;
    healthScore = Math.max(0, healthScore);

    // Aggregate counters by platform
    const counters: Record<string, Record<string, number>> = {
        instagram: { comments: 0, dms: 0 },
        twitter: { replies: 0, dms: 0 },
        threads: { comments: 0 },
    };
    for (const s of states) {
        if (s.id === 'instagram-feed') counters.instagram.comments = s.counters.count;
        if (s.id === 'instagram-dm') counters.instagram.dms = s.counters.count;
        if (s.id === 'twitter-feed') counters.twitter.replies = s.counters.count;
        if (s.id === 'twitter-dm') counters.twitter.dms = s.counters.count;
        if (s.id === 'threads') counters.threads.comments = s.counters.count;
    }

    // Queue depths (best-effort — imports may fail if modules aren't loaded)
    const queues = { igPendingSends: 0, twPendingSends: 0, igDelayedReplies: 0, twDelayedReplies: 0 };
    try {
        const { loadPendingSends } = await import('../client/Instagram-DM-Pipeline');
        const sends = loadPendingSends();
        queues.igPendingSends = sends.filter((s: any) => s.status === 'approved').length;
    } catch { /* module not loaded */ }
    try {
        const { loadConfig } = await import('../client/Twitter-DM-Pipeline');
        // Twitter pipeline pending sends are tracked differently
    } catch { /* module not loaded */ }
    try {
        const { getReadyReplies } = await import('../nurture/vi-delays');
        queues.igDelayedReplies = getReadyReplies('instagram').length;
        queues.twDelayedReplies = getReadyReplies('twitter').length;
    } catch { /* module not loaded */ }

    res.json({
        timestamp: new Date().toISOString(),
        healthScore,
        status: healthScore >= 80 ? 'healthy' : healthScore >= 50 ? 'degraded' : 'critical',
        services: states.map(s => ({
            id: s.id,
            status: s.status,
            lastRunAt: s.lastRunAt,
            lastRunResult: s.lastRunResult,
            nextScheduledRun: s.nextScheduledRun,
            counters: s.counters,
            consecutiveErrors: s.errorHistory.filter(e => !e.resolved).length,
        })),
        counters,
        browsers,
        queues,
        events,
        uptime: process.uptime(),
        memory: {
            rss: Math.round(mem.rss / 1024 / 1024),
            heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
            heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
        },
    });
}));

// ── Error Diagnosis — pattern detection + root cause ────────────────

opsRouter.get('/errors', (_req: Request, res: Response) => {
    const limit = parseInt(_req.query.limit as string) || 100;
    const allErrors = serviceRegistry.getAllErrors(limit);
    const now = Date.now();

    // Group by category for pattern detection
    const hourAgo = now - 60 * 60 * 1000;
    const recentErrors = allErrors.filter(e => new Date(e.timestamp).getTime() > hourAgo);

    const patterns = detectPatterns(recentErrors);

    const servicesWithErrors = [...new Set(allErrors.map((e: any) => e.serviceId))];
    const categoryCounts = new Map<string, number>();
    for (const e of recentErrors) categoryCounts.set(e.category, (categoryCounts.get(e.category) || 0) + 1);
    const topCategory = [...categoryCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 'none';

    res.json({
        errors: allErrors,
        patterns,
        summary: {
            totalErrors24h: allErrors.filter(e => new Date(e.timestamp).getTime() > now - 24 * 60 * 60 * 1000).length,
            totalErrorsLastHour: recentErrors.length,
            topCategory,
            servicesWithErrors,
            systemicIssue: patterns.some(p => p.isSystemic),
        },
    });
});

opsRouter.get('/errors/:serviceId', (req: Request, res: Response) => {
    const id = validateId(req, res);
    if (!id) return;

    const svc = serviceRegistry.get(id);
    if (!svc) { res.status(404).json({ error: `Service ${id} not registered` }); return; }

    const errors = svc.getErrors(50);
    const hourAgo = Date.now() - 60 * 60 * 1000;
    const recentErrors = errors.filter(e => new Date(e.timestamp).getTime() > hourAgo);
    const patterns = detectPatterns(recentErrors.map(e => ({ serviceId: id, ...e })));

    res.json({ serviceId: id, errors, patterns });
});

// ── Corrective Actions ──────────────────────────────────────────────

opsRouter.post('/retry/:serviceId', asyncHandler(async (req, res) => {
    const id = validateId(req, res);
    if (!id) return;

    const svc = serviceRegistry.get(id);
    if (!svc) { res.status(404).json({ error: `Service ${id} not registered` }); return; }

    const result = await svc.recover();
    res.json({ ok: result.success, ...result, state: svc.getState() });
}));

opsRouter.post('/pause/:serviceId', (req: Request, res: Response) => {
    const id = validateId(req, res);
    if (!id) return;

    const svc = serviceRegistry.get(id);
    if (!svc) { res.status(404).json({ error: `Service ${id} not registered` }); return; }

    svc.stop();
    res.json({ ok: true, message: `${id} paused`, state: svc.getState() });
});

opsRouter.post('/resume/:serviceId', (req: Request, res: Response) => {
    const id = validateId(req, res);
    if (!id) return;

    const svc = serviceRegistry.get(id);
    if (!svc) { res.status(404).json({ error: `Service ${id} not registered` }); return; }

    svc.start();
    res.json({ ok: true, message: `${id} resumed`, state: svc.getState() });
});

opsRouter.post('/pause-all', (_req: Request, res: Response) => {
    const all = serviceRegistry.getAll();
    for (const svc of all) svc.stop();
    res.json({ ok: true, message: `All ${all.length} services paused` });
});

opsRouter.post('/resume-all', (_req: Request, res: Response) => {
    const all = serviceRegistry.getAll();
    for (const svc of all) svc.start();
    res.json({ ok: true, message: `All ${all.length} services resumed` });
});

opsRouter.post('/submit-dm', asyncHandler(async (req, res) => {
    const { platform, username, message } = req.body;

    if (!platform || !username || !message) {
        res.status(400).json({ error: 'Required: platform (instagram|twitter), username, message' });
        return;
    }

    if (platform !== 'instagram' && platform !== 'twitter') {
        res.status(400).json({ error: 'platform must be "instagram" or "twitter"' });
        return;
    }

    // Queue the DM into the pending sends file for the next pipeline cycle
    const sendId = `dm_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const entry = {
        id: sendId,
        recipientUsername: username,
        message,
        context: {
            relationship: { username, tier: 'lead' as const, interactionCount: 0, lastInteraction: null, notes: '' },
            objective: req.body.objective || 'manual outreach via ops API',
        },
        status: 'approved' as const,
        createdAt: new Date().toISOString(),
    };

    try {
        if (platform === 'instagram') {
            const { loadPendingSends, savePendingSends } = await import('../client/Instagram-DM-Pipeline');
            const sends = loadPendingSends();
            sends.push(entry as any);
            savePendingSends(sends);
            res.json({ ok: true, message: `Instagram DM to @${username} queued for next pipeline cycle`, queued: sends.length });
        } else {
            const { loadPendingSends, savePendingSends } = await import('../client/Twitter-DM-Pipeline');
            const sends = loadPendingSends();
            sends.push(entry as any);
            savePendingSends(sends);
            res.json({ ok: true, message: `Twitter DM to @${username} queued for next pipeline cycle`, queued: sends.length });
        }
    } catch (error) {
        res.status(500).json({ error: `Failed to queue DM: ${error instanceof Error ? error.message : String(error)}` });
    }
}));

opsRouter.put('/adjust-config/:serviceId', (req: Request, res: Response) => {
    const id = validateId(req, res);
    if (!id) return;

    const svc = serviceRegistry.get(id);
    if (!svc) { res.status(404).json({ error: `Service ${id} not registered` }); return; }

    const allowed = ['intervalMinutes', 'dailyTarget', 'activeHoursStart', 'activeHoursEnd', 'postsPerRun'];
    const update: Record<string, number> = {};
    for (const key of allowed) {
        if (req.body[key] !== undefined) update[key] = Number(req.body[key]);
    }

    if (Object.keys(update).length === 0) {
        res.status(400).json({ error: `No valid config keys. Allowed: ${allowed.join(', ')}` });
        return;
    }

    svc.updateConfig(update);
    res.json({ ok: true, message: `${id} config updated`, config: svc.getState().config });
});

opsRouter.post('/clear-errors/:serviceId', (req: Request, res: Response) => {
    const id = validateId(req, res);
    if (!id) return;

    const svc = serviceRegistry.get(id);
    if (!svc) { res.status(404).json({ error: `Service ${id} not registered` }); return; }

    svc.clearErrors();
    res.json({ ok: true, message: `Errors cleared for ${id}`, state: svc.getState() });
});

// ── Decision Support ────────────────────────────────────────────────

opsRouter.get('/recommendations', (_req: Request, res: Response) => {
    const recs = generateRecommendations();
    res.json({
        timestamp: new Date().toISOString(),
        count: recs.length,
        recommendations: recs,
    });
});

// ── Helpers ─────────────────────────────────────────────────────────

interface ErrorPattern {
    category: string;
    count: number;
    services: string[];
    firstSeen: string;
    lastSeen: string;
    isRecurring: boolean;
    isSystemic: boolean;
    rootCause: string;
    recommendation: string;
}

function detectPatterns(errors: Array<{ serviceId?: ServiceId } & ErrorRecord>): ErrorPattern[] {
    const groups = new Map<string, typeof errors>();
    for (const err of errors) {
        if (!groups.has(err.category)) groups.set(err.category, []);
        groups.get(err.category)!.push(err);
    }

    const patterns: ErrorPattern[] = [];
    for (const [category, errs] of groups) {
        if (errs.length < 2) continue;

        const services = [...new Set(errs.map(e => e.serviceId).filter(Boolean))] as string[];
        const timestamps = errs.map(e => new Date(e.timestamp).getTime()).sort();
        const isRecurring = errs.length >= 3;
        const isSystemic = services.length >= 2;

        let rootCause = 'Unknown';
        let recommendation = 'Check logs for more details';

        switch (category) {
            case 'rate_limit':
                rootCause = 'Too many platform actions in a short window';
                recommendation = isSystemic
                    ? 'Pause all services and reduce daily targets across the board'
                    : `Reduce postsPerRun and dailyTarget for ${services.join(', ')}`;
                break;
            case 'auth':
                rootCause = 'Session tokens expired or invalidated';
                recommendation = `Re-login in browser for: ${services.join(', ')}`;
                break;
            case 'blocked':
                rootCause = 'Platform action-block or account restriction';
                recommendation = 'Pause affected services for 24-48h. Check account standing manually.';
                break;
            case 'transient':
                rootCause = isSystemic ? 'Network or infrastructure instability' : 'Intermittent connectivity issue';
                recommendation = isRecurring ? 'Check internet connection and proxy health' : 'Auto-retry should handle this';
                break;
            case 'not_found':
                rootCause = 'UI selectors may be outdated — platform updated their layout';
                recommendation = 'Check if platform pushed a UI update. Selectors may need updating.';
                break;
            case 'fatal':
                rootCause = 'System resource exhaustion (memory/disk/CPU)';
                recommendation = 'Restart the process. Check Task Manager for resource usage.';
                break;
            default:
                rootCause = `Multiple ${category} errors — investigate logs`;
                recommendation = 'Review error messages for a common thread';
        }

        patterns.push({
            category,
            count: errs.length,
            services,
            firstSeen: new Date(timestamps[0]).toISOString(),
            lastSeen: new Date(timestamps[timestamps.length - 1]).toISOString(),
            isRecurring,
            isSystemic,
            rootCause,
            recommendation,
        });
    }

    return patterns.sort((a, b) => b.count - a.count);
}
