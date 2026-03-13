import { Router, Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../utils/logger';
import { safeReadJSON, safeWriteJSON, formatError } from '../utils/errors';
import { getAllDMs, getDMsForUser, getTodayDMCount } from '../tracking/dmTracker';
import { getAllRelationships, getFeedbackStats } from '../client/Instagram-DM-AI';
import { getAllCachedProfiles } from '../client/Instagram-Profile';
import {
    loadOffers, saveOffers, loadConfig, saveConfig,
    loadPendingSends, savePendingSends,
    PipelineConfig, Offer, PendingSend
} from '../client/Instagram-DM-Pipeline';
import {
    recordConversion, getConversionStats, getFullAnalytics,
    analyzeFeedbackAndLearn, getAllLearnings, getBestSendingHours
} from '../client/Instagram-DM-Analytics';
import { bulkSyncToSupabase } from '../db/supabaseDM';

const router = Router();

const DM_DATA_DIR = path.join(process.cwd(), 'logs', 'tracking', 'dm');
const CONVERSATIONS_DIR = path.join(DM_DATA_DIR, 'conversations');
const APPROVALS_FILE = path.join(DM_DATA_DIR, 'approvals.json');

// ── Types ────────────────────────────────────────────────────────────

interface PendingApproval {
    id: string;
    recipientUsername: string;
    proposedMessage: string;
    context?: Record<string, any>;
    status: 'pending' | 'approved' | 'rejected';
    createdAt: string;
    reviewedAt?: string;
}

function loadApprovals(): PendingApproval[] {
    return safeReadJSON<PendingApproval[]>(APPROVALS_FILE, [], 'approvals');
}

function saveApprovals(approvals: PendingApproval[]) {
    safeWriteJSON(APPROVALS_FILE, approvals, 'approvals');
}

// ── GET /api/dm/stats — DM statistics ────────────────────────────────

router.get('/stats', (_req: Request, res: Response) => {
    const allDMs = getAllDMs();
    const todayCount = getTodayDMCount();
    const uniqueRecipients = new Set(allDMs.map(d => d.recipientUsername.toLowerCase())).size;
    const verified = allDMs.filter(d => d.verified).length;

    res.json({
        totalDMs: allDMs.length,
        todayDMs: todayCount,
        uniqueRecipients,
        verified,
        outbound: allDMs.filter(d => d.direction === 'outbound').length,
        inbound: allDMs.filter(d => d.direction === 'inbound').length
    });
});

// ── GET /api/dm/conversations — List all stored conversations ────────

router.get('/conversations', (_req: Request, res: Response) => {
    try {
        if (!fs.existsSync(CONVERSATIONS_DIR)) {
            res.json({ conversations: [] });
            return;
        }
        const files = fs.readdirSync(CONVERSATIONS_DIR).filter(f => f.endsWith('.json'));
        const conversations = files.map(f => {
            const data = JSON.parse(fs.readFileSync(path.join(CONVERSATIONS_DIR, f), 'utf8'));
            return {
                username: data.username,
                messageCount: data.messages?.length || 0,
                lastScrapedAt: data.lastScrapedAt
            };
        });
        res.json({ conversations });
    } catch (e) {
        logger.error(`[dm-routes] Failed to load conversations: ${formatError(e)}`);
        res.status(500).json({ error: 'Failed to load conversations' });
    }
});

// ── GET /api/dm/conversations/:username — Get specific thread ────────

router.get('/conversations/:username', (req: Request, res: Response) => {
    try {
        const username = req.params.username.toLowerCase();
        const filePath = path.join(CONVERSATIONS_DIR, `${username}.json`);
        if (!fs.existsSync(filePath)) {
            res.status(404).json({ error: 'Conversation not found' });
            return;
        }
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        res.json(data);
    } catch (e) {
        logger.error(`[dm-routes] Failed to load conversation: ${formatError(e)}`);
        res.status(500).json({ error: 'Failed to load conversation' });
    }
});

// ── GET /api/dm/history/:username — Get DM tracking history ──────────

router.get('/history/:username', (req: Request, res: Response) => {
    const dms = getDMsForUser(req.params.username);
    res.json({ username: req.params.username, messages: dms });
});

// ── Approval Flow ────────────────────────────────────────────────────

// GET /api/dm/approvals — List pending approvals
router.get('/approvals', (_req: Request, res: Response) => {
    const approvals = loadApprovals().filter(a => a.status === 'pending');
    res.json({ approvals });
});

// POST /api/dm/approvals — Create a new approval request
router.post('/approvals', (req: Request, res: Response) => {
    const { recipientUsername, proposedMessage, context } = req.body;
    if (!recipientUsername || !proposedMessage) {
        res.status(400).json({ error: 'recipientUsername and proposedMessage required' });
        return;
    }

    const approval: PendingApproval = {
        id: `approval_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        recipientUsername,
        proposedMessage,
        context,
        status: 'pending',
        createdAt: new Date().toISOString()
    };

    const approvals = loadApprovals();
    approvals.push(approval);
    saveApprovals(approvals);

    res.json({ approval });
});

// POST /api/dm/approvals/:id/approve — Approve a pending message
router.post('/approvals/:id/approve', (req: Request, res: Response) => {
    const approvals = loadApprovals();
    const approval = approvals.find(a => a.id === req.params.id);
    if (!approval) { res.status(404).json({ error: 'Approval not found' }); return; }
    if (approval.status !== 'pending') { res.status(400).json({ error: 'Already reviewed' }); return; }

    approval.status = 'approved';
    approval.reviewedAt = new Date().toISOString();
    saveApprovals(approvals);

    res.json({ approval });
});

// POST /api/dm/approvals/:id/reject — Reject a pending message
router.post('/approvals/:id/reject', (req: Request, res: Response) => {
    const approvals = loadApprovals();
    const approval = approvals.find(a => a.id === req.params.id);
    if (!approval) { res.status(404).json({ error: 'Approval not found' }); return; }
    if (approval.status !== 'pending') { res.status(400).json({ error: 'Already reviewed' }); return; }

    approval.status = 'rejected';
    approval.reviewedAt = new Date().toISOString();
    saveApprovals(approvals);

    res.json({ approval });
});

// ── GET /api/dm/inbox — Get latest inbox snapshot ────────────────────

router.get('/inbox', (_req: Request, res: Response) => {
    try {
        const inboxFile = path.join(DM_DATA_DIR, 'inbox.json');
        if (!fs.existsSync(inboxFile)) {
            res.json({ scrapedAt: null, conversations: [] });
            return;
        }
        const data = JSON.parse(fs.readFileSync(inboxFile, 'utf8'));
        res.json(data);
    } catch (e) {
        logger.error(`[dm-routes] Failed to load inbox: ${formatError(e)}`);
        res.status(500).json({ error: 'Failed to load inbox' });
    }
});

// ── GET /api/dm/relationships — All relationship data ────────────────

router.get('/relationships', (_req: Request, res: Response) => {
    const relationships = getAllRelationships();
    res.json({ relationships });
});

// ── GET /api/dm/profiles — All cached profiles ──────────────────────

router.get('/profiles', (_req: Request, res: Response) => {
    const profiles = getAllCachedProfiles();
    res.json({ profiles });
});

// ── GET /api/dm/feedback — Feedback loop stats ──────────────────────

router.get('/feedback', (_req: Request, res: Response) => {
    const stats = getFeedbackStats();
    res.json(stats);
});

// ── Pipeline Config ─────────────────────────────────────────────────

// GET /api/dm/pipeline/config — Get pipeline configuration
router.get('/pipeline/config', (_req: Request, res: Response) => {
    const config = loadConfig();
    res.json({ config });
});

// PUT /api/dm/pipeline/config — Update pipeline configuration
router.put('/pipeline/config', (req: Request, res: Response) => {
    const current = loadConfig();
    const updated = { ...current, ...req.body };
    saveConfig(updated);
    logger.info('[dm-routes] Pipeline config updated');
    res.json({ config: updated });
});

// ── Offers CRUD ─────────────────────────────────────────────────────

// GET /api/dm/pipeline/offers — List all offers
router.get('/pipeline/offers', (_req: Request, res: Response) => {
    const offers = loadOffers();
    res.json({ offers });
});

// POST /api/dm/pipeline/offers — Create a new offer
router.post('/pipeline/offers', (req: Request, res: Response) => {
    const { name, description, targetCategories, targetTags, targetNiches,
        minWarmth, minStage, messageHint } = req.body;
    if (!name || !description) {
        res.status(400).json({ error: 'name and description required' });
        return;
    }

    const offer: Offer = {
        id: `offer_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        name,
        description,
        targetCategories: targetCategories || [],
        targetTags: targetTags || [],
        targetNiches: targetNiches || [],
        minWarmth: minWarmth || 50,
        minStage: minStage || 'building',
        messageHint: messageHint || '',
        active: true,
        timesOffered: 0,
        conversions: 0
    };

    const offers = loadOffers();
    offers.push(offer);
    saveOffers(offers);
    res.json({ offer });
});

// PUT /api/dm/pipeline/offers/:id — Update an offer
router.put('/pipeline/offers/:id', (req: Request, res: Response) => {
    const offers = loadOffers();
    const idx = offers.findIndex(o => o.id === req.params.id);
    if (idx < 0) { res.status(404).json({ error: 'Offer not found' }); return; }

    offers[idx] = { ...offers[idx], ...req.body, id: offers[idx].id };
    saveOffers(offers);
    res.json({ offer: offers[idx] });
});

// DELETE /api/dm/pipeline/offers/:id — Delete an offer
router.delete('/pipeline/offers/:id', (req: Request, res: Response) => {
    const offers = loadOffers();
    const idx = offers.findIndex(o => o.id === req.params.id);
    if (idx < 0) { res.status(404).json({ error: 'Offer not found' }); return; }

    const removed = offers.splice(idx, 1);
    saveOffers(offers);
    res.json({ removed: removed[0] });
});

// ── Pipeline Pending Sends ──────────────────────────────────────────

// GET /api/dm/pipeline/pending — List pending sends
router.get('/pipeline/pending', (req: Request, res: Response) => {
    const status = req.query.status as string || 'pending';
    const sends = loadPendingSends();
    const filtered = status === 'all' ? sends : sends.filter(s => s.status === status);
    res.json({ sends: filtered, total: sends.length });
});

// POST /api/dm/pipeline/pending/:id/approve — Approve a pending send
router.post('/pipeline/pending/:id/approve', (req: Request, res: Response) => {
    const sends = loadPendingSends();
    const send = sends.find(s => s.id === req.params.id);
    if (!send) { res.status(404).json({ error: 'Pending send not found' }); return; }
    if (send.status !== 'pending') { res.status(400).json({ error: `Already ${send.status}` }); return; }

    send.status = 'approved';
    send.reviewedAt = new Date().toISOString();

    // Allow editing the message before approving
    if (req.body.message) {
        send.message = req.body.message;
    }

    savePendingSends(sends);
    logger.info(`[dm-routes] Approved send ${send.id} to @${send.recipientUsername}`);
    res.json({ send });
});

// POST /api/dm/pipeline/pending/:id/reject — Reject a pending send
router.post('/pipeline/pending/:id/reject', (req: Request, res: Response) => {
    const sends = loadPendingSends();
    const send = sends.find(s => s.id === req.params.id);
    if (!send) { res.status(404).json({ error: 'Pending send not found' }); return; }
    if (send.status !== 'pending') { res.status(400).json({ error: `Already ${send.status}` }); return; }

    send.status = 'rejected';
    send.reviewedAt = new Date().toISOString();
    savePendingSends(sends);
    logger.info(`[dm-routes] Rejected send ${send.id} to @${send.recipientUsername}`);
    res.json({ send });
});

// ── Pipeline Outreach Targets ───────────────────────────────────────

const TARGETS_FILE = path.join(DM_DATA_DIR, 'outreach_targets.json');

// GET /api/dm/pipeline/targets — Get target list
router.get('/pipeline/targets', (_req: Request, res: Response) => {
    try {
        if (fs.existsSync(TARGETS_FILE)) {
            const targets = JSON.parse(fs.readFileSync(TARGETS_FILE, 'utf8'));
            res.json({ targets });
            return;
        }
    } catch (e) {
        logger.warn(`[dm-routes] Failed to read targets: ${formatError(e)}`);
    }
    res.json({ targets: [] });
});

// POST /api/dm/pipeline/targets — Add targets to outreach list
router.post('/pipeline/targets', (req: Request, res: Response) => {
    const { usernames } = req.body;
    if (!Array.isArray(usernames) || usernames.length === 0) {
        res.status(400).json({ error: 'usernames array required' });
        return;
    }

    let existing: string[] = [];
    try {
        if (fs.existsSync(TARGETS_FILE)) {
            existing = JSON.parse(fs.readFileSync(TARGETS_FILE, 'utf8'));
        }
    } catch (e) {
        logger.warn(`[dm-routes] Failed to read existing targets: ${formatError(e)}`);
    }

    const newTargets = usernames.filter((u: string) => !existing.includes(u.toLowerCase()));
    existing.push(...newTargets.map((u: string) => u.toLowerCase()));

    if (!fs.existsSync(DM_DATA_DIR)) fs.mkdirSync(DM_DATA_DIR, { recursive: true });
    fs.writeFileSync(TARGETS_FILE, JSON.stringify(existing, null, 2));

    res.json({ added: newTargets.length, total: existing.length, targets: existing });
});

// DELETE /api/dm/pipeline/targets — Remove a target
router.delete('/pipeline/targets/:username', (req: Request, res: Response) => {
    try {
        if (!fs.existsSync(TARGETS_FILE)) {
            res.status(404).json({ error: 'No targets file' });
            return;
        }
        let targets: string[] = JSON.parse(fs.readFileSync(TARGETS_FILE, 'utf8'));
        const before = targets.length;
        targets = targets.filter(t => t !== req.params.username.toLowerCase());
        fs.writeFileSync(TARGETS_FILE, JSON.stringify(targets, null, 2));
        res.json({ removed: before - targets.length, total: targets.length });
    } catch (e) {
        logger.error(`[dm-routes] Failed to remove target: ${formatError(e)}`);
        res.status(500).json({ error: 'Failed to remove target' });
    }
});

// ── Pipeline Status Overview ────────────────────────────────────────

router.get('/pipeline/status', (_req: Request, res: Response) => {
    const config = loadConfig();
    const sends = loadPendingSends();
    const offers = loadOffers();
    const feedbackStats = getFeedbackStats();
    const todayDMs = getTodayDMCount();

    res.json({
        config,
        todayDMs,
        remainingToday: Math.max(0, config.maxDMsPerDay - todayDMs),
        pending: sends.filter(s => s.status === 'pending').length,
        approved: sends.filter(s => s.status === 'approved').length,
        sent: sends.filter(s => s.status === 'sent').length,
        failed: sends.filter(s => s.status === 'failed').length,
        rejected: sends.filter(s => s.status === 'rejected').length,
        activeOffers: offers.filter(o => o.active).length,
        totalOffers: offers.length,
        feedback: feedbackStats
    });
});

// ── Analytics & Conversions ─────────────────────────────────────────

// GET /api/dm/analytics — Full analytics dashboard
router.get('/analytics', (_req: Request, res: Response) => {
    const analytics = getFullAnalytics();
    res.json(analytics);
});

// GET /api/dm/analytics/conversions — Conversion stats
router.get('/analytics/conversions', (_req: Request, res: Response) => {
    const stats = getConversionStats();
    res.json(stats);
});

// POST /api/dm/analytics/conversions — Record a conversion
router.post('/analytics/conversions', (req: Request, res: Response) => {
    const { recipientUsername, offerId, offerName, conversionType, value, notes,
        dmsSentBeforeConversion, daysSinceFirstContact, finalWarmth } = req.body;

    if (!recipientUsername || !conversionType) {
        res.status(400).json({ error: 'recipientUsername and conversionType required' });
        return;
    }

    const conversion = recordConversion({
        recipientUsername,
        offerId: offerId || 'manual',
        offerName: offerName || 'Manual conversion',
        conversionType,
        value: value || 0,
        notes,
        dmsSentBeforeConversion: dmsSentBeforeConversion || 0,
        daysSinceFirstContact: daysSinceFirstContact || 0,
        finalWarmth: finalWarmth || 0
    });

    res.json({ conversion });
});

// GET /api/dm/analytics/learnings — Message effectiveness learnings
router.get('/analytics/learnings', (_req: Request, res: Response) => {
    const learnings = getAllLearnings();
    res.json({ learnings });
});

// POST /api/dm/analytics/learn — Trigger learning analysis from feedback
router.post('/analytics/learn', (_req: Request, res: Response) => {
    const learnings = analyzeFeedbackAndLearn();
    res.json({ generated: learnings.length, learnings });
});

// GET /api/dm/analytics/timing — Best sending times
router.get('/analytics/timing', (_req: Request, res: Response) => {
    const bestHours = getBestSendingHours();
    res.json({ bestHours });
});

// ── Supabase Sync ───────────────────────────────────────────────────

// POST /api/dm/sync — Bulk sync local data to Supabase
router.post('/sync', async (_req: Request, res: Response) => {
    try {
        const result = await bulkSyncToSupabase();
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: 'Sync failed', details: e instanceof Error ? e.message : String(e) });
    }
});

export const dmRouter = router;
