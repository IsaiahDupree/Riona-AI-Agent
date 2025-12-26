import { Schema, model, Document } from 'mongoose'
// import { IApprovalItem } from '../hitl/models' // Commented out for skeleton
import { InteractionHistoryService } from '../analytics/interactionHistory'

export interface IScheduledInteraction extends Document {
  approvalItemId: string
  accountId: string
  interactionType: 'comment' | 'like' | 'follow' | 'unfollow' | 'story_view' | 'dm'
  targetUser: string
  targetPost?: string
  content?: string
  responseStyle?: string
  scheduledTime: Date
  status: 'pending' | 'executing' | 'completed' | 'failed' | 'cancelled'
  priority: 'low' | 'medium' | 'high'
  retryCount: number
  maxRetries: number
  metadata: {
    createdBy: string
    scheduledBy: string
    executionAttempts: {
      timestamp: Date
      success: boolean
      errorMessage?: string
      responseTime?: number
    }[]
    constraints: {
      timeZone?: string
      workingHours?: {
        start: string // "09:00"
        end: string   // "17:00"
      }
      daysOfWeek?: number[] // [1,2,3,4,5] for Mon-Fri
      rateLimitRespect: boolean
      minimumDelay: number // minutes between interactions
    }
  }
  createdAt: Date
  updatedAt: Date
  executedAt?: Date
}

const ScheduledInteractionSchema = new Schema<IScheduledInteraction>({
  approvalItemId: { type: String, required: true, index: true },
  accountId: { type: String, required: true, index: true },
  interactionType: {
    type: String,
    required: true,
    enum: ['comment', 'like', 'follow', 'unfollow', 'story_view', 'dm']
  },
  targetUser: { type: String, required: true, index: true },
  targetPost: { type: String },
  content: { type: String },
  responseStyle: { type: String },
  scheduledTime: { type: Date, required: true, index: true },
  status: {
    type: String,
    required: true,
    enum: ['pending', 'executing', 'completed', 'failed', 'cancelled'],
    default: 'pending',
    index: true
  },
  priority: {
    type: String,
    required: true,
    enum: ['low', 'medium', 'high'],
    default: 'medium',
    index: true
  },
  retryCount: { type: Number, default: 0 },
  maxRetries: { type: Number, default: 3 },
  metadata: {
    createdBy: { type: String, required: true },
    scheduledBy: { type: String, required: true },
    executionAttempts: [{
      timestamp: { type: Date, required: true },
      success: { type: Boolean, required: true },
      errorMessage: { type: String },
      responseTime: { type: Number }
    }],
    constraints: {
      timeZone: { type: String, default: 'UTC' },
      workingHours: {
        start: { type: String, default: '09:00' },
        end: { type: String, default: '17:00' }
      },
      daysOfWeek: [{ type: Number, min: 0, max: 6 }], // 0=Sunday, 6=Saturday
      rateLimitRespect: { type: Boolean, default: true },
      minimumDelay: { type: Number, default: 5 } // minutes
    }
  },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
  executedAt: { type: Date }
})

// Compound indexes for efficient queries
ScheduledInteractionSchema.index({ status: 1, scheduledTime: 1 })
ScheduledInteractionSchema.index({ accountId: 1, status: 1, scheduledTime: 1 })
ScheduledInteractionSchema.index({ priority: 1, scheduledTime: 1 })

export const ScheduledInteraction = model<IScheduledInteraction>('ScheduledInteraction', ScheduledInteractionSchema)

export class SchedulingService {
  private static executionInterval: NodeJS.Timeout | null = null
  private static isRunning = false

