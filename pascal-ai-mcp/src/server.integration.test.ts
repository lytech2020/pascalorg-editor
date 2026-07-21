import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppDatabase } from './persistence/database'
import { ChatRequestRepository, SqliteSessionPersistence } from './persistence/session-repository'
import type { WorkflowSession } from './types'

interface HttpResult {
  status: number
  headers: IncomingHttpHeaders
  body: string
}

function requestHttp(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<HttpResult> {
  const body = options.body === undefined ? undefined : Buffer.from(options.body)
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      url,
      {
        method: options.method ?? 'GET',
        headers: {
          ...options.headers,
          ...(body ? { 'content-length': String(body.byteLength) } : {}),
        },
        timeout: 5_000,
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
        response.on('end', () => {
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          })
        })
      },
    )
    request.on('timeout', () => request.destroy(new Error(`HTTP request timed out: ${url}`)))
    request.on('error', reject)
    request.end(body)
  })
}

function responseHeader(response: HttpResult, name: string): string | null {
  const value = response.headers[name.toLowerCase()]
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null)
}

async function waitForRequest(base: string, requestId: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const response = await requestHttp(`${base}/requests/${encodeURIComponent(requestId)}`)
    expect(response.status).toBe(200)
    const payload = JSON.parse(response.body) as Record<string, unknown>
    if (payload.status !== 'queued' && payload.status !== 'running') return payload
    await Bun.sleep(20)
  }
  throw new Error(`request ${requestId} did not finish`)
}

async function startServer(dataDir: string, extraEnv: Record<string, string> = {}) {
  const proc = Bun.spawn(['bun', 'src/server.ts'], {
    cwd: join(import.meta.dir, '..'),
    env: {
      ...process.env,
      AI_MCP_PORT: '0',
      AI_MCP_MAX_BODY_MB: '1',
      AI_MCP_SESSION_FILE: join(dataDir, 'sessions.json'),
      AI_MCP_DATABASE_FILE: join(dataDir, 'ai.db'),
      ...extraEnv,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  let errText = ''
  const scanErr = async () => {
    for await (const chunk of proc.stderr) errText += new TextDecoder().decode(chunk)
  }
  void scanErr()
  const port = await new Promise<number>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      settled = true
      reject(new Error(`server did not report a port; stderr sample: ${errText.slice(0, 1_500)}`))
    }, 20_000)
    void proc.exited.then((code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(`server exited before reporting a port (code ${code}): ${errText.slice(0, 1_500)}`))
    })
    const scan = async () => {
      let text = ''
      for await (const chunk of proc.stdout) {
        text += new TextDecoder().decode(chunk)
        const match = text.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/)
        if (match) {
          settled = true
          clearTimeout(timer)
          resolve(Number(match[1]))
          return
        }
      }
    }
    void scan()
  })
  return { proc, port }
}

function seedSession(dataDir: string, sessionId: string): void {
  const database = new AppDatabase(join(dataDir, 'ai.db'))
  try {
    const now = new Date().toISOString()
    const session: WorkflowSession = {
      sessionId,
      inputType: 'text',
      phase: 'cancelled',
      availability: 'partially_usable',
      brief: {
        existingCondition: [], designGoals: [], hardConstraints: [],
        assumptions: [], uncertainties: [], conflicts: [],
      },
      questions: [], reasons: [], summary: '', messages: [],
      clarificationRounds: 0,
      createdAt: now,
      updatedAt: now,
    }
    new SqliteSessionPersistence(database).save(session, 0)
  } finally {
    database.close()
  }
}

