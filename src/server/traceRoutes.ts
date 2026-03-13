import express, { Request, Response, RequestHandler } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { getTrace, listRunsByJob, listRecent, saveTrace } from '../trace/store';
import { startRun, pushStep, finishRun } from '../trace/runtime';
import { runInstagram } from '../client/Instagram-AI';
import { logger } from '../utils/logger';

export const traceRouter = express.Router();

traceRouter.get('/runs/:runId', (async (req: Request, res: Response) => {
  const t = await getTrace(req.params.runId);
  if (!t) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  res.json(t);
}) as unknown as RequestHandler);

// Start a demo run and simulate steps asynchronously
traceRouter.post('/runs/start', (async (req: Request, res: Response) => {
  const body = (req.body || {}) as any
  const action = body.action || 'demo_run'
  const target = body.target

  const trace = startRun({ action, target })
  await saveTrace(trace)

  // Simulate steps and completion
  setTimeout(async () => {
    try {
      pushStep(trace, { name: 'init', status: 'ok', ms: 120 })
      await saveTrace(trace)
    } catch (e) { logger.debug(`[trace] Step save failed: ${e}`); }
  }, 300)

  setTimeout(async () => {
    try {
      pushStep(trace, { name: 'work', status: 'ok', ms: 900 })
      await saveTrace(trace)
    } catch (e) { logger.debug(`[trace] Step save failed: ${e}`); }
  }, 900)

  setTimeout(async () => {
    try {
      const finished = finishRun(trace, true)
      await saveTrace(finished)
    } catch (e) { logger.debug(`[trace] Step save failed: ${e}`); }
  }, 1600)

  res.json({ runId: trace.runId })
}) as unknown as RequestHandler);

traceRouter.get('/jobs/:jobId/runs', (async (req: Request, res: Response) => {
  const limit = Number(req.query.limit) || 50;
  const rows = await listRunsByJob(req.params.jobId, limit);
  res.json(rows);
}) as unknown as RequestHandler);

traceRouter.get('/recent', (async (req: Request, res: Response) => {
  const limit = Number(req.query.limit) || 50;
  const rows = await listRecent(limit);
  res.json(rows);
}) as unknown as RequestHandler);

// Serve artifacts stored on disk under artifacts/<runId>/<name>
traceRouter.get('/artifacts/:runId/:name', (async (req: Request, res: Response) => {
  const { runId, name } = req.params as any
  const filePath = path.join(process.cwd(), 'artifacts', runId, name)
  if (!fs.existsSync(filePath)) {
    res.status(404).end()
    return
  }
  res.sendFile(filePath)
}) as unknown as RequestHandler);

// Start a full Instagram automation run (browser automation) asynchronously
traceRouter.post('/runs/start-full', (async (req: Request, res: Response) => {
  const body = (req.body || {}) as any
  const username = process.env.INSTAGRAM_BOT_USERNAME || body.username

  const trace = startRun({ action: 'instagram_automation', target: { username }, cookieFile: './cookies.json' })
  await saveTrace(trace)
  res.status(202).json({ runId: trace.runId })

  // Kick off the automation without awaiting; it will update the trace as it proceeds
  ;(async () => {
    try {
      await runInstagram(trace)
    } catch (e) {
      try {
        pushStep(trace, { name: 'fatal_error', status: 'error', notes: (e as Error)?.message })
        finishRun(trace, false)
        await saveTrace(trace)
      } catch (traceErr) { logger.debug(`[trace] Fatal error trace save failed: ${traceErr}`); }
    }
  })()
}) as unknown as RequestHandler);

traceRouter.get('/logs/tail', (async (req: Request, res: Response) => {
  const runId = String(req.query.runId || '');
  const t = await getTrace(runId);
  if (!t) {
    res.status(404).json({ error: 'trace_not_found' });
    return;
  }

  const date = (t.startedAt || '').slice(0, 10);
  const logDir = process.env.LOG_DIR || './logs';
  const file = path.join(logDir, `combined-${date}.log`);
  if (!fs.existsSync(file)) {
    res.status(404).json({ error: 'log_not_found' });
    return;
  }

  const lines = Number(req.query.lines) || 150;
  const data = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).filter(Boolean);
  const filtered = data.filter((l) => l.includes(runId));
  const out = (filtered.length ? filtered : data).slice(-lines).join('\n');
  res.type('text/plain').send(out);
}) as unknown as RequestHandler);

export async function persistTrace(t: any) {
  await saveTrace(t);
}
