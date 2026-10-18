import type { Server } from 'http'
import app from '../../src/server/basic-app'

describe('basic-app smoke', () => {
  let server: Server
  let baseUrl: string

  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address()
        if (addr && typeof addr === 'object') {
          baseUrl = `http://127.0.0.1:${addr.port}`
        }
        resolve()
      })
    })
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('GET /health returns ok', async () => {
    const res = await fetch(`${baseUrl}/health`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe('ok')
    expect(typeof body.timestamp).toBe('string')
    expect(typeof body.uptime).toBe('number')
  })

  it('GET /api/status returns running message', async () => {
    const res = await fetch(`${baseUrl}/api/status`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.message).toMatch(/Riona API is running/)
    expect(body.version).toBe('1.0.0')
  })
})
