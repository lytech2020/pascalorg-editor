import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Boots the real server (including its MCP stdio child) and verifies the
// T1.3 request-identity contract over actual HTTP. Isolation: a temp
// AI_MCP_SESSION_FILE keeps test sessions out of the real .data store, and
// AI_MCP_PORT=0 lets the OS assign a free port — the actual port is parsed
// from the child's own startup log, so we can never talk to some other
// server that happens to be running. Uses the cancel action so no model call
// (and no API key) is involved.
describe('server request identity (T1.3)', () => {
  test(
    '/chat mints authoritative ids, ignores forged ones and sets response headers',
    async () => {
      const dataDir = mkdtempSync(join(tmpdir(), 'ai-mcp-int-'))
      const sessionId = `int-t13-${crypto.randomUUID().slice(0, 8)}`
      const proc = Bun.spawn(['bun', 'src/server.ts'], {
        cwd: join(import.meta.dir, '..'),
        env: {
          ...process.env,
          AI_MCP_PORT: '0',
          AI_MCP_SESSION_FILE: join(dataDir, 'sessions.json'),
        },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      try {
        // The startup line carries the OS-assigned port.
        const port = await new Promise<number>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error(`server did not report a port; stderr sample: ${errText.slice(0, 400)}`)),
            20_000,
          )
          let text = ''
          let errText = ''
          const scan = async () => {
            for await (const chunk of proc.stdout) {
              text += new TextDecoder().decode(chunk)
              const match = text.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/)
              if (match) {
                clearTimeout(timer)
                resolve(Number(match[1]))
                return
              }
            }
          }
          const scanErr = async () => {
            for await (const chunk of proc.stderr) {
              errText += new TextDecoder().decode(chunk)
            }
          }
          void scan()
          void scanErr()
        })
        const base = `http://127.0.0.1:${port}`
        // The child must still be the process behind that port.
        expect(proc.killed).toBe(false)
        const health = await fetch(`${base}/health`)
        expect(health.ok).toBe(true)

        const response = await fetch(`${base}/chat`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-trace-id': 'trace-int-12345678',
          },
          body: JSON.stringify({
            sessionId,
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

        // Ids come back even on a request rejected before the body is valid
        // (T1.3 review suggestion: context is created before parsing).
        const invalid = await fetch(`${base}/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{broken',
        })
        expect(invalid.status).toBe(400)
        expect(invalid.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/)

        // A second call never reuses the id.
        const second = await fetch(`${base}/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId, action: 'cancel' }),
        })
        const secondPayload = (await second.json()) as { requestId?: string }
        expect(secondPayload.requestId).toMatch(/^[0-9a-f-]{36}$/)
        expect(secondPayload.requestId).not.toBe(payload.requestId)
      } finally {
        proc.kill()
        await proc.exited
        rmSync(dataDir, { recursive: true, force: true })
      }
    },
    40_000,
  )
})