// Boots the real server (including its MCP stdio child) and verifies the
// T1.3 request-identity contract over actual HTTP. Isolation: a temp SQLite
// database holds all live state; AI_MCP_SESSION_FILE points at an absent
// legacy import source. AI_MCP_PORT=0 lets the OS assign a free port, parsed
// from the child's own startup log so we cannot talk to another server.
// Uses the cancel action so no model call (and no API key) is involved.
describe('server request identity (T1.3)', () => {
  test(
    '/chat mints authoritative ids, ignores forged ones and sets response headers',
    async () => {
      const dataDir = mkdtempSync(join(tmpdir(), 'ai-mcp-int-'))
      const sessionId = `int-t13-${crypto.randomUUID().slice(0, 8)}`
      seedSession(dataDir, sessionId)
      const { proc, port } = await startServer(dataDir)
      try {
        const base = `http://127.0.0.1:${port}`
        // The child must still be the process behind that port.
        expect(proc.killed).toBe(false)
        const health = await requestHttp(`${base}/health`)
        expect(health.status).toBe(200)

        const missingCancel = await requestHttp(`${base}/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: 'missing-cancel-target', action: 'cancel' }),
        })
        expect(missingCancel.status).toBe(404)
        expect(JSON.parse(missingCancel.body)).toMatchObject({ error: 'session_not_found' })

        const response = await requestHttp(`${base}/chat`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-trace-id': 'trace-int-12345678',
          },
          body: JSON.stringify({
            sessionId,
            action: 'cancel',
            clientRequestId: 'ui-int-1',
            idempotencyKey: 'ui-idempotency-0001',
            requestId: 'forged-request-id',
            traceId: 'forged-trace-id',
          }),
        })
        const payload = JSON.parse(response.body) as {
          requestId?: string
          traceId?: string
          clientRequestId?: string
        }
        expect(payload.requestId).toMatch(/^[0-9a-f-]{36}$/)
        expect(payload.requestId).not.toBe('forged-request-id')
        expect(payload.traceId).toBe('trace-int-12345678')
        expect(payload.clientRequestId).toBe('ui-int-1')
        // Headers let the proxy log/forward the ids without parsing the body.
        expect(responseHeader(response, 'x-request-id')).toBe(payload.requestId ?? '')
        expect(responseHeader(response, 'x-trace-id')).toBe('trace-int-12345678')
        expect(response.status).toBe(202)
        const firstCompleted = await waitForRequest(base, payload.requestId!)
        expect(firstCompleted.status).toBe('succeeded')
        expect(firstCompleted.result).toBeDefined()

        const duplicate = await requestHttp(`${base}/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId,
            action: 'cancel',
            clientRequestId: 'ui-int-retry',
            idempotencyKey: 'ui-idempotency-0001',
          }),
        })
        const duplicatePayload = JSON.parse(duplicate.body) as {
          requestId?: string
          reused?: boolean
        }
        expect(duplicate.status).toBe(202)
        expect(duplicatePayload).toMatchObject({ requestId: payload.requestId, reused: true })

        const conflictingDuplicate = await requestHttp(`${base}/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId,
            action: 'cancel',
            message: 'different input under the same key',
            idempotencyKey: 'ui-idempotency-0001',
          }),
        })
        expect(conflictingDuplicate.status).toBe(409)
        expect(JSON.parse(conflictingDuplicate.body)).toMatchObject({
          error: 'idempotency_conflict', existingRequestId: payload.requestId,
        })

        // Ids come back even on a request rejected before the body is valid
        // (T1.3 review suggestion: context is created before parsing).
        const invalid = await requestHttp(`${base}/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{broken',
        })
        expect(invalid.status).toBe(400)
        expect(responseHeader(invalid, 'x-request-id')).toMatch(/^[0-9a-f-]{36}$/)

        // The application limit is 1 MiB while Bun's transport hard cap is
        // 2 MiB. A normal Content-Length violation therefore reaches the
        // handler and returns an attributable 413 instead of Bun's bare 413.
        const oversized = await requestHttp(`${base}/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId, message: 'x'.repeat(1024 * 1024) }),
        })
        const oversizedPayload = JSON.parse(oversized.body) as {
          error?: string
          requestId?: string
          traceId?: string
        }
        expect(oversized.status).toBe(413)
        expect(oversizedPayload.error).toBe('payload_too_large')
        expect(oversizedPayload.requestId).toMatch(/^[0-9a-f-]{36}$/)
        expect(responseHeader(oversized, 'x-request-id')).toBe(oversizedPayload.requestId ?? '')
        expect(responseHeader(oversized, 'x-trace-id')).toBe(oversizedPayload.traceId ?? '')

        // A second call never reuses the id.
        const second = await requestHttp(`${base}/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId, action: 'cancel' }),
        })
        const secondPayload = JSON.parse(second.body) as { requestId?: string }
        expect(second.status).toBe(202)
        expect(secondPayload.requestId).toMatch(/^[0-9a-f-]{36}$/)
        expect(secondPayload.requestId).not.toBe(payload.requestId)
        const firstRequestId = payload.requestId!
        const secondRequestId = secondPayload.requestId!
        expect((await waitForRequest(base, secondRequestId)).status).toBe('succeeded')

        const audit = new Database(join(dataDir, 'ai.db'), { readonly: true, strict: true })
        try {
          const requests = audit.query(`
            SELECT request_id, kind, status FROM ai_requests ORDER BY queued_at, request_id
          `).all() as Array<{ request_id: string; kind: string; status: string }>
          expect(requests).toEqual([
            { request_id: firstRequestId, kind: 'cancel', status: 'succeeded' },
            { request_id: secondRequestId, kind: 'cancel', status: 'succeeded' },
          ])
          const state = audit.query(`
            SELECT version, state_json FROM ai_sessions WHERE session_id = ?
          `).get(sessionId) as { version: number; state_json: string }
          expect(state.version).toBe(3)
          expect(state.state_json).not.toContain('messages')
        } finally {
          audit.close()
        }
      } finally {
        proc.kill()
        await proc.exited
        rmSync(dataDir, { recursive: true, force: true })
      }
    },
    40_000,
  )

  test(
    'production keeps liveness but rejects /chat when the configured good-template library is invalid',
    async () => {
      const dataDir = mkdtempSync(join(tmpdir(), 'ai-mcp-template-gate-'))
      const templatesDir = join(dataDir, 'templates')
      mkdirSync(join(templatesDir, 'good'), { recursive: true })
      const source = join(import.meta.dir, '..', 'templates', 'good', 'tpl-jp-2dk-44.json')
      const template = JSON.parse(readFileSync(source, 'utf8'))
      template.plan.rooms[0].type = 'invalid-room-type'
      writeFileSync(join(templatesDir, 'good', 'invalid-good.json'), JSON.stringify(template))
      const queuedDatabase = new AppDatabase(join(dataDir, 'ai.db'))
      try {
        const queue = new ChatRequestRepository(queuedDatabase)
        queue.enqueue({
          requestId: 'preexisting-expired-request',
          traceId: 'preexisting-expired-trace',
          sessionId: 'expired-template-gate',
          kind: 'chat',
          startedAt: '2026-07-21T00:00:00.000Z',
        }, { sessionId: 'expired-template-gate', message: 'expired before template validation' }, 10)
        queue.claimNext(
          'worker:dead',
          '2026-07-21T00:00:00.000Z',
          '2026-07-21T00:00:01.000Z',
        )
        queue.enqueue({
          requestId: 'preexisting-queued-request',
          traceId: 'preexisting-queued-trace',
          sessionId: 'template-gate',
          kind: 'chat',
          startedAt: new Date().toISOString(),
        }, { sessionId: 'template-gate', message: 'queued before template validation' }, 10)
      } finally {
        queuedDatabase.close()
      }
      const { proc, port } = await startServer(dataDir, {
        NODE_ENV: 'production',
        AI_MCP_TEMPLATES_DIR: templatesDir,
      })
      try {
        const base = `http://127.0.0.1:${port}`
        expect((await requestHttp(`${base}/health`)).status).toBe(200)
        const response = await requestHttp(`${base}/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: 'template-gate', action: 'cancel' }),
        })
        const payload = JSON.parse(response.body) as { error?: string; requestId?: string }
        expect(response.status).toBe(503)
        expect(payload.error).toBe('template_library_unavailable')
        expect(payload.requestId).toMatch(/^[0-9a-f-]{36}$/)
        expect(responseHeader(response, 'x-request-id')).toBe(payload.requestId ?? '')
        await Bun.sleep(100)
        const queuedAudit = new Database(join(dataDir, 'ai.db'), { readonly: true, strict: true })
        try {
          expect(queuedAudit.query(`
            SELECT status, run_attempts FROM ai_requests WHERE request_id = ?
          `).get('preexisting-queued-request')).toEqual({ status: 'queued', run_attempts: 0 })
          expect(queuedAudit.query(`
            SELECT status, error_code FROM ai_requests WHERE request_id = ?
          `).get('preexisting-expired-request')).toEqual({
            status: 'failed', error_code: 'process_interrupted',
          })
        } finally {
          queuedAudit.close()
        }
      } finally {
        proc.kill()
        await proc.exited
        rmSync(dataDir, { recursive: true, force: true })
      }
    },
    40_000,
  )
})
