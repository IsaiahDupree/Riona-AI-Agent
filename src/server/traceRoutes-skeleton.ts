import { Router, Request, Response } from 'express'

const traceRouter = Router()

// Simplified trace routes for skeleton - no complex functionality
traceRouter.get('/runs/:runId', async (req: Request, res: Response) => {
  res.json({ 
    message: 'Trace runs endpoint - skeleton mode', 
    runId: req.params.runId,
    data: [] 
  })
})

traceRouter.get('/logs/tail', async (req: Request, res: Response) => {
  res.json({ 
    message: 'Trace logs endpoint - skeleton mode', 
    logs: [] 
  })
})

export { traceRouter }
