import express, { Request, Response } from 'express';
import { AccountModel, ResponseStyleModel, InteractionModel, ApprovalItemModel } from './models';
import { requireRole } from './security';
import { approveItem, denyItem, reviseItem, scheduleItem } from './service';
import { executeCommentOnPermalink } from '../client/InstagramExecute';
import { startRun, pushStep } from '../trace/runtime';
import { saveTrace } from '../trace/store';
import { logger } from '../utils/logger';
import { formatError } from '../utils/errors';

export const hitlRouter = express.Router();

hitlRouter.get('/interactions', requireRole('viewer'), async (req: Request, res: Response) => {
  const { type, state, accountId, username, postId, page = '1', pageSize = '50' } = req.query as any;
  const q: any = {};
  if (type) q.type = type;
  if (state) q.state = state;
  if (accountId) q.accountId = accountId;
  if (username) q['target.username'] = username;
  if (postId) q['target.postId'] = postId;
  const limit = Number(pageSize);
  const skip = (Number(page) - 1) * limit;
  const [items, total] = await Promise.all([InteractionModel.find(q).sort({ updatedAt: -1 }).skip(skip).limit(limit).lean(), InteractionModel.countDocuments(q)]);
  res.json({ items, total, page: Number(page), pageSize: limit });
});

hitlRouter.get('/accounts', requireRole('viewer'), async (req: Request, res: Response): Promise<void> => {
  const { q, status, hitlLevel, platform, page, pageSize, paged } = req.query as any
  const filter: any = {}
  if (status) filter.status = status
  if (hitlLevel) filter.hitlLevel = hitlLevel
  if (platform) filter.platform = platform
  if (q) filter.username = { $regex: String(q), $options: 'i' }

  // If pagination is not requested, return full array (backward compatible)
  if (!paged && !page && !pageSize) {
    const rows = await AccountModel.find(filter).sort({ updatedAt: -1 }).lean()
    res.json(rows)
    return
  }

  const limit = Math.min(Number(pageSize) || 50, 200)
  const p = Math.max(1, Number(page) || 1)
  const skip = (p - 1) * limit
  const [items, total] = await Promise.all([
    AccountModel.find(filter).sort({ updatedAt: -1 }).skip(skip).limit(limit).lean(),
    AccountModel.countDocuments(filter),
  ])
  res.json({ items, total, page: p, pageSize: limit })
  return
})

