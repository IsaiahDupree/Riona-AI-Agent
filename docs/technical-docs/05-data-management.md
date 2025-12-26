# Data Management

## MongoDB Integration

The Instagram bot uses MongoDB for persistent storage of interaction data and analytics.

### Database Schema

```typescript
// Core data interfaces
interface BaseMetadata {
    type: string;
    timestamp: Date;
    success: boolean;
    error?: string;
}

interface PostMetadata extends BaseMetadata {
    username: string;
    caption: string;
    isVideo: boolean;
    hashtags: string[];
    likes: number;
}

interface CommentMetadata extends BaseMetadata {
    type: 'comment';
    comment: string;
}

interface LikeMetadata extends BaseMetadata {
    type: 'like';
}

interface BotInteraction {
    timestamp: Date;
    type: 'comment' | 'like';
    success: boolean;
    error?: string;
    details?: string;
    metadata?: any;
}
```

### Database Connection

```typescript
// MongoDB connection management
async function initMongoDBConnection(): Promise<void> {
    try {
        const mongoClient = new MongoClient(process.env.MONGODB_URI as string);
        await mongoClient.connect();
        
        logger.info('Connected to MongoDB Atlas', {
            component: 'Database',
            event: 'connection_success'
        });

        // Initialize collections
        const db = mongoClient.db('instagram_bot');
        const collections = {
            posts: db.collection('posts'),
            interactions: db.collection('interactions'),
            analytics: db.collection('analytics'),
            errors: db.collection('errors')
        };

        // Create indexes
        await Promise.all([
            collections.posts.createIndex({ timestamp: -1 }),
            collections.posts.createIndex({ username: 1 }),
            collections.interactions.createIndex({ timestamp: -1 }),
            collections.interactions.createIndex({ type: 1 }),
            collections.analytics.createIndex({ date: -1 }),
            collections.errors.createIndex({ timestamp: -1 })
        ]);

    } catch (error) {
        logger.error('MongoDB connection error:', {
            error: error instanceof Error ? error.message : String(error),
            component: 'Database',
            event: 'connection_error'
        });
        throw error;
    }
}
```

### Data Operations

```typescript
// Save interaction data
async function saveInteractionToDb(interaction: BotInteraction): Promise<void> {
    try {
        const db = mongoClient.db('instagram_bot');
        const collection = db.collection('interactions');

        await collection.insertOne({
            ...interaction,
            createdAt: new Date()
        });

        // Update analytics
        await updateAnalytics(interaction);

    } catch (error) {
        logger.error('Error saving interaction:', {
            error: error instanceof Error ? error.message : String(error),
            component: 'Database',
            event: 'save_interaction_error'
        });
    }
}

// Update analytics
async function updateAnalytics(interaction: BotInteraction): Promise<void> {
    const db = mongoClient.db('instagram_bot');
    const analytics = db.collection('analytics');
    
    const date = new Date();
    date.setHours(0, 0, 0, 0);

    await analytics.updateOne(
        { date },
        {
            $inc: {
                [`${interaction.type}Count`]: 1,
                [`${interaction.type}Success`]: interaction.success ? 1 : 0,
                [`${interaction.type}Failures`]: interaction.success ? 0 : 1
            }
        },
        { upsert: true }
    );
}
```

## Logging System

### Logger Configuration

```typescript
// Winston logger setup
import winston from 'winston';

const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    defaultMeta: { service: 'instagram-bot' },
    transports: [
        // Console logging
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.simple()
            )
        }),
        // File logging
        new winston.transports.File({
            filename: 'logs/error.log',
            level: 'error'
        }),
        new winston.transports.File({
            filename: 'logs/combined.log'
        })
    ]
});

// Log rotation configuration
const logRotate = require('winston-daily-rotate-file');

const rotateTransport = new logRotate({
    filename: 'logs/%DATE%-combined.log',
    datePattern: 'YYYY-MM-DD',
    zippedArchive: true,
    maxSize: '20m',
    maxFiles: '14d'
});

logger.add(rotateTransport);
```

### Logging Utilities

