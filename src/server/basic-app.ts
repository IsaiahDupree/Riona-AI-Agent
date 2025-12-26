import express from 'express'
import path from 'path'

const app = express()
const PORT = process.env.PORT || 3847

// Basic middleware
app.use(express.json())
app.use(express.static('public'))

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  })
})

// Basic API routes
app.get('/api/status', (req, res) => {
  res.json({ 
    message: 'Riona API is running',
    version: '1.0.0'
  })
})

// Serve frontend in production
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '../../frontend/dist')))
  
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../../frontend/dist/index.html'))
  })
}

export function startBasicServer(): void {
  app.listen(PORT, () => {
    console.log(`🚀 Basic server running on http://localhost:${PORT}`)
    console.log(`📊 Health check: http://localhost:${PORT}/health`)
    console.log(`🔧 API status: http://localhost:${PORT}/api/status`)
  })
}

export default app
