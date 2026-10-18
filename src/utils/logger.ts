import winston from 'winston';
import chalk from 'chalk';

const customFormat = winston.format.printf(({ level, message, timestamp, ...meta }) => {
    const timestampStr = chalk.white(`[${timestamp}]`);
    let coloredMessage = message;

    switch (level) {
        case 'error':
            coloredMessage = chalk.red(message);
            break;
        case 'warn':
            coloredMessage = chalk.yellow(message);
            break;
        case 'info':
            coloredMessage = chalk.green(message);
            break;
        case 'debug':
            coloredMessage = chalk.blue(message);
            break;
    }

    const metaStr = Object.keys(meta).length ? JSON.stringify(meta, null, 2) : '';
    return `${timestampStr} ${coloredMessage} ${metaStr}`;
});

export const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp({
            format: 'YYYY-MM-DD HH:mm:ss'
        }),
        customFormat
    ),
    transports: [
        new winston.transports.Console(),
        new winston.transports.File({ filename: 'error.log', level: 'error' }),
        new winston.transports.File({ filename: 'combined.log' })
    ]
});