```typescript
// Structured logging helper
function logEvent(
    level: 'info' | 'warn' | 'error',
    message: string,
    context: {
        component: string;
        event: string;
        [key: string]: any;
    }
): void {
    logger.log({
        level,
        message,
        timestamp: new Date().toISOString(),
        ...context
    });
}

// Error logging with stack traces
function logError(
    error: Error,
    context: {
        component: string;
        event: string;
        [key: string]: any;
    }
): void {
    logger.error({
        message: error.message,
        stack: error.stack,
        timestamp: new Date().toISOString(),
        ...context
    });
}
```

## Analytics

### Data Collection

```typescript
// Analytics data collection
interface DailyAnalytics {
    date: Date;
    commentCount: number;
    commentSuccess: number;
    commentFailures: number;
    likeCount: number;
    likeSuccess: number;
    likeFailures: number;
    engagementRate: number;
    averageResponseTime: number;
    errorRate: number;
}

// Collect daily analytics
async function collectDailyAnalytics(): Promise<DailyAnalytics> {
    const db = mongoClient.db('instagram_bot');
    const analytics = db.collection('analytics');
    
    const date = new Date();
    date.setHours(0, 0, 0, 0);

    const dailyStats = await analytics.findOne({ date });
    
    if (!dailyStats) {
        return {
            date,
            commentCount: 0,
            commentSuccess: 0,
            commentFailures: 0,
            likeCount: 0,
            likeSuccess: 0,
            likeFailures: 0,
            engagementRate: 0,
            averageResponseTime: 0,
            errorRate: 0
        };
    }

    return dailyStats;
}
```

### Performance Metrics

```typescript
// Calculate performance metrics
async function calculatePerformanceMetrics(
    timeframe: 'daily' | 'weekly' | 'monthly'
): Promise<{
    successRate: number;
    engagementRate: number;
    errorRate: number;
    averageResponseTime: number;
}> {
    const db = mongoClient.db('instagram_bot');
    const analytics = db.collection('analytics');

    const endDate = new Date();
    const startDate = new Date();

    switch (timeframe) {
        case 'daily':
            startDate.setDate(endDate.getDate() - 1);
            break;
        case 'weekly':
            startDate.setDate(endDate.getDate() - 7);
            break;
        case 'monthly':
            startDate.setMonth(endDate.getMonth() - 1);
            break;
    }

    const metrics = await analytics.aggregate([
        {
            $match: {
                date: {
                    $gte: startDate,
                    $lte: endDate
                }
            }
        },
        {
            $group: {
                _id: null,
                totalInteractions: {
                    $sum: { $add: ['$commentCount', '$likeCount'] }
                },
                totalSuccess: {
                    $sum: { $add: ['$commentSuccess', '$likeSuccess'] }
                },
                totalFailures: {
                    $sum: { $add: ['$commentFailures', '$likeFailures'] }
                },
                totalResponseTime: { $sum: '$averageResponseTime' },
                count: { $sum: 1 }
            }
        }
    ]).toArray();

    const metric = metrics[0];
    
    return {
        successRate: metric.totalSuccess / metric.totalInteractions,
        engagementRate: metric.totalSuccess / (metric.totalSuccess + metric.totalFailures),
        errorRate: metric.totalFailures / metric.totalInteractions,
        averageResponseTime: metric.totalResponseTime / metric.count
    };
}
```

## Data Cleanup

### Maintenance Tasks

```typescript
// Database maintenance tasks
async function performDatabaseMaintenance(): Promise<void> {
    const db = mongoClient.db('instagram_bot');
    
    // Clean up old records
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    await Promise.all([
        // Remove old interaction records
        db.collection('interactions').deleteMany({
            timestamp: { $lt: thirtyDaysAgo }
        }),
        
        // Archive old analytics
        archiveOldAnalytics(thirtyDaysAgo),
        
        // Clean up error logs
        db.collection('errors').deleteMany({
            timestamp: { $lt: thirtyDaysAgo }
        })
    ]);
}

// Archive old analytics data
async function archiveOldAnalytics(cutoffDate: Date): Promise<void> {
    const db = mongoClient.db('instagram_bot');
    const analytics = db.collection('analytics');
    const archive = db.collection('analytics_archive');

    // Move old analytics to archive
    const oldAnalytics = await analytics.find({
        date: { $lt: cutoffDate }
    }).toArray();

    if (oldAnalytics.length > 0) {
        await archive.insertMany(oldAnalytics);
        await analytics.deleteMany({
            date: { $lt: cutoffDate }
        });
    }
}
```
