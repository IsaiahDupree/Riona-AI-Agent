import mongoose from 'mongoose';
import logger from './logger';

let isConnected = false;

export const connectDB = async () => {
  try {
    const uri = process.env.MONGODB_URI;
    if (!uri) {
      logger.warn('MONGODB_URI not set — running without MongoDB (interaction history will not be saved)');
      return;
    }

    logger.info('Connecting to MongoDB...');
    await mongoose.connect(uri);
    isConnected = true;

    mongoose.connection.on('connected', () => {
      isConnected = true;
      logger.info('MongoDB connected successfully');
    });

    mongoose.connection.on('error', (err) => {
      isConnected = false;
      logger.error('MongoDB connection error:', err);
    });

    mongoose.connection.on('disconnected', () => {
      isConnected = false;
      logger.warn('MongoDB disconnected — will attempt to reconnect automatically');
    });

    // Handle process termination
    process.on('SIGINT', async () => {
      try {
        await mongoose.connection.close();
        logger.info('MongoDB connection closed through app termination');
        process.exit(0);
      } catch (err) {
        logger.error('Error closing MongoDB connection:', err);
        process.exit(1);
      }
    });

  } catch (error) {
    isConnected = false;
    logger.error('MongoDB connection failed:', error);
    logger.warn('Continuing without MongoDB — interaction history will not be saved');
  }
};

/**
 * Check if MongoDB is currently connected.
 * Use this before DB operations to avoid silent failures.
 */
export function isDBConnected(): boolean {
  return isConnected && mongoose.connection.readyState === 1;
}
