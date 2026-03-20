/**
 * Service Routes — per-service control endpoints
 */

import { Router, Request, Response, NextFunction } from 'express';
import { serviceRegistry } from '../services/ServiceRegistry';
import type { ServiceId } from '../services/ServiceState';

export const serviceRouter = Router();

/** Wrap async route handlers so rejected promises forward to Express error handling. */
const asyncHandler = (fn: (req: Request, res: Response) => Promise<void>) =>
    (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };

const VALID_IDS: ServiceId[] = ['instagram-feed', 'instagram-dm', 'threads', 'twitter-feed', 'twitter-dm'];

function validateServiceId(req: Request, res: Response): ServiceId | null {
    const id = req.params.id as ServiceId;
    if (!VALID_IDS.includes(id)) {
        res.status(400).json({ error: `Invalid service ID. Valid: ${VALID_IDS.join(', ')}` });
        return null;
    }
    return id;
}

// List all services
serviceRouter.get('/', (_req: Request, res: Response) => {
    res.json(serviceRegistry.getAllStates());
});

// Get one service
serviceRouter.get('/:id', (req: Request, res: Response) => {
    const id = validateServiceId(req, res);
    if (!id) return;

    const svc = serviceRegistry.get(id);
    if (!svc) { res.status(404).json({ error: `Service ${id} not registered` }); return; }

    res.json(svc.getState());
});

// Error history for one service
serviceRouter.get('/:id/errors', (req: Request, res: Response) => {
    const id = validateServiceId(req, res);
    if (!id) return;

    const svc = serviceRegistry.get(id);
    if (!svc) { res.status(404).json({ error: `Service ${id} not registered` }); return; }

    const limit = parseInt(req.query.limit as string) || 50;
    res.json(svc.getErrors(limit));
});

// Run history for one service
serviceRouter.get('/:id/runs', (req: Request, res: Response) => {
    const id = validateServiceId(req, res);
    if (!id) return;

    const svc = serviceRegistry.get(id);
    if (!svc) { res.status(404).json({ error: `Service ${id} not registered` }); return; }

    const limit = parseInt(req.query.limit as string) || 100;
    res.json(svc.getRuns(limit));
});

// Start a service
serviceRouter.post('/:id/start', (req: Request, res: Response) => {
    const id = validateServiceId(req, res);
    if (!id) return;

    const svc = serviceRegistry.get(id);
    if (!svc) { res.status(404).json({ error: `Service ${id} not registered` }); return; }

    svc.start();
    res.json({ ok: true, message: `${id} started`, state: svc.getState() });
});

// Stop a service
serviceRouter.post('/:id/stop', (req: Request, res: Response) => {
    const id = validateServiceId(req, res);
    if (!id) return;

    const svc = serviceRegistry.get(id);
    if (!svc) { res.status(404).json({ error: `Service ${id} not registered` }); return; }

    svc.stop();
    res.json({ ok: true, message: `${id} stopped`, state: svc.getState() });
});

// Trigger an immediate run
serviceRouter.post('/:id/trigger', asyncHandler(async (req, res) => {
    const id = validateServiceId(req, res);
    if (!id) return;

    const svc = serviceRegistry.get(id);
    if (!svc) { res.status(404).json({ error: `Service ${id} not registered` }); return; }

    try {
        const runRecord = await svc.triggerRun();
        res.json({ ok: true, run: runRecord });
    } catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
}));

// Attempt error recovery
serviceRouter.post('/:id/recover', asyncHandler(async (req, res) => {
    const id = validateServiceId(req, res);
    if (!id) return;

    const svc = serviceRegistry.get(id);
    if (!svc) { res.status(404).json({ error: `Service ${id} not registered` }); return; }

    const result = await svc.recover();
    res.json(result);
}));

// Update service config
serviceRouter.put('/:id/config', (req: Request, res: Response) => {
    const id = validateServiceId(req, res);
    if (!id) return;

    const svc = serviceRegistry.get(id);
    if (!svc) { res.status(404).json({ error: `Service ${id} not registered` }); return; }

    const allowed = ['intervalMinutes', 'dailyTarget', 'activeHoursStart', 'activeHoursEnd', 'postsPerRun'];
    const update: Record<string, any> = {};
    for (const key of allowed) {
        if (req.body[key] !== undefined) {
            update[key] = Number(req.body[key]);
        }
    }

    if (Object.keys(update).length === 0) {
        res.status(400).json({ error: `No valid config keys. Allowed: ${allowed.join(', ')}` });
        return;
    }

    svc.updateConfig(update);
    res.json({ ok: true, config: svc.getState().config });
});