  /**
   * Schedule an approved interaction
   */
  static async scheduleInteraction(data: {
    approvalItemId: string
    accountId: string
    interactionType: IScheduledInteraction['interactionType']
    targetUser: string
    targetPost?: string
    content?: string
    responseStyle?: string
    scheduledTime: Date
    priority?: IScheduledInteraction['priority']
    createdBy: string
    constraints?: Partial<IScheduledInteraction['metadata']['constraints']>
  }): Promise<IScheduledInteraction> {
    // Validate scheduled time is in the future
    if (data.scheduledTime <= new Date()) {
      throw new Error('Scheduled time must be in the future')
    }

    // Check for conflicts with existing scheduled interactions
    const conflicts = await this.checkForConflicts(data.accountId, data.scheduledTime)
    if (conflicts.length > 0) {
      const suggestedTime = await this.suggestAlternativeTime(data.accountId, data.scheduledTime)
      throw new Error(`Scheduling conflict detected. Suggested time: ${suggestedTime.toISOString()}`)
    }

    const scheduledInteraction = new ScheduledInteraction({
      approvalItemId: data.approvalItemId,
      accountId: data.accountId,
      interactionType: data.interactionType,
      targetUser: data.targetUser,
      targetPost: data.targetPost,
      content: data.content,
      responseStyle: data.responseStyle,
      scheduledTime: data.scheduledTime,
      priority: data.priority || 'medium',
      metadata: {
        createdBy: data.createdBy,
        scheduledBy: data.createdBy,
        executionAttempts: [],
        constraints: {
          timeZone: 'UTC',
          workingHours: { start: '09:00', end: '17:00' },
          daysOfWeek: [1, 2, 3, 4, 5], // Monday to Friday
          rateLimitRespect: true,
          minimumDelay: 5,
          ...data.constraints
        }
      }
    })

    return await scheduledInteraction.save()
  }

  /**
   * Get scheduled interactions
   */
  static async getScheduledInteractions(filters: {
    accountId?: string
    status?: IScheduledInteraction['status']
    priority?: IScheduledInteraction['priority']
    dateFrom?: Date
    dateTo?: Date
    limit?: number
    offset?: number
  } = {}): Promise<IScheduledInteraction[]> {
    const query: any = {}

    if (filters.accountId) query.accountId = filters.accountId
    if (filters.status) query.status = filters.status
    if (filters.priority) query.priority = filters.priority

    if (filters.dateFrom || filters.dateTo) {
      query.scheduledTime = {}
      if (filters.dateFrom) query.scheduledTime.$gte = filters.dateFrom
      if (filters.dateTo) query.scheduledTime.$lte = filters.dateTo
    }

    return await ScheduledInteraction
      .find(query)
      .sort({ scheduledTime: 1, priority: -1 })
      .limit(filters.limit || 100)
      .skip(filters.offset || 0)
      .exec()
  }

  /**
   * Update scheduled interaction
   */
  static async updateScheduledInteraction(
    interactionId: string,
    updates: Partial<IScheduledInteraction>,
    updatedBy: string
  ): Promise<IScheduledInteraction | null> {
    const interaction = await ScheduledInteraction.findById(interactionId)
    if (!interaction) return null

    // If rescheduling, check for conflicts
    if (updates.scheduledTime && updates.scheduledTime !== interaction.scheduledTime) {
      const conflicts = await this.checkForConflicts(interaction.accountId, updates.scheduledTime, interactionId)
      if (conflicts.length > 0) {
        throw new Error('Scheduling conflict detected')
      }
    }

    Object.assign(interaction, updates)
    interaction.updatedAt = new Date()
    if (updates.scheduledTime) {
      interaction.metadata.scheduledBy = updatedBy
    }

    return await interaction.save()
  }

  /**
   * Cancel scheduled interaction
   */
  static async cancelScheduledInteraction(interactionId: string, cancelledBy: string): Promise<boolean> {
    const result = await ScheduledInteraction.findByIdAndUpdate(
      interactionId,
      {
        status: 'cancelled',
        updatedAt: new Date(),
        'metadata.scheduledBy': cancelledBy
      }
    )
    return !!result
  }

  /**
   * Start the scheduler daemon
   */
  static startScheduler(intervalMs: number = 60000): void {
    if (this.isRunning) {
      console.log('Scheduler is already running')
      return
    }

    console.log('Starting interaction scheduler...')
    this.isRunning = true

    this.executionInterval = setInterval(async () => {
      try {
        await this.processScheduledInteractions()
      } catch (error) {
        console.error('Error processing scheduled interactions:', error)
      }
    }, intervalMs)
  }

  /**
   * Stop the scheduler daemon
   */
  static stopScheduler(): void {
    if (this.executionInterval) {
      clearInterval(this.executionInterval)
      this.executionInterval = null
      this.isRunning = false
      console.log('Scheduler stopped')
    }
  }

