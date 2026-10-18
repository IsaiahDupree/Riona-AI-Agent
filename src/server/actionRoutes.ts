/**
 * Action Routes — direct action endpoints wrapping existing functions
 * Each action acquires a browser from the pool, runs the operation, releases.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { browserPool } from '../browser/BrowserPool';
import { logger } from '../utils/logger';

export const actionRouter = Router();

/** Wrap async route handlers so rejected promises forward to Express error handling. */
const asyncHandler = (fn: (req: Request, res: Response) => Promise<void>) =>
    (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };

// ── Instagram Actions ─────────────────────────────────────────────

actionRouter.post('/instagram/comment-batch', asyncHandler(async (_req, res) => {
    try {
        const lease = await browserPool.acquire('instagram-feed', 'action:ig-comment-batch');
        try {
            const { runSingleBatch } = await import('../client/Instagram-AI');
            const botUsername = process.env.INSTAGRAM_BOT_USERNAME || 'unknown';
            const result = await runSingleBatch(botUsername);
            res.json({ ok: true, result });
        } finally {
            lease.release();
        }
    } catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
}));

actionRouter.post('/instagram/dm/send', asyncHandler(async (req, res) => {
    const { username, message } = req.body;
    if (!username || !message) {
        res.status(400).json({ error: 'username and message required' });
        return;
    }

    try {
        const lease = await browserPool.acquire('instagram-dm', 'action:ig-dm-send');
        try {
            const { InstagramDM } = await import('../client/Instagram-DM');
            const dm = InstagramDM.fromPage(lease.page);
            const sent = await dm.sendDM(username, message);
            res.json({ ok: sent, username, message: sent ? 'DM sent' : 'Failed to send DM' });
        } finally {
            lease.release();
        }
    } catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
}));

actionRouter.post('/instagram/dm/check', asyncHandler(async (_req, res) => {
    try {
        const lease = await browserPool.acquire('instagram-dm', 'action:ig-dm-check');
        try {
            const { InstagramDM } = await import('../client/Instagram-DM');
            const dm = InstagramDM.fromPage(lease.page);
            const conversations = await dm.scrapeInbox();
            res.json({ ok: true, conversations: conversations.length, data: conversations });
        } finally {
            lease.release();
        }
    } catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
}));

// ── Threads Actions ───────────────────────────────────────────────

actionRouter.post('/threads/comment-batch', asyncHandler(async (_req, res) => {
    try {
        const lease = await browserPool.acquire('threads', 'action:threads-comment-batch');
        try {
            const { runThreadsBatch } = await import('../client/Threads-AI');
            const botUsername = process.env.THREADS_BOT_USERNAME || process.env.INSTAGRAM_BOT_USERNAME || 'unknown';
            const result = await runThreadsBatch(botUsername);
            res.json({ ok: true, result });
        } finally {
            lease.release();
        }
    } catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
}));

// ── Twitter Actions ───────────────────────────────────────────────

actionRouter.post('/twitter/reply-batch', asyncHandler(async (_req, res) => {
    try {
        const lease = await browserPool.acquire('twitter-feed', 'action:tw-reply-batch');
        try {
            const { runTwitterBatch } = await import('../client/Twitter-AI');
            const botUsername = process.env.TWITTER_BOT_USERNAME || 'unknown';
            const result = await runTwitterBatch(botUsername);
            res.json({ ok: true, result: { commentsPosted: result.commentsPosted, session: result.session } });
        } finally {
            lease.release();
        }
    } catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
}));

actionRouter.post('/twitter/niche-batch', asyncHandler(async (req, res) => {
    const { searchTerm, count } = req.body;
    if (!searchTerm) {
        res.status(400).json({ error: 'searchTerm required' });
        return;
    }

    try {
        const lease = await browserPool.acquire('twitter-feed', 'action:tw-niche-batch');
        try {
            const { runTwitterNicheBatch } = await import('../client/Twitter-AI');
            const result = await runTwitterNicheBatch(searchTerm, count || 10);
            res.json({ ok: true, result: { commentsPosted: result.commentsPosted, session: result.session } });
        } finally {
            lease.release();
        }
    } catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
}));

actionRouter.post('/twitter/dm/send', asyncHandler(async (req, res) => {
    const { username, message } = req.body;
    if (!username || !message) {
        res.status(400).json({ error: 'username and message required' });
        return;
    }

    try {
        const lease = await browserPool.acquire('twitter-dm', 'action:tw-dm-send');
        try {
            const { TwitterDM } = await import('../client/Twitter-DM');
            const dm = TwitterDM.fromPage(lease.page);
            const sent = await dm.sendDM(username, message);
            res.json({ ok: sent, username, message: sent ? 'DM sent' : 'Failed to send DM' });
        } finally {
            lease.release();
        }
    } catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
}));

actionRouter.post('/twitter/dm/check', asyncHandler(async (_req, res) => {
    try {
        const lease = await browserPool.acquire('twitter-dm', 'action:tw-dm-check');
        try {
            const { TwitterDM } = await import('../client/Twitter-DM');
            const dm = TwitterDM.fromPage(lease.page);
            const conversations = await dm.scrapeInbox();
            res.json({ ok: true, conversations: conversations.length, data: conversations });
        } finally {
            lease.release();
        }
    } catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
}));

actionRouter.post('/twitter/content/post', asyncHandler(async (req, res) => {
    try {
        const lease = await browserPool.acquire('twitter-feed', 'action:tw-content-post');
        try {
            const { postStrategicContent } = await import('../client/Twitter-AI');
            const result = await postStrategicContent(lease.page, req.body.runNumber || 1);
            res.json({ ok: result.success, result });
        } finally {
            lease.release();
        }
    } catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
}));

// ── Instagram Graph API Actions (no browser needed) ───────────────

actionRouter.post('/instagram/api/dm/send', asyncHandler(async (req, res) => {
    const { recipientId, message } = req.body;
    if (!recipientId || !message) {
        res.status(400).json({ error: 'recipientId and message required' });
        return;
    }

    try {
        const { sendInstagramDMViaAPI } = await import('../utils/instagram-api');
        const result = await sendInstagramDMViaAPI(recipientId, message);
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
}));
