import { Router, Request, Response } from 'express'

const hitlRouter = Router()

// Simplified routes for skeleton - no authentication middleware
hitlRouter.get('/interactions', async (req: Request, res: Response) => {
  res.json({ message: 'HITL interactions endpoint - skeleton mode', data: [] })
})

hitlRouter.get('/accounts', async (req: Request, res: Response) => {
  res.json({ message: 'HITL accounts endpoint - skeleton mode', data: [] })
})

hitlRouter.get('/styles', async (req: Request, res: Response) => {
  res.json({ message: 'HITL styles endpoint - skeleton mode', data: [] })
})

hitlRouter.post('/styles', async (req: Request, res: Response) => {
  res.json({ message: 'HITL create style endpoint - skeleton mode', success: true })
})

hitlRouter.get('/moderation/items', async (req: Request, res: Response) => {
  res.json({ message: 'HITL moderation items endpoint - skeleton mode', data: [] })
})

hitlRouter.post('/moderation/:id/approve', async (req: Request, res: Response) => {
  res.json({ message: 'HITL approve endpoint - skeleton mode', success: true })
})

hitlRouter.post('/moderation/:id/deny', async (req: Request, res: Response) => {
  res.json({ message: 'HITL deny endpoint - skeleton mode', success: true })
})

hitlRouter.post('/moderation/:id/revise', async (req: Request, res: Response) => {
  res.json({ message: 'HITL revise endpoint - skeleton mode', success: true })
})

hitlRouter.post('/moderation/:id/schedule', async (req: Request, res: Response) => {
  res.json({ message: 'HITL schedule endpoint - skeleton mode', success: true })
})

export { hitlRouter }
