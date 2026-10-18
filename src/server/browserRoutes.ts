/**
 * Browser Routes — browser instance management endpoints
 */

import { Router, Request, Response, NextFunction } from 'express';
import { browserPool, type ProfileKey } from '../browser/BrowserPool';

export const browserRouter = Router();

/** Wrap async route handlers so rejected promises forward to Express error handling. */
const asyncHandler = (fn: (req: Request, res: Response) => Promise<void>) =>
    (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };

const VALID_PROFILES: ProfileKey[] = ['instagram-feed', 'instagram-dm', 'threads', 'twitter-feed', 'twitter-dm'];

function validateProfile(req: Request, res: Response): ProfileKey | null {
    const key = req.params.profileKey as ProfileKey;
    if (!VALID_PROFILES.includes(key)) {
        res.status(400).json({ error: `Invalid profile. Valid: ${VALID_PROFILES.join(', ')}` });
        return null;
    }
    return key;
}

// Status of all browsers
browserRouter.get('/', (_req: Request, res: Response) => {
    res.json(browserPool.getStatus());
});

// Status of one browser
browserRouter.get('/:profileKey', (req: Request, res: Response) => {
    const key = validateProfile(req, res);
    if (!key) return;

    const status = browserPool.getStatus();
    res.json(status[key] || { status: 'not_launched' });
});

// Health check for a browser
browserRouter.get('/:profileKey/health', asyncHandler(async (req, res) => {
    const key = validateProfile(req, res);
    if (!key) return;

    const health = await browserPool.healthCheck(key);
    res.json(health);
}));

// Launch a browser
browserRouter.post('/:profileKey/launch', asyncHandler(async (req, res) => {
    const key = validateProfile(req, res);
    if (!key) return;

    try {
        const lease = await browserPool.acquire(key, 'api:launch');
        lease.release(); // immediately release — just launching
        res.json({ ok: true, message: `${key} browser launched` });
    } catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
}));

// Close a browser
browserRouter.post('/:profileKey/close', asyncHandler(async (req, res) => {
    const key = validateProfile(req, res);
    if (!key) return;

    await browserPool.close(key);
    res.json({ ok: true, message: `${key} browser closed` });
}));

// Take a screenshot
browserRouter.post('/:profileKey/screenshot', asyncHandler(async (req, res) => {
    const key = validateProfile(req, res);
    if (!key) return;

    const buffer = await browserPool.screenshot(key);
    if (!buffer) {
        res.status(404).json({ error: 'No browser running or screenshot failed' });
        return;
    }

    res.set('Content-Type', 'image/png');
    res.send(buffer);
}));

// Navigate to a URL
browserRouter.post('/:profileKey/navigate', asyncHandler(async (req, res) => {
    const key = validateProfile(req, res);
    if (!key) return;

    const { url } = req.body;
    if (!url || typeof url !== 'string') {
        res.status(400).json({ error: 'url required in request body' });
        return;
    }

    const success = await browserPool.navigate(key, url);
    res.json({ ok: success, message: success ? 'Navigated' : 'Failed (browser busy or not launched)' });
}));