  /**
   * Process scheduled interactions that are due
   */
  private static async processScheduledInteractions(): Promise<void> {
    const now = new Date()
    
    // Get interactions that are due for execution
    const dueInteractions = await ScheduledInteraction.find({
      status: 'pending',
      scheduledTime: { $lte: now }
    }).sort({ priority: -1, scheduledTime: 1 }).limit(10)

    for (const interaction of dueInteractions) {
      try {
        // Check if interaction should run based on constraints
        if (!this.shouldExecuteNow(interaction, now)) {
          // Reschedule for next valid time
          const nextTime = this.getNextValidExecutionTime(interaction, now)
          interaction.scheduledTime = nextTime
          await interaction.save()
          continue
        }

        // Check rate limiting
        if (interaction.metadata.constraints.rateLimitRespect) {
          const canExecute = await this.checkRateLimit(interaction.accountId, interaction.metadata.constraints.minimumDelay)
          if (!canExecute) {
            // Delay by minimum interval
            interaction.scheduledTime = new Date(now.getTime() + interaction.metadata.constraints.minimumDelay * 60 * 1000)
            await interaction.save()
            continue
          }
        }

        // Execute the interaction
        await this.executeInteraction(interaction)

      } catch (error) {
        console.error(`Error processing scheduled interaction ${interaction._id}:`, error)
        await this.handleExecutionError(interaction, error instanceof Error ? error.message : String(error))
      }
    }
  }

  /**
   * Execute a scheduled interaction
   */
  private static async executeInteraction(interaction: IScheduledInteraction): Promise<void> {
    const startTime = Date.now()
    interaction.status = 'executing'
    await interaction.save()

    try {
      // Here you would integrate with your Instagram automation
      // For now, we'll simulate the execution
      const success = await this.simulateInteractionExecution(interaction)
      const responseTime = Date.now() - startTime

      // Record execution attempt
      interaction.metadata.executionAttempts.push({
        timestamp: new Date(),
        success,
        responseTime
      })

      if (success) {
        interaction.status = 'completed'
        interaction.executedAt = new Date()

        // Record in interaction history
        await InteractionHistoryService.recordInteraction({
          runId: `scheduled_${interaction._id}`,
          accountId: interaction.accountId,
          interactionType: interaction.interactionType,
          targetUser: interaction.targetUser,
          targetPost: interaction.targetPost,
          content: interaction.content,
          responseStyle: interaction.responseStyle,
          success: true,
          responseTime
        })

      } else {
        throw new Error('Interaction execution failed')
      }

    } catch (error) {
      await this.handleExecutionError(interaction, error instanceof Error ? error.message : String(error))
    }

    await interaction.save()
  }

  /**
   * Handle execution errors with retry logic
   */
  private static async handleExecutionError(interaction: IScheduledInteraction, errorMessage: string): Promise<void> {
    interaction.retryCount++
    interaction.metadata.executionAttempts.push({
      timestamp: new Date(),
      success: false,
      errorMessage
    })

    if (interaction.retryCount >= interaction.maxRetries) {
      interaction.status = 'failed'
      
      // Record failed interaction in history
      await InteractionHistoryService.recordInteraction({
        runId: `scheduled_${interaction._id}`,
        accountId: interaction.accountId,
        interactionType: interaction.interactionType,
        targetUser: interaction.targetUser,
        targetPost: interaction.targetPost,
        content: interaction.content,
        responseStyle: interaction.responseStyle,
        success: false,
        errorMessage,
        responseTime: 0
      })
    } else {
      // Reschedule for retry with exponential backoff
      const delayMinutes = Math.pow(2, interaction.retryCount) * 5 // 5, 10, 20 minutes
      interaction.scheduledTime = new Date(Date.now() + delayMinutes * 60 * 1000)
      interaction.status = 'pending'
    }
  }

  /**
   * Check if interaction should execute now based on constraints
   */
  private static shouldExecuteNow(interaction: IScheduledInteraction, now: Date): boolean {
    const constraints = interaction.metadata.constraints

    // Check day of week constraints
    if (constraints.daysOfWeek && constraints.daysOfWeek.length > 0) {
      const dayOfWeek = now.getDay()
      if (!constraints.daysOfWeek.includes(dayOfWeek)) {
        return false
      }
    }

    // Check working hours constraints
    if (constraints.workingHours) {
      const currentTime = now.toTimeString().substring(0, 5) // "HH:MM"
      if (currentTime < constraints.workingHours.start || currentTime > constraints.workingHours.end) {
        return false
      }
    }

    return true
  }

