import crypto from 'crypto';
import fs from 'fs';
import { logger } from '../utils/logger';
import { getBuildInfo } from './build-info';
import { doc, techDoc, howItWorks, srcAt, artifact, pm2App, logsLive, logsTailApi } from './linkResolver';
import type { TraceRecord, TraceStep } from './types';

function newId(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

function sha256File(path?: string) {
  try {
    if (path && fs.existsSync(path)) {
      return crypto.createHash('sha256').update(fs.readFileSync(path)).digest('hex');
    }
  } catch {
    // ignore
  }
  return undefined;
}

export function startRun(opts: { action: string; jobId?: string; target?: TraceRecord['target']; cookieFile?: string }): TraceRecord {
  const runId = newId('run');
  const build = getBuildInfo();

  const trace: TraceRecord = {
    runId,
    jobId: opts.jobId,
    action: opts.action,
    target: opts.target,
    status: 'running',
    startedAt: new Date().toISOString(),
    env: { NODE_ENV: process.env.NODE_ENV, HOST: process.env.HOSTNAME || process.env.COMPUTERNAME, pid: process.pid },
    build: { commit: build.commit, branch: build.branch, version: build.version, node: build.node },
    session: { cookieFile: opts.cookieFile, cookieSha256: sha256File(opts.cookieFile) },
    links: {
      docs: [
        { title: 'How It Works', url: howItWorks() },
        { title: 'Logging & Monitoring', url: techDoc('06-logging-and-monitoring.md') },
        { title: 'Monitoring & Scheduling', url: techDoc('07-monitoring-and-scheduling.md') },
      ],
      code: [
        { title: 'Entrypoint', url: srcAt('src/index.ts', build.commit) },
        { title: 'Instagram Client', url: srcAt('src/client/Instagram-AI.ts', build.commit) },
      ],
      logs: { live: logsLive('instagram-scheduler'), tail: '' },
      artifacts: [],
      scheduler: { pm2: pm2App('instagram-scheduler'), windows: 'start-agent.ps1' },
    },
    steps: [],
    error: null,
    metrics: {},
  };

  trace.links.logs!.tail = logsTailApi(runId);
  logger.info(`run.start ${trace.action} ${trace.runId}`);
  return trace;
}

export function pushStep(trace: TraceRecord, step: Omit<TraceStep, 'stepId'>) {
  const s = { stepId: newId('st'), ...step };
  trace.steps.push(s);
  logger.info(`run.step ${trace.runId} ${s.name} ${s.status}`);
}

export function finishRun(trace: TraceRecord, ok: boolean, extra?: Partial<TraceRecord>) {
  trace.endedAt = new Date().toISOString();
  trace.durationMs = new Date(trace.endedAt).getTime() - new Date(trace.startedAt).getTime();
  trace.status = ok ? 'succeeded' : 'failed';
  if (!ok && !trace.error) trace.error = { message: 'Unknown error' };
  Object.assign(trace, extra || {});
  trace.links.artifacts?.push({ title: 'after.png', url: artifact(trace.runId, 'after.png') });
  logger.info(`run.finish ${trace.runId} ${trace.status} ${trace.durationMs}ms`);
  return trace;
}
