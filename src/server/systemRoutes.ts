/**
 * System Routes — health, status, and aggregated error history
 */

import { Router, Request, Response } from 'express';
import { serviceRegistry } from '../services/ServiceRegistry';
import { browserPool } from '../browser/BrowserPool';
import { eventBus } from '../services/EventBus';

export const systemRouter = Router();

// Overall system health
systemRouter.get('/health', (_req: Request, res: Response) => {
    const summary = serviceRegistry.getHealthSummary();
    const status = summary.failed > 0 ? 'degraded' : 'healthy';
    res.json({ status, ...summary });
});

// Full system status
systemRouter.get('/status', (_req: Request, res: Response) => {
    res.json({
        services: serviceRegistry.getAllStates(),
        browsers: browserPool.getStatus(),
        uptime: process.uptime(),
        pid: process.pid,
        memory: process.memoryUsage(),
    });
});

// Aggregated error history
systemRouter.get('/errors', (req: Request, res: Response) => {
    const limit = parseInt(req.query.limit as string) || 100;
    res.json(serviceRegistry.getAllErrors(limit));
});

// Errors filtered by category
systemRouter.get('/errors/:category', (req: Request, res: Response) => {
    const { category } = req.params;
    const limit = parseInt(req.query.limit as string) || 100;
    const errors = serviceRegistry.getAllErrors(limit)
        .filter(e => e.category === category);
    res.json(errors);
});

// Recent events (event bus history)
systemRouter.get('/events', (req: Request, res: Response) => {
    const limit = parseInt(req.query.limit as string) || 50;
    res.json(eventBus.getRecentEvents(limit));
});
