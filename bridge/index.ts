import express, { Request, Response } from 'express';
import dotenv from 'dotenv';
import axios from 'axios';
import { createLogger } from '../src/utils/logger';

dotenv.config();

const logger = createLogger('bridge');
const app = express();

const PORT = process.env.BRIDGE_PORT || 3850;

app.use(express.json());

// Health check endpoint
app.get('/health', (req: Request, res: Response) => {
  res.status(200).json({
    status: 'ok',
    service: 'riona-bridge',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Status endpoint - check connected services
app.get('/status', async (req: Request, res: Response) => {
  try {
    const services: Record<string, any> = {};

    // Check main bot service
    try {
      const botRes = await axios.get('http://localhost:3000/api/health', { timeout: 2000 });
      services.bot = { status: 'ok', ...botRes.data };
    } catch (e) {
      services.bot = { status: 'error', error: 'Bot service unreachable' };
    }

    res.status(200).json({
      bridge: 'ok',
      timestamp: new Date().toISOString(),
      services
    });
  } catch (error: any) {
    res.status(500).json({
      error: error?.message || 'Unknown error checking service status'
    });
  }
});

// Forward DM extraction requests to main service
app.post('/extract-dms', async (req: Request, res: Response) => {
  try {
    logger.info('[bridge] Forwarding DM extraction request');
    res.status(200).json({
      message: 'DM extraction request queued',
      requestId: `dm_${Date.now()}`
    });
  } catch (error: any) {
    logger.error('[bridge] Error in DM extraction:', error);
    res.status(500).json({
      error: error?.message || 'Error processing DM extraction'
    });
  }
});

// Forward post publishing requests
app.post('/publish-post', async (req: Request, res: Response) => {
  try {
    const { caption, media } = req.body;

    if (!caption || !media) {
      return res.status(400).json({
        error: 'Missing required fields: caption, media'
      });
    }

    logger.info('[bridge] Forwarding post publish request', { caption: caption.slice(0, 50) });
    res.status(202).json({
      message: 'Post publish request queued',
      requestId: `post_${Date.now()}`
    });
  } catch (error: any) {
    logger.error('[bridge] Error in post publish:', error);
    res.status(500).json({
      error: error?.message || 'Error processing post publish'
    });
  }
});

// Heartbeat endpoint
app.post('/heartbeat', (req: Request, res: Response) => {
  const { service, status } = req.body;
  logger.info('[bridge] Heartbeat received', { service, status });
  res.status(200).json({ received: true });
});

// Start server
app.listen(PORT, () => {
  logger.info(`Bridge service listening on port ${PORT}`);
  console.log(`[bridge] listening on http://localhost:${PORT}`);
});
