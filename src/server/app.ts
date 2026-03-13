import express, { Request, Response, NextFunction } from 'express';
import { connectDB, isDBConnected } from '../config/db';
import { initializeDatabase } from '../config/initDb';
import { traceRouter } from './traceRoutes';
import { hitlRouter } from '../hitl/routes';
import { dmRouter } from './dmRoutes';

export async function startServer() {
  let dbAvailable = false;

  try {
    await connectDB();
    await initializeDatabase();
    dbAvailable = isDBConnected();
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.log(`[server] MongoDB unavailable (${msg}) — starting without DB features`);
  }

  const app = express();
  app.use(express.json());

  // Health check endpoint
  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      db: isDBConnected() ? 'connected' : 'disconnected',
      uptime: process.uptime()
    });
  });

  app.use('/api/trace', traceRouter);
  app.use('/api/hitl', hitlRouter);
  app.use('/api/dm', dmRouter);

  // Global error handler — catches unhandled route errors
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error(`[server] Unhandled route error: ${err.message}`);
    res.status(500).json({ error: 'Internal server error' });
  });

  const port = Number(process.env.PORT || 3000);
  return new Promise<void>((resolve, reject) => {
    const server = app.listen(port, () => {
      console.log(`[server] listening on http://localhost:${port}${dbAvailable ? '' : ' (no DB)'}`);
      resolve();
    });
    server.on('error', (err) => {
      console.error(`[server] Failed to listen on port ${port}:`, err);
      reject(err);
    });
  });
}
