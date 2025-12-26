import crypto from 'node:crypto';
import { ApprovalItemModel, InteractionModel, AuditLogModel } from './models';

const id = (p: string) => `${p}_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;

export async function createProposedInteraction(input: any) {
  const interactionId = id('int');
  const approvalId = id('apr');
  const requiresReview = !!input.requiresReview;

  const interaction = await new InteractionModel({
    id: interactionId,
    accountId: input.accountId,
    type: input.type,
    target: input.target,
    proposed: input.proposed,
    state: requiresReview ? 'pending_review' : 'approved',
    scores: input.scores || {},
  }).save();

  const approval: any = await new ApprovalItemModel({
    id: approvalId,
    interactionId,
    state: requiresReview ? 'pending_review' : 'approved',
  }).save();

  await AuditLogModel.create({ id: id('audit'), entity: 'interaction', entityId: interactionId, action: 'propose', actorId: 'system', diff: input });

  return { interaction, approval };
}

export async function approveItem(approvalId: string, userId: string, notes?: string) {
  const apr = await ApprovalItemModel.findOneAndUpdate({ id: approvalId }, { state: 'approved', reviewerId: userId, notes }, { new: true });
  const intx = await InteractionModel.findOne({ id: apr?.interactionId });
  if (intx) {
    intx.state = 'approved';
    if (!intx.decided?.text && intx.proposed?.text) intx.decided = { ...(intx.decided || {}), text: intx.proposed.text, styleId: intx.proposed.styleId, mediaIds: intx.proposed.mediaIds };
    await intx.save();
  }
  await AuditLogModel.create({ id: id('audit'), entity: 'approval', entityId: apr?.id, action: 'approve', actorId: userId, diff: { notes } });
  return { approval: apr, interaction: intx };
}

export async function denyItem(approvalId: string, userId: string, notes?: string) {
  const apr = await ApprovalItemModel.findOneAndUpdate({ id: approvalId }, { state: 'denied', reviewerId: userId, notes }, { new: true });
  const intx = await InteractionModel.findOneAndUpdate({ id: apr?.interactionId }, { state: 'denied' }, { new: true });
  await AuditLogModel.create({ id: id('audit'), entity: 'approval', entityId: apr?.id, action: 'deny', actorId: userId, diff: { notes } });
  return { approval: apr, interaction: intx };
}

export async function reviseItem(approvalId: string, userId: string, text?: string, styleId?: string, notes?: string) {
  const apr = await ApprovalItemModel.findOne({ id: approvalId });
  const intx = await InteractionModel.findOne({ id: apr?.interactionId });
  if (intx) {
    intx.decided = { ...(intx.decided || {}), text: text ?? intx.decided?.text ?? intx.proposed?.text, styleId: styleId ?? intx.decided?.styleId ?? intx.proposed?.styleId };
    intx.state = 'pending_review';
    await intx.save();
  }
  if (apr) {
    apr.state = 'pending_review';
    apr.reviewerId = userId;
    apr.notes = notes;
    await apr.save();
  }
  await AuditLogModel.create({ id: id('audit'), entity: 'interaction', entityId: intx?.id, action: 'revise', actorId: userId, diff: { text, styleId, notes } });
  return { approval: apr, interaction: intx };
}

export async function scheduleItem(approvalId: string, userId: string, runAt: Date) {
  const apr = await ApprovalItemModel.findOneAndUpdate({ id: approvalId }, { state: 'scheduled', reviewerId: userId }, { new: true });
  const intx = await InteractionModel.findOneAndUpdate({ id: apr?.interactionId }, { state: 'scheduled', scheduleAt: runAt }, { new: true });
  await AuditLogModel.create({ id: id('audit'), entity: 'interaction', entityId: intx?.id, action: 'schedule', actorId: userId, diff: { runAt } });
  return { approval: apr, interaction: intx };
}
