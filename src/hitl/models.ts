import mongoose, { Schema } from 'mongoose';

export type ActionType = 'comment' | 'like' | 'post';
export type ApprovalState = 'pending_review' | 'approved' | 'denied' | 'scheduled' | 'executed' | 'failed' | 'expired';

const AccountSchema = new Schema(
  {
    id: { type: String, unique: true, index: true },
    platform: { type: String, default: 'instagram', index: true },
    username: { type: String, index: true },
    status: { type: String, default: 'active' },
    proxyId: { type: String },
    hitlLevel: { type: String, default: 'soft' },
    preferences: {
      timeZone: { type: String, default: 'UTC' },
      dailyCommentLimit: { type: Number, default: 20 },
      workingHours: {
        start: { type: String, default: '09:00' },
        end: { type: String, default: '17:00' }
      },
      daysOfWeek: [{ type: Number, min: 0, max: 6 }], // 0=Sun
      allowCompetitor: { type: Boolean, default: true },
      competitorUsernames: [{ type: String }],
      brandKeywords: [{ type: String }],
      audienceKeywords: [{ type: String }],
      minQualityScore: { type: Number, default: 0 }
    }
  },
  { timestamps: true }
);

const ResponseStyleSchema = new Schema(
  {
    id: { type: String, unique: true, index: true },
    name: String,
    persona: String,
    rules: [String],
    maxLen: Number,
    emojis: { type: Boolean, default: true },
    hashtags: { type: Boolean, default: false },
  },
  { timestamps: true }
);

const InteractionSchema = new Schema(
  {
    id: { type: String, unique: true, index: true },
    accountId: { type: String, index: true },
    type: { type: String, enum: ['comment', 'like', 'post'], index: true },
    target: { username: String, postId: String, permalink: String },
    proposed: { text: String, mediaIds: [String], styleId: String, reasons: [String] },
    decided: { text: String, mediaIds: [String], styleId: String },
    state: { type: String, enum: ['pending_review', 'approved', 'denied', 'scheduled', 'executed', 'failed', 'expired'], index: true },
    scores: { toxicity: Number, similarity: Number, quality: Number, brandFit: Number, audienceFit: Number, competitor: Boolean },
    scheduleAt: Date,
    executedAt: Date,
    traceRunId: String,
  },
  { timestamps: true }
);
InteractionSchema.index({ accountId: 1, type: 1, state: 1, updatedAt: -1 });

const ApprovalItemSchema = new Schema(
  {
    id: { type: String, unique: true, index: true },
    interactionId: { type: String, index: true },
    state: { type: String, enum: ['pending_review', 'approved', 'denied', 'scheduled', 'executed', 'failed', 'expired'], index: true },
    reviewerId: { type: String },
    notes: String,
    lock: { by: String, until: Date },
    expiresAt: Date,
  },
  { timestamps: true }
);

const AuditLogSchema = new Schema(
  {
    id: { type: String, unique: true, index: true },
    entity: { type: String, enum: ['interaction', 'approval', 'account', 'style'], index: true },
    entityId: { type: String, index: true },
    action: String,
    actorId: String,
    diff: Schema.Types.Mixed,
  },
  { timestamps: true }
);

export const AccountModel = mongoose.models.Account || mongoose.model('Account', AccountSchema);
export const ResponseStyleModel = mongoose.models.ResponseStyle || mongoose.model('ResponseStyle', ResponseStyleSchema);
export const InteractionModel = mongoose.models.Interaction || mongoose.model('Interaction', InteractionSchema);
export const ApprovalItemModel = mongoose.models.ApprovalItem || mongoose.model('ApprovalItem', ApprovalItemSchema);
export const AuditLogModel = mongoose.models.AuditLog || mongoose.model('AuditLog', AuditLogSchema);
