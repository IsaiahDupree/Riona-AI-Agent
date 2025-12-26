import express from 'express';
import { connectDB } from '../config/db';
import { initializeDatabase } from '../config/initDb';
import { traceRouter } from './traceRoutes';
import { hitlRouter } from '../hitl/routes';

export async function startServer() {
  await connectDB();
  await initializeDatabase();

  const app = express();
  app.use(express.json());

  app.use('/api/trace', traceRouter);
  app.use('/api/hitl', hitlRouter);

  const port = Number(process.env.PORT || 3000);
  return new Promise<void>((resolve) => {
    app.listen(port, () => {
      // eslint-disable-next-line no-console
      console.log(`[server] listening on http://localhost:${port}`);
      resolve();
    });
  });
}
