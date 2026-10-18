import axios from 'axios';
import crypto from 'node:crypto';
import type { TraceRecord } from './types';

const HOOK = process.env.TRACE_WEBHOOK_URL;
const SECRET = process.env.TRACE_WEBHOOK_SECRET || '';

function sign(body: string) {
  return crypto.createHmac('sha256', SECRET).update(body).digest('hex');
}

export async function sendTraceEvent(type: 'run.updated' | 'run.completed', trace: TraceRecord) {
  if (!HOOK) return;
  const body = JSON.stringify({ type, payload: trace });
  try {
    await axios.post(HOOK, body, { headers: { 'content-type': 'application/json', 'x-signature': sign(body) } });
  } catch {
    // ignore webhook errors in skeleton
  }
}
