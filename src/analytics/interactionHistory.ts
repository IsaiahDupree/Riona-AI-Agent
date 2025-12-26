import { Schema, model, Document } from 'mongoose'

export interface IInteractionHistory extends Document {
  runId: string
  accountId: string
  interactionType: 'comment' | 'like' | 'follow' | 'unfollow' | 'story_view' | 'dm'
  targetUser: string
  targetPost?: string
  content?: string
  responseStyle?: string
  metadata: {
    timestamp: Date
    success: boolean
    errorMessage?: string
    responseTime: number
    rateLimitDelay?: number
    userEngagement?: {
      likes: number
      comments: number
      followers: number
      following: number
    }
    contentMetrics?: {
      length: number
      emojis: number
      hashtags: number
      mentions: number
    }
  }
  createdAt: Date
  updatedAt: Date
}

const InteractionHistorySchema = new Schema<IInteractionHistory>({
  runId: { type: String, required: true, index: true },
  accountId: { type: String, required: true, index: true },
  interactionType: {
    type: String,
    required: true,
    enum: ['comment', 'like', 'follow', 'unfollow', 'story_view', 'dm'],
    index: true
  },
  targetUser: { type: String, required: true, index: true },
  targetPost: { type: String, index: true },
  content: { type: String },
  responseStyle: { type: String, index: true },
  metadata: {
    timestamp: { type: Date, required: true },
    success: { type: Boolean, required: true, index: true },
    errorMessage: { type: String },
    responseTime: { type: Number, required: true },
    rateLimitDelay: { type: Number },
    userEngagement: {
      likes: { type: Number },
      comments: { type: Number },
      followers: { type: Number },
      following: { type: Number }
    },
    contentMetrics: {
      length: { type: Number },
      emojis: { type: Number },
      hashtags: { type: Number },
      mentions: { type: Number }
    }
  },
  createdAt: { type: Date, default: Date.now, index: true },
  updatedAt: { type: Date, default: Date.now }
})

// Compound indexes for common queries
InteractionHistorySchema.index({ accountId: 1, createdAt: -1 })
InteractionHistorySchema.index({ targetUser: 1, createdAt: -1 })
InteractionHistorySchema.index({ interactionType: 1, createdAt: -1 })
InteractionHistorySchema.index({ 'metadata.success': 1, createdAt: -1 })

export const InteractionHistory = model<IInteractionHistory>('InteractionHistory', InteractionHistorySchema)

// Service functions for interaction history
export class InteractionHistoryService {
  
  /**
   * Record a new interaction
   */
  static async recordInteraction(data: {
    runId: string
    accountId: string
    interactionType: IInteractionHistory['interactionType']
    targetUser: string
    targetPost?: string
    content?: string
    responseStyle?: string
    success: boolean
    errorMessage?: string
    responseTime: number
    rateLimitDelay?: number
    userEngagement?: IInteractionHistory['metadata']['userEngagement']
  }): Promise<IInteractionHistory> {
    const contentMetrics = data.content ? this.analyzeContent(data.content) : undefined
    
    const interaction = new InteractionHistory({
      runId: data.runId,
      accountId: data.accountId,
      interactionType: data.interactionType,
      targetUser: data.targetUser,
      targetPost: data.targetPost,
      content: data.content,
      responseStyle: data.responseStyle,
      metadata: {
        timestamp: new Date(),
        success: data.success,
        errorMessage: data.errorMessage,
        responseTime: data.responseTime,
        rateLimitDelay: data.rateLimitDelay,
        userEngagement: data.userEngagement,
        contentMetrics
      }
    })
    
    return await interaction.save()
  }
  
  /**
   * Get interaction history for an account
   */
  static async getAccountHistory(
    accountId: string, 
    options: {
      limit?: number
      offset?: number
      interactionType?: string
      dateFrom?: Date
      dateTo?: Date
    } = {}
  ): Promise<IInteractionHistory[]> {
    const query: any = { accountId }
    
    if (options.interactionType) {
      query.interactionType = options.interactionType
    }
    
    if (options.dateFrom || options.dateTo) {
      query.createdAt = {}
      if (options.dateFrom) query.createdAt.$gte = options.dateFrom
      if (options.dateTo) query.createdAt.$lte = options.dateTo
    }
    
    return await InteractionHistory
      .find(query)
      .sort({ createdAt: -1 })
      .limit(options.limit || 100)
      .skip(options.offset || 0)
      .exec()
  }
  