  /**
   * Get next valid execution time based on constraints
   */
  private static getNextValidExecutionTime(interaction: IScheduledInteraction, from: Date): Date {
    const constraints = interaction.metadata.constraints
    let nextTime = new Date(from)

    // If outside working hours, schedule for next working day
    if (constraints.workingHours) {
      const currentTime = nextTime.toTimeString().substring(0, 5)
      if (currentTime >= constraints.workingHours.end) {
        // Schedule for next day at start time
        nextTime.setDate(nextTime.getDate() + 1)
        const [hours, minutes] = constraints.workingHours.start.split(':')
        nextTime.setHours(parseInt(hours), parseInt(minutes), 0, 0)
      } else if (currentTime < constraints.workingHours.start) {
        // Schedule for today at start time
        const [hours, minutes] = constraints.workingHours.start.split(':')
        nextTime.setHours(parseInt(hours), parseInt(minutes), 0, 0)
      }
    }

    // Check day of week constraints
    if (constraints.daysOfWeek && constraints.daysOfWeek.length > 0) {
      let daysToAdd = 0
      while (!constraints.daysOfWeek.includes(nextTime.getDay()) && daysToAdd < 7) {
        nextTime.setDate(nextTime.getDate() + 1)
        daysToAdd++
      }
    }

    return nextTime
  }

  /**
   * Check for scheduling conflicts
   */
  private static async checkForConflicts(
    accountId: string, 
    scheduledTime: Date, 
    excludeId?: string
  ): Promise<IScheduledInteraction[]> {
    const query: any = {
      accountId,
      status: { $in: ['pending', 'executing'] },
      scheduledTime: {
        $gte: new Date(scheduledTime.getTime() - 5 * 60 * 1000), // 5 minutes before
        $lte: new Date(scheduledTime.getTime() + 5 * 60 * 1000)  // 5 minutes after
      }
    }

    if (excludeId) {
      query._id = { $ne: excludeId }
    }

    return await ScheduledInteraction.find(query)
  }

  /**
   * Suggest alternative time for scheduling
   */
  private static async suggestAlternativeTime(accountId: string, preferredTime: Date): Promise<Date> {
    const baseTime = new Date(preferredTime)
    
    for (let offset = 10; offset <= 120; offset += 10) { // Try every 10 minutes up to 2 hours
      const candidateTime = new Date(baseTime.getTime() + offset * 60 * 1000)
      const conflicts = await this.checkForConflicts(accountId, candidateTime)
      
      if (conflicts.length === 0) {
        return candidateTime
      }
    }

    // If no slot found within 2 hours, suggest next day
    const nextDay = new Date(baseTime)
    nextDay.setDate(nextDay.getDate() + 1)
    nextDay.setHours(9, 0, 0, 0) // 9 AM next day
    
    return nextDay
  }

  /**
   * Check rate limiting constraints
   */
  private static async checkRateLimit(accountId: string, minimumDelayMinutes: number): Promise<boolean> {
    const cutoffTime = new Date(Date.now() - minimumDelayMinutes * 60 * 1000)
    
    const recentInteraction = await ScheduledInteraction.findOne({
      accountId,
      status: 'completed',
      executedAt: { $gte: cutoffTime }
    }).sort({ executedAt: -1 })

    return !recentInteraction
  }

  /**
   * Simulate interaction execution (replace with actual Instagram automation)
   */
  private static async simulateInteractionExecution(interaction: IScheduledInteraction): Promise<boolean> {
    // Simulate network delay
    await new Promise(resolve => setTimeout(resolve, Math.random() * 2000 + 1000))
    
    // Simulate 90% success rate
    return Math.random() > 0.1
  }

  /**
   * Clean up old completed/failed interactions
   */
  static async cleanupOldInteractions(daysToKeep: number = 30): Promise<number> {
    const cutoffDate = new Date()
    cutoffDate.setDate(cutoffDate.getDate() - daysToKeep)

    const result = await ScheduledInteraction.deleteMany({
      status: { $in: ['completed', 'failed', 'cancelled'] },
      updatedAt: { $lt: cutoffDate }
    })

    return result.deletedCount || 0
  }
}
