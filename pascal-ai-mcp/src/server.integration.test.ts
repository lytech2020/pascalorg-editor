import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'

// Boots the real server (including its MCP stdio child) and verifies the
// T1.3 request-identity contract over actual HTTP. Uses the cancel action so
// no model call (and no API key) is involved.
describe('server request identity (T1.3)', () => {
  test(
    '/chat mints authoritative ids, ignores forged ones and sets response headers',
    async () => {
      const port = 18900 + Math.floor(Math.random() * 500)
      const base = `http://127.0.0.1:${port}`
      const proc = Bun.spawn(['bun', 'src/server.ts'], {
        cwd: join(import.meta.dir, '..'),
        env: { ...process.env, AI_MCP_PORT: String(port) },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      try {
        const deadline = Date.now() + 20_000
        let ready = false
        while (Date.now() < deadline) {
          try {
            const health = await fetch(`${base}/health`)
            if (health.ok) {
              ready = true
              break
            }
          } catch {
            // still booting
          }
          await new Promise(resolve => setTimeout(resolve, 250))
        }
        expect(ready).toBe(true)

        const response = await fetch(`${base}/chat`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-trace-id': 'trace-int-12345678',
          },
          body: JSON.stringify({
            sessionId: 'int-t13',
            action: 'cancel',
            clientRequestId: 'ui-int-1',
            requestId: 'forged-request-id',
            traceId: 'forged-trace-id',
          }),
        })
        const payload = (await response.json()) as {
          requestId?: string
          traceId?: string
          clientRequestId?: string
        }
        expect(payload.requestId).toMatch(/^[0-9a-f-]{36}$/)
        expect(payload.requestId).not.toBe('forged-request-id')
        expect(payload.traceId).toBe('trace-int-12345678')
        expect(payload.clientRequestId).toBe('ui-int-1')
        // Headers let the proxy log/forward the ids without parsing the body.
        expect(response.headers.get('x-request-id')).toBe(payload.requestId ?? '')
        expect(response.headers.get('x-trace-id')).toBe('trace-int-12345678')

        // A second call never reuses the id.
        const second = await fetch(`${base}/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: 'int-t13', action: 'cancel' }),
        })
        const secondPayload = (await second.json()) as { requestId?: string }
        expect(secondPayload.requestId).toMatch(/^[0-9a-f-]{36}$/)
        expect(secondPayload.requestId).not.toBe(payload.requestId)
      } finally {
        proc.kill()
        await proc.exited
      }
    },
    40_000,
  )
})
