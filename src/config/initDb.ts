import mongoose from 'mongoose'
// import { TraceRecordModel } from '../trace/store' // Commented out for skeleton
import { AccountModel, ResponseStyleModel, InteractionModel, ApprovalItemModel, AuditLogModel } from '../hitl/models'
import { InteractionHistory } from '../analytics/interactionHistory'
import { ScheduledInteraction } from '../scheduling/scheduler'

/**
 * Initialize database collections and indexes
 */
export async function initializeDatabase(): Promise<void> {
  try {
    console.log('Initializing database...')
    
    // Create indexes for trace records
    await createTraceIndexes()
    
    // Create indexes for HITL collections
    await createHITLIndexes()
    
    // Create indexes for analytics collections
    await createAnalyticsIndexes()
    
    // Create indexes for scheduling collections
    await createSchedulingIndexes()
    
    // Seed default data
    await seedDefaultData()
    
    console.log('Database initialization completed successfully')
    
  } catch (error) {
    console.error('Database initialization failed:', error)
    throw error
  }
}

/**
 * Create indexes for trace records
 */
async function createTraceIndexes(): Promise<void> {
  console.log('Skipping trace indexes for skeleton setup')
  // Trace functionality disabled for skeleton
}

/**
 * Create indexes for HITL collections
 */
async function createHITLIndexes(): Promise<void> {
  console.log('Creating HITL indexes...')
  
  // Account indexes
  await AccountModel.collection.createIndex({ id: 1 }, { unique: true })
  await AccountModel.collection.createIndex({ username: 1 }, { unique: true })
  await AccountModel.collection.createIndex({ status: 1 })
  
  // ResponseStyle indexes
  await ResponseStyleModel.collection.createIndex({ id: 1 }, { unique: true })
  await ResponseStyleModel.collection.createIndex({ name: 1 })
  
  // Interaction indexes
  await InteractionModel.collection.createIndex({ id: 1 }, { unique: true })
  await InteractionModel.collection.createIndex({ accountId: 1, type: 1, state: 1, updatedAt: -1 })
  await InteractionModel.collection.createIndex({ state: 1, scheduleAt: 1 })
  await InteractionModel.collection.createIndex({ 'target.username': 1 })
  await InteractionModel.collection.createIndex({ traceRunId: 1 })
  
  // ApprovalItem indexes
  await ApprovalItemModel.collection.createIndex({ id: 1 }, { unique: true })
  await ApprovalItemModel.collection.createIndex({ interactionId: 1 })
  await ApprovalItemModel.collection.createIndex({ state: 1, updatedAt: -1 })
  await ApprovalItemModel.collection.createIndex({ reviewerId: 1 })
  // Ensure there is NO TTL index so moderation tasks persist
  try {
    const indexes = await ApprovalItemModel.collection.indexes()
    const ttl = indexes.find(ix => ix.name === 'expiresAt_1')
    if (ttl) {
      console.log('Dropping TTL index on ApprovalItem.expiresAt to persist moderation tasks')
      await ApprovalItemModel.collection.dropIndex('expiresAt_1')
    }
  } catch (e) {
    console.warn('Could not inspect/drop ApprovalItem TTL index:', e)
  }
  
  // AuditLog indexes
  await AuditLogModel.collection.createIndex({ id: 1 }, { unique: true })
  await AuditLogModel.collection.createIndex({ entity: 1, entityId: 1, createdAt: -1 })
  await AuditLogModel.collection.createIndex({ actorId: 1, createdAt: -1 })
  await AuditLogModel.collection.createIndex({ createdAt: -1 })
}

/**
 * Create indexes for analytics collections
 */
async function createAnalyticsIndexes(): Promise<void> {
  console.log('Creating analytics indexes...')
  
  // InteractionHistory indexes
  await InteractionHistory.collection.createIndex({ runId: 1 })
  await InteractionHistory.collection.createIndex({ accountId: 1, createdAt: -1 })
  await InteractionHistory.collection.createIndex({ targetUser: 1, createdAt: -1 })
  await InteractionHistory.collection.createIndex({ interactionType: 1, createdAt: -1 })
  await InteractionHistory.collection.createIndex({ 'metadata.success': 1, createdAt: -1 })
}

/**
 * Create indexes for scheduling collections
 */
async function createSchedulingIndexes(): Promise<void> {
  console.log('Creating scheduling indexes...')
  
  // ScheduledInteraction indexes
  await ScheduledInteraction.collection.createIndex({ approvalItemId: 1 })
  await ScheduledInteraction.collection.createIndex({ accountId: 1 })
  await ScheduledInteraction.collection.createIndex({ targetUser: 1 })
  await ScheduledInteraction.collection.createIndex({ scheduledTime: 1 })
  await ScheduledInteraction.collection.createIndex({ status: 1 })
  await ScheduledInteraction.collection.createIndex({ priority: 1 })
  await ScheduledInteraction.collection.createIndex({ status: 1, scheduledTime: 1 })
  await ScheduledInteraction.collection.createIndex({ accountId: 1, status: 1, scheduledTime: 1 })
  await ScheduledInteraction.collection.createIndex({ priority: 1, scheduledTime: 1 })
}

/**
 * Seed default data
 */
async function seedDefaultData(): Promise<void> {
  console.log('Seeding default data...')
  
  // Create default response styles if none exist
  const styleCount = await ResponseStyleModel.countDocuments()
  if (styleCount === 0) {
    await createDefaultResponseStyles()
  }
}

/**
 * Create default response styles
 */
async function createDefaultResponseStyles(): Promise<void> {
  const defaultStyles = [
    {
      id: 'casual_friendly',
      name: 'Casual & Friendly',
      persona: 'A friendly, casual commenter who uses simple language and positive vibes',
      rules: [
        'Keep comments short and natural (10-50 characters)',
        'Use casual language like "Nice!", "Love this!", "Amazing work!"',
        'Occasionally use emojis but not excessively',
        'Avoid formal language or business speak'
      ],
      maxLen: 50,
      emojis: true,
      hashtags: false
    },
    {
      id: 'professional_supportive',
      name: 'Professional & Supportive',
      persona: 'A professional who provides thoughtful, supportive comments',
      rules: [
        'Write thoughtful, constructive comments (20-100 characters)',
        'Focus on encouragement and positive feedback',
        'Use proper grammar and punctuation',
        'Avoid slang or overly casual language'
      ],
      maxLen: 100,
      emojis: false,
      hashtags: false
    },
    {
      id: 'enthusiastic_fan',
      name: 'Enthusiastic Fan',
      persona: 'An excited fan who loves engaging with content',
      rules: [
        'Show genuine excitement and enthusiasm',
        'Use exclamation points and positive language',
        'Can be slightly longer comments (15-80 characters)',
        'Use emojis to express emotions'
      ],
      maxLen: 80,
      emojis: true,
      hashtags: false
    }
  ]

  for (const style of defaultStyles) {
    await new ResponseStyleModel(style).save()
    console.log(`Created default response style: ${style.name}`)
  }
}
