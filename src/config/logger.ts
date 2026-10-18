import { createLogger, format, transports } from "winston";
import 'winston-daily-rotate-file';
import * as path from 'path';
import * as fs from 'fs';

// Ensure the logs directory exists
const logDir = path.join(process.cwd(), 'logs');
if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
}

// Define log levels and their corresponding colors
const logLevels = {
    levels: {
        error: 0,
        warn: 1,
        info: 2,
        debug: 3,
    },
    colors: {
        error: 'red',
        warn: 'yellow',
        info: 'green',
        debug: 'blue',
    },
};

// Add colors to Winston
require('winston').addColors(logLevels.colors);

// Custom function to format the timestamp
const customTimestamp = format((info) => {
    const now = new Date();
    const hours = now.getHours();
    const minutes = now.getMinutes();
    const seconds = now.getSeconds();
    const ampm = hours >= 12 ? 'PM' : 'AM';
    const formattedTime = `${hours % 12 || 12}:${minutes < 10 ? '0' + minutes : minutes}:${seconds < 10 ? '0' + seconds : seconds} ${ampm}`;
    info.timestamp = formattedTime;
    return info;
});

// Create the logger instance
const logger = createLogger({
    levels: logLevels.levels,
    level: 'debug', // Set to most verbose level
    format: format.combine(
        format.errors({ stack: true }),
        customTimestamp(),
        format.colorize({ all: true }),
        format.printf(({ level, message, timestamp, stack }) => {
            if (stack) {
                return `${timestamp} ${level}: ${message}\n${stack}`;
            }
            return `${timestamp} ${level}: ${message}`;
        })
    ),
    transports: [
        // Console transport
        new transports.Console({
            level: 'debug',
            handleExceptions: true,
            handleRejections: true,
        }),
        // File transport for errors
        new transports.DailyRotateFile({
            filename: path.join(logDir, 'error-%DATE%.log'),
            datePattern: 'YYYY-MM-DD',
            zippedArchive: true,
            maxSize: '20m',
            maxFiles: '14d',
            level: 'error',
            format: format.combine(
                format.timestamp(),
                format.json()
            )
        }),
        // File transport for all logs
        new transports.DailyRotateFile({
            filename: path.join(logDir, 'combined-%DATE%.log'),
            datePattern: 'YYYY-MM-DD',
            zippedArchive: true,
            maxSize: '20m',
            maxFiles: '14d',
            format: format.combine(
                format.timestamp(),
                format.json()
            )
        })
    ],
    exitOnError: false
});

// Add exception handlers
export function setupErrorHandlers(): void {
    process.on('uncaughtException', (error: Error) => {
        logger.error('Uncaught Exception:', error);
        process.exit(1);
    });

    process.on('unhandledRejection', (reason: any, promise: Promise<any>) => {
        logger.error('Unhandled Rejection at:', { promise, reason });
        process.exit(1);
    });

    // Log when process is about to exit
    process.on('exit', (code: number) => {
        logger.info(`Process exiting with code: ${code}`);
    });
}

export default logger;
