import mongoose, { Schema } from 'mongoose';
import type { TraceRecord } from './types';

const TraceSchema = new Schema<TraceRecord>(
  {
    runId: { type: String, index: true, unique: true },
    jobId: { type: String, index: true },
    action: String,
    target: { username: String, postId: String, permalink: String },
    status: { type: String, index: true },
    startedAt: { type: String, index: true },
    endedAt: String,
    durationMs: Number,
    env: Schema.Types.Mixed,
    build: { commit: String, branch: String, version: String, node: String },
    session: { cookieFile: String, cookieSha256: String },
    links: Schema.Types.Mixed,
    steps: [{ stepId: String, name: String, status: String, ms: Number, notes: String }],
    error: Schema.Types.Mixed,
    metrics: Schema.Types.Mixed,
  },
  { minimize: false }
);

TraceSchema.index({ startedAt: -1 });

export const TraceModel = mongoose.models.Trace || mongoose.model<TraceRecord>('Trace', TraceSchema);

export async function saveTrace(t: TraceRecord) {
  await TraceModel.updateOne({ runId: t.runId }, t, { upsert: true });
}

export async function getTrace(runId: string) {
  return TraceModel.findOne({ runId }).lean<TraceRecord>().exec();
}

export async function listRunsByJob(jobId: string, limit = 50) {
  return TraceModel.find({ jobId }).sort({ startedAt: -1 }).limit(limit).select({ steps: 0, env: 0 }).lean().exec();
}

export async function listRecent(limit = 50) {
  return TraceModel.find().sort({ startedAt: -1 }).limit(limit).select({ steps: 0, env: 0 }).lean().exec();
}