  /**
   * Get engagement analytics for a user
   */
  static async getUserEngagementAnalytics(targetUser: string): Promise<{
    totalInteractions: number
    interactionsByType: Record<string, number>
    successRate: number
    avgResponseTime: number
    recentActivity: IInteractionHistory[]
    engagementTrend: {
      period: string
      interactions: number
      successRate: number
    }[]
    topPerformingContent: any[]
  }> {
    const interactions = await InteractionHistory.find({ targetUser }).exec()
    
    const analytics = {
      totalInteractions: 0,
      successfulInteractions: 0,
      failedInteractions: 0,
      averageResponseTime: 0,
      interactionsByType: {} as Record<string, number>,
      recentActivity: [] as any[],
      engagementTrend: [] as any[],
      topPerformingContent: []
    }
    
    if (interactions.length === 0) {
      return {
        totalInteractions: 0,
        interactionsByType: {},
        successRate: 0,
        avgResponseTime: 0,
        recentActivity: [],
        engagementTrend: [],
        topPerformingContent: []
      }
    }
    
    // Calculate interaction types
    interactions.forEach(interaction => {
      const type = interaction.interactionType
      analytics.interactionsByType[type] = (analytics.interactionsByType[type] || 0) + 1
    })
    
    // Calculate success rate
    const successfulInteractions = interactions.filter(i => i.metadata.success)
    analytics.successfulInteractions = successfulInteractions.length
    analytics.failedInteractions = interactions.length - successfulInteractions.length
    analytics.averageResponseTime = interactions.reduce((sum, i) => sum + i.metadata.responseTime, 0) / interactions.length
    
    // Get recent activity (last 10 interactions)
    analytics.recentActivity = await InteractionHistory
      .find({ targetUser })
      .sort({ createdAt: -1 })
      .limit(10)
      .exec()
    
    // Calculate engagement trend (last 7 days)
    const now = new Date()
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
    
    for (let i = 0; i < 7; i++) {
      const date = new Date(sevenDaysAgo.getTime() + i * 24 * 60 * 60 * 1000)
      const nextDate = new Date(date.getTime() + 24 * 60 * 60 * 1000)
      
      const dayInteractions = interactions.filter(interaction => 
        interaction.createdAt >= date && interaction.createdAt < nextDate
      )
      
      const daySuccessful = dayInteractions.filter(i => i.metadata.success)
      
      analytics.engagementTrend.push({
        period: date.toISOString().split('T')[0],
        interactions: dayInteractions.length,
        successRate: dayInteractions.length > 0 ? (daySuccessful.length / dayInteractions.length) * 100 : 0
      })
    }
    
    return {
      totalInteractions: analytics.totalInteractions,
      interactionsByType: analytics.interactionsByType,
      successRate: analytics.successfulInteractions / analytics.totalInteractions * 100,
      avgResponseTime: analytics.averageResponseTime,
      recentActivity: analytics.recentActivity,
      engagementTrend: analytics.engagementTrend,
      topPerformingContent: analytics.topPerformingContent
    }
  }
  
  /**
   * Get performance metrics for an account
   */
  static async getAccountMetrics(
    accountId: string,
    timeframe: 'day' | 'week' | 'month' = 'week'
  ): Promise<{
    totalInteractions: number
    successfulInteractions: number
    failedInteractions: number
    averageResponseTime: number
    interactionsByType: Record<string, number>
    timeSeriesData: {
      date: string
      interactions: number
      success: number
      errors: number
    }[]
    engagementMetrics: {
      likes: number
      comments: number
      follows: number
      shares: number
    }
  }> {
    const now = new Date()
    let dateFrom: Date
    let groupByFormat: string
    
    switch (timeframe) {
      case 'day':
        dateFrom = new Date(now.getTime() - 24 * 60 * 60 * 1000)
        groupByFormat = '%Y-%m-%d %H:00:00'
        break
      case 'month':
        dateFrom = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
        groupByFormat = '%Y-%m-%d'
        break
      default: // week
        dateFrom = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
        groupByFormat = '%Y-%m-%d'
    }
    
    const interactions = await InteractionHistory.find({
      accountId,
      createdAt: { $gte: dateFrom }
    }).exec()
    
    const metrics = {
      totalInteractions: 0,
      successfulInteractions: 0,
      failedInteractions: 0,
      averageResponseTime: 0,
      interactionsByType: {} as Record<string, number>,
      timeSeriesData: [] as any[],
      engagementMetrics: {
        likes: 0,
        comments: 0,
        follows: 0,
        shares: 0
      }
    }
    
    if (interactions.length === 0) return metrics
    
    // Calculate basic metrics
    const successfulInteractions = interactions.filter(i => i.metadata.success)
    metrics.successfulInteractions = successfulInteractions.length
    metrics.failedInteractions = interactions.length - successfulInteractions.length
    metrics.averageResponseTime = interactions.reduce((sum, i) => sum + i.metadata.responseTime, 0) / interactions.length
    
    // Group by interaction type
    interactions.forEach(interaction => {
      const type = interaction.interactionType
      metrics.interactionsByType[type] = (metrics.interactionsByType[type] || 0) + 1
    })
    
    // Generate time series data
    const timeSeriesMap = new Map()
    
    interactions.forEach(interaction => {
      const dateKey = interaction.createdAt.toISOString().split('T')[0]
      if (!timeSeriesMap.has(dateKey)) {
        timeSeriesMap.set(dateKey, { interactions: 0, success: 0, errors: 0 })
      }
      
      const data = timeSeriesMap.get(dateKey)
      data.interactions++
      if (interaction.metadata.success) {
        data.success++
      } else {
        data.errors++
      }
    })
    
    metrics.timeSeriesData = Array.from(timeSeriesMap.entries()).map(([date, data]) => ({
      date,
      ...data
    })).sort((a, b) => a.date.localeCompare(b.date))
    
    return metrics
  }
  
  /**
   * Analyze content metrics
   */
  private static analyzeContent(content: string): IInteractionHistory['metadata']['contentMetrics'] {
    const emojiRegex = /[\u{1F600}-\u{1F64F}]|[\u{1F300}-\u{1F5FF}]|[\u{1F680}-\u{1F6FF}]|[\u{1F1E0}-\u{1F1FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/gu
    const hashtagRegex = /#\w+/g
    const mentionRegex = /@\w+/g
    
    return {
      length: content.length,
      emojis: (content.match(emojiRegex) || []).length,
      hashtags: (content.match(hashtagRegex) || []).length,
      mentions: (content.match(mentionRegex) || []).length
    }
  }
  
  /**
   * Clean up old interaction history
   */
  static async cleanupOldHistory(daysToKeep: number = 90): Promise<number> {
    const cutoffDate = new Date()
    cutoffDate.setDate(cutoffDate.getDate() - daysToKeep)
    
    const result = await InteractionHistory.deleteMany({
      createdAt: { $lt: cutoffDate }
    })
    
    return result.deletedCount || 0
  }
}