// Approve + Execute: post the decided/proposed text to the target permalink with tracing
hitlRouter.post('/interactions/:id/execute', requireRole('moderator'), async (req: Request, res: Response) => {
  const { id } = req.params as any
  const doc: any = await InteractionModel.findOne({ id }).lean().exec()
  if (!doc) { res.status(404).json({ error: 'interaction_not_found' }); return }
  const permalink = doc?.target?.permalink
  const comment = doc?.decided?.text || doc?.proposed?.text
  const username = doc?.target?.username
  if (!permalink || !comment) { res.status(400).json({ error: 'permalink_or_text_missing' }); return }

  // Create a trace now so we can return runId immediately
  const trace = startRun({ action: 'instagram_execute_comment', target: { username, permalink }, cookieFile: './cookies.json' })
  try {
    // Persist moderation context for this run so it's visible in Run Viewer
    const ctx = {
      interactionId: doc.id,
      accountId: doc.accountId,
      type: doc.type,
      target: doc.target,
      proposed: doc.proposed,
      decided: doc.decided,
      state: doc.state,
      scores: doc.scores,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
    }
    pushStep(trace, { name: 'moderation_context', status: 'ok', notes: JSON.stringify(ctx) })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[hitl] Trace context push failed: ${msg}`);
  }
  await saveTrace(trace)
  await InteractionModel.updateOne({ id }, { $set: { traceRunId: trace.runId } }).exec()
  res.status(202).json({ runId: trace.runId })

  ;(async () => {
    try {
      await executeCommentOnPermalink(permalink, comment, username, trace as any)
      
      // Only mark as executed if we have explicit proof of successful comment posting
      const hasCommentPosted = (trace as any).steps?.some((step: any) => 
        step.name === 'comment_posted' && step.status === 'ok'
      )
      
      if (hasCommentPosted) {
        // Definitive success - clear from moderation queue
        await InteractionModel.updateOne({ id }, { 
          $set: { state: 'executed', executedAt: new Date() } 
        }).exec()
        // Mark related approval items as executed too
        await ApprovalItemModel.updateMany({ interactionId: id }, { $set: { state: 'executed' } }).exec()
        console.log(`[moderation] ${id} marked as executed - comment verified ✅`)
      } else {
        // Failed or incomplete - keep retryable, don't clear from queue
        const errorStep = (trace as any).steps?.find((step: any) => step.status === 'error')
        const failureReason = errorStep?.notes || (trace as any).error?.message || 'unknown'
        await InteractionModel.updateOne({ id }, { $set: { state: 'failed' } }).exec()
        // Ensure approval item remains in moderation queue (pending_review)
        await ApprovalItemModel.updateMany({ interactionId: id, state: { $ne: 'executed' } }, { $set: { state: 'pending_review', notes: failureReason } }).exec()
        console.log(`[moderation] ${id} execution failed, keeping in moderation for retry - ${failureReason} ❌`)
      }
    } catch (e) {
      // Network/system error - keep retryable
      await InteractionModel.updateOne({ id }, { $set: { state: 'failed' } }).exec()
      // Ensure approval item returns to moderation queue
      await ApprovalItemModel.updateMany({ interactionId: id, state: { $ne: 'executed' } }, { $set: { state: 'pending_review', notes: (e as Error)?.message || 'system_error' } }).exec()
      console.log(`[moderation] ${id} system error, keeping in moderation for retry - ${(e as Error)?.message} ❌`)
    }
  })()
})


hitlRouter.get('/styles', requireRole('viewer'), async (req: Request, res: Response): Promise<void> => {
  const { q, page, pageSize, paged } = req.query as any
  const filter: any = {}
  if (q) {
    const rx = { $regex: String(q), $options: 'i' }
    filter.$or = [{ name: rx }, { persona: rx }]
  }

  if (!paged && !page && !pageSize) {
    const rows = await ResponseStyleModel.find(filter).sort({ updatedAt: -1 }).lean()
    res.json(rows)
    return
  }

  const limit = Math.min(Number(pageSize) || 50, 200)
  const p = Math.max(1, Number(page) || 1)
  const skip = (p - 1) * limit
  const [items, total] = await Promise.all([
    ResponseStyleModel.find(filter).sort({ updatedAt: -1 }).skip(skip).limit(limit).lean(),
    ResponseStyleModel.countDocuments(filter),
  ])
  res.json({ items, total, page: p, pageSize: limit })
  return
})

hitlRouter.post('/styles', requireRole('admin'), async (req: Request, res: Response) => {
  const doc = await new ResponseStyleModel(req.body).save();
  res.json(doc);
});

// Update a response style
hitlRouter.put('/styles/:id', requireRole('admin'), async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params
  const update = req.body
  const doc = await ResponseStyleModel.findOneAndUpdate({ id }, update, { new: true, lean: true })
  if (!doc) {
    res.status(404).json({ error: 'style_not_found' })
    return
  }
  res.json(doc)
  return
})

// Delete a response style
hitlRouter.delete('/styles/:id', requireRole('admin'), async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params
  const result = await ResponseStyleModel.deleteOne({ id })
  if (result.deletedCount === 0) {
    res.status(404).json({ error: 'style_not_found' })
    return
  }
  res.json({ ok: true })
  return
})

hitlRouter.get('/moderation/items', requireRole('moderator'), async (req: Request, res: Response) => {
  const { state = 'pending_review', accountId } = req.query as any;
  const q: any = { state };
  if (accountId) q.accountId = accountId;
  const approvals = await ApprovalItemModel.aggregate([
    { $match: q },
    { $sort: { updatedAt: -1 } },
    { $limit: 200 },
    { $lookup: { from: 'interactions', localField: 'interactionId', foreignField: 'id', as: 'interaction' } },
    { $unwind: '$interaction' },
  ]);
  res.json(approvals);
});

hitlRouter.post('/moderation/:id/approve', requireRole('moderator'), async (req: Request & { user?: any }, res: Response) => {
  res.json(await approveItem(req.params.id, req.user?.id || 'system', req.body?.notes));
});

hitlRouter.post('/moderation/:id/deny', requireRole('moderator'), async (req: Request & { user?: any }, res: Response) => {
  res.json(await denyItem(req.params.id, req.user?.id || 'system', req.body?.notes));
});

hitlRouter.post('/moderation/:id/revise', requireRole('moderator'), async (req: Request & { user?: any }, res: Response) => {
  res.json(await reviseItem(req.params.id, req.user?.id || 'system', req.body?.text, req.body?.styleId, req.body?.notes));
});

hitlRouter.post('/moderation/:id/schedule', requireRole('moderator'), async (req: Request & { user?: any }, res: Response) => {
  res.json(await scheduleItem(req.params.id, req.user?.id || 'system', new Date(req.body.runAt)));
});

// Create an account
hitlRouter.post('/accounts', requireRole('admin'), async (req: Request, res: Response): Promise<void> => {
  const payload = req.body
  if (!payload?.id || !payload?.username) {
    res.status(400).json({ error: 'id_and_username_required' })
    return
  }
  const existing = await AccountModel.findOne({ id: payload.id }).lean()
  if (existing) {
    res.status(409).json({ error: 'account_exists' })
    return
  }
  const doc = await new AccountModel(payload).save()
  res.status(201).json(doc)
  return
})

// Update an account
hitlRouter.put('/accounts/:id', requireRole('admin'), async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params
  const update = req.body
  const doc = await AccountModel.findOneAndUpdate({ id }, update, { new: true, lean: true })
  if (!doc) {
    res.status(404).json({ error: 'account_not_found' })
    return
  }
  res.json(doc)
  return
})

// Delete an account
hitlRouter.delete('/accounts/:id', requireRole('admin'), async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params
  const result = await AccountModel.deleteOne({ id })
  if (result.deletedCount === 0) {
    res.status(404).json({ error: 'account_not_found' })
    return
  }
  res.json({ ok: true })
  return
})
