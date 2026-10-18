import winston from 'winston';

const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp({
            format: 'HH:mm:ss'
        }),
        winston.format.printf(info => `${info.timestamp} ${info.level}: ${info.message}`)
    ),
    transports: [
        new winston.transports.Console(),
        new winston.transports.File({ filename: 'error.log', level: 'error' }),
        new winston.transports.File({ filename: 'combined.log' })
    ]
});

interface InteractionLog {
    postIndex: number;
    timestamp: string;
    caption: string;
    likeMethod: string;
    commentMethod: string;
    commentText: string | null;
    success: boolean;
    details: string;
}

export function logInteraction(log: InteractionLog): void {
    logger.info(`Post ${log.postIndex} interaction:
        Time: ${log.timestamp}
        Caption: ${log.caption}
        Like Method: ${log.likeMethod}
        Comment Method: ${log.commentMethod}
        Comment Text: ${log.commentText}
        Success: ${log.success}
        Details: ${log.details}
    `);
}
