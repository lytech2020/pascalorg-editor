import { PascalAiAgent } from './agent'
import { loadConfig } from './config'
import { isValidImageDataUrl, readJsonBody } from './http-guards'
import { PascalMcpClient } from './mcp'
import { AppDatabase } from './persistence/database'
import { ModelCallRepository } from './persistence/model-call-repository'
import {
  ChatRequestRepository,
  RequestCancellationTargetNotFoundError,
  RequestIdempotencyConflictError,
  RequestQueueFullError,
  SqliteSessionPersistence,
} from './persistence/session-repository'
import { clientRequestIdFrom, createRequestContext } from './request-context'
import { RequestPayloadStore } from './request-payload-store'
import { RequestWorker } from './request-worker'
import { SqliteModelAttemptRecorder } from './telemetry/model-attempt-recorder'
import { loadTemplateLibrary, templateLibraryAllowsTraffic } from './template-seed'
import { WorkflowStepRepository } from './persistence/workflow-step-repository'
import { SceneBuildRepository } from './persistence/scene-build-repository'

const config = loadConfig()
const database = new AppDatabase(config.databaseFile)
const modelAttempts = new SqliteModelAttemptRecorder(new ModelCallRepository(database))
const sessions = new SqliteSessionPersistence(database)
const legacySessions = sessions.importLegacyFile(config.sessionFile)
if (legacySessions.status === 'imported') {
  console.log(`legacy-sessions: imported=${legacySessions.imported} skipped=${legacySessions.skipped}`)
}
const requests = new ChatRequestRepository(database)
const workflowSteps = new WorkflowStepRepository(database)
const sceneBuilds = new SceneBuildRepository(database)
const templateLibrary = loadTemplateLibrary(config.templatesDir)
const templatesAcceptTraffic = templateLibraryAllowsTraffic(templateLibrary.health)
const templateHealthSummary = {
  ready: templateLibrary.health.ready,
  files: templateLibrary.health.files,
  loaded: templateLibrary.health.loaded,
  good: templateLibrary.health.good,
  bad: templateLibrary.health.bad,
  failed: templateLibrary.health.failed,
}
console.log(`template-library: ${JSON.stringify(templateHealthSummary)}`)
if (templateLibrary.health.failures.length > 0) {
  const log = process.env.NODE_ENV === 'production' ? console.error : console.warn
  for (const failure of templateLibrary.health.failures) log(`template-library load failure: ${failure}`)
}
const mcp = new PascalMcpClient(config)
await mcp.connect()

const agent = new PascalAiAgent(config, mcp, modelAttempts, sessions, requests, workflowSteps, sceneBuilds)
const requestPayloads = new RequestPayloadStore(config.requestArtifactsDir)
const worker = new RequestWorker(requests, sessions, requestPayloads, agent, {
  concurrency: config.requestWorkerConcurrency,
  leaseMs: config.requestLeaseMs,
  pollMs: config.requestWorkerPollMs,
}, workflowSteps, sceneBuilds)
if (templatesAcceptTraffic) worker.start()
else worker.recoverExpired()
// Keep Bun's transport safety cap above the application limit so ordinary
// Content-Length violations reach readJsonBody and receive request identity.
// Requests above this hard cap are rejected by Bun before application code.
const transportMaxRequestBodyBytes = config.maxRequestBodyBytes * 2

const server = Bun.serve({
  hostname: config.host,
  port: config.port,
  maxRequestBodySize: transportMaxRequestBodyBytes,
  async fetch(request): Promise<Response> {
    try {
      return await handle(request)
    } catch (error) {
      // Without this, an uncaught error (e.g. a bad sceneId, a hung MCP
      // call) falls through to Bun's default error response, which has no
      // CORS headers — the browser reports a opaque "network error" instead
      // of the real failure, which is very hard to debug from the client.
      console.error('Unhandled error in pascal-ai-mcp request:', error)
      return json({ error: 'internal_error', message: errorMessage(error) }, 500)
    }
  },
})

async function handle(request: Request): Promise<Response> {
  const url = new URL(request.url)

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(),
    })
  }

  // Liveness only. Provider/model/mcpMode details are deliberately not
  // exposed here: the endpoint is unauthenticated (ARCHITECTURE_TASKS.md
  // T0.3); the startup log carries the config summary instead. A proper
  // internal readiness endpoint lands with T2.5.
  if (request.method === 'GET' && url.pathname === '/health') {
    return json({ ok: true })
  }

  if (request.method === 'GET' && url.pathname === '/tools') {
    return json({ tools: await mcp.listOpenAiTools() })
  }

  if (request.method === 'POST' && url.pathname === '/chat') {
    // Authoritative requestId is minted here — before the body is even read,
    // so parse/validation rejections (400/413) carry ids too; body-supplied
    // ids never become the key (T1.3). The context travels with the whole
    // run and comes back in the response so every layer logs the same ids.
    const context = createRequestContext(request.headers)
    const identityHeaders = { 'x-request-id': context.requestId, 'x-trace-id': context.traceId }
    const identity = () => ({
      requestId: context.requestId,
      traceId: context.traceId,
      ...(context.clientRequestId ? { clientRequestId: context.clientRequestId } : {}),
    })

    const read = await readJsonBody(request, config.maxRequestBodyBytes)
    if (!read.ok) {
      return json(
        { error: read.error, maxBytes: config.maxRequestBodyBytes, ...identity() },
        read.status,
        identityHeaders,
      )
    }
    const clientRequestId = clientRequestIdFrom(read.body as Record<string, unknown>)
    if (clientRequestId) context.clientRequestId = clientRequestId
    const body = read.body as {
      sessionId?: string
      message?: string
      imageDataUrl?: string
      sceneId?: string
      action?: 'confirm' | 'cancel'
      idempotencyKey?: string
    }

    if (body.action !== undefined && body.action !== 'confirm' && body.action !== 'cancel') {
      return json({ error: 'invalid_action', ...identity() }, 400, identityHeaders)
    }

    if (body.idempotencyKey !== undefined && !isValidIdempotencyKey(body.idempotencyKey)) {
      return json({ error: 'invalid_idempotency_key', ...identity() }, 400, identityHeaders)
    }

    if (!body.sessionId || (!body.message && !body.imageDataUrl && !body.action)) {
      return json(
        { error: 'sessionId and message, imageDataUrl, or action are required', ...identity() },
        400,
        identityHeaders,
      )
    }

    if (body.imageDataUrl && !isValidImageDataUrl(body.imageDataUrl)) {
      return json(
        { error: 'invalid_image', message: 'imageDataUrl must be a base64 data URL of type image/png or image/jpeg', ...identity() },
        400,
        identityHeaders,
      )
    }

    if (!templatesAcceptTraffic) {
      return json(
        { error: 'template_library_unavailable', message: 'Template library is not ready', ...identity() },
        503,
        identityHeaders,
      )
    }

    let imageArtifact: ReturnType<RequestPayloadStore['persistImage']> | undefined
    try {
      if (body.imageDataUrl) imageArtifact = requestPayloads.persistImage(body.imageDataUrl)
      const queuedAt = new Date().toISOString()
      const enqueued = requests.enqueue({
        requestId: context.requestId,
        traceId: context.traceId,
        ...(context.clientRequestId ? { clientRequestId: context.clientRequestId } : {}),
        sessionId: body.sessionId,
        kind: body.action === 'confirm' ? 'confirm' : body.action === 'cancel' ? 'cancel' : 'chat',
        ...(body.sceneId ? { sceneId: body.sceneId } : {}),
        ...(body.idempotencyKey ? { idempotencyKey: body.idempotencyKey } : {}),
        startedAt: queuedAt,
      }, {
        sessionId: body.sessionId,
        ...(body.message ? { message: body.message } : {}),
        ...(imageArtifact ? { imageArtifact } : {}),
        ...(body.sceneId ? { sceneId: body.sceneId } : {}),
        ...(body.action ? { action: body.action } : {}),
      }, config.requestQueueDepth)
      if (!enqueued.created) requestPayloads.deleteImage(imageArtifact)
      for (const cancelled of enqueued.cancelled) {
        try {
          requestPayloads.deleteImage(cancelled.input?.imageArtifact)
        } catch (error) {
          console.error(`[req ${cancelled.requestId}] cancelled artifact cleanup failed: ${errorMessage(error)}`)
        }
      }
      if (enqueued.created && body.action === 'cancel') worker.requestCancellation(body.sessionId)
      if (enqueued.created) worker.notify()
      if (!enqueued.created) {
        console.log(
          `[req ${context.requestId}] [trace ${context.traceId}] idempotency reuse resolved to req=${enqueued.request.requestId} trace=${enqueued.request.traceId}`,
        )
      }
      console.log(
        `[req ${enqueued.request.requestId}] [trace ${enqueued.request.traceId}] chat ${enqueued.created ? 'queued' : 'reused'} session=${body.sessionId}${body.action ? ` action=${body.action}` : ''}`,
      )
      return json(
        {
          status: enqueued.request.status,
          reused: !enqueued.created,
          statusUrl: `/requests/${enqueued.request.requestId}`,
          requestId: enqueued.request.requestId,
          traceId: enqueued.request.traceId,
          ...(context.clientRequestId ? { clientRequestId: context.clientRequestId } : {}),
        },
        202,
        {
          'x-request-id': enqueued.request.requestId,
          'x-trace-id': enqueued.request.traceId,
          Location: `/requests/${enqueued.request.requestId}`,
        },
      )
    } catch (error) {
      requestPayloads.deleteImage(imageArtifact)
      if (error instanceof RequestQueueFullError) {
        return json(
          { error: 'queue_full', message: error.message, ...identity() },
          429,
          { ...identityHeaders, 'Retry-After': '2' },
        )
      }
      if (error instanceof RequestCancellationTargetNotFoundError) {
        return json(
          { error: 'session_not_found', message: error.message, ...identity() },
          404,
          identityHeaders,
        )
      }
      if (error instanceof RequestIdempotencyConflictError) {
        return json(
          { error: 'idempotency_conflict', message: error.message, existingRequestId: error.requestId, ...identity() },
          409,
          identityHeaders,
        )
      }
      console.error(`[req ${context.requestId}] [trace ${context.traceId}] enqueue failed: ${errorMessage(error)}`)
      return json(
        { error: 'internal_error', message: errorMessage(error), ...identity() },
        500,
        identityHeaders,
      )
    }
  }

  const requestMatch = url.pathname.match(/^\/requests\/([^/]+)$/)
  if (requestMatch && request.method === 'GET') {
    const requestId = decodeURIComponent(requestMatch[1] ?? '')
    const record = requests.find(requestId)
    if (!record) return json({ error: 'request_not_found' }, 404)
    const session = sessions.load(record.sessionId)?.session
    const steps = workflowSteps.findByRequestId(requestId)
    const sceneBuild = sceneBuilds.findByRequestId(requestId)
    return json({
      requestId: record.requestId,
      traceId: record.traceId,
      ...(record.clientRequestId ? { clientRequestId: record.clientRequestId } : {}),
      ...(record.idempotencyKey ? { idempotencyKey: record.idempotencyKey } : {}),
      sessionId: record.sessionId,
      kind: record.kind,
      status: record.status,
      runAttempts: record.runAttempts,
      queuedAt: record.queuedAt,
      ...(record.startedAt ? { startedAt: record.startedAt } : {}),
      ...(record.completedAt ? { completedAt: record.completedAt } : {}),
      ...(record.errorCode ? { errorCode: record.errorCode } : {}),
      ...(session ? { sessionPhase: session.phase } : {}),
      steps,
      ...(sceneBuild ? {
        sceneBuild: {
          buildId: sceneBuild.buildId,
          status: sceneBuild.status,
          ...(sceneBuild.sceneId ? { sceneId: sceneBuild.sceneId } : {}),
          ...(sceneBuild.errorCode ? { errorCode: sceneBuild.errorCode } : {}),
          cleanupAttempts: sceneBuild.cleanupAttempts,
        },
      } : {}),
      ...(record.result && session ? {
        result: { reply: record.result.reply, session },
      } : {}),
    }, 200, { 'x-request-id': record.requestId, 'x-trace-id': record.traceId })
  }

  const sessionMatch = url.pathname.match(/^\/sessions\/([^/]+)$/)
  if (sessionMatch && request.method === 'GET') {
    return json({ session: agent.getSession(decodeURIComponent(sessionMatch[1] ?? '')) ?? null })
  }

  if (sessionMatch && request.method === 'DELETE') {
    const sessionId = decodeURIComponent(sessionMatch[1] ?? '')
    if (requests.hasActiveRequest(sessionId)) {
      return json({ deleted: false, error: 'session_busy' }, 409)
    }
    const deleted = agent.deleteSession(sessionId)
    return json({ deleted })
  }

  return json({ error: 'not_found' }, 404)
}

console.log(`pascal-ai-mcp listening on http://${server.hostname}:${server.port}`)
console.log(
  `config: provider=${config.aiProvider} model=${config.aiModel} mcpMode=${config.mcpMode} configured=${Boolean(config.aiApiKey)} maxBodyMB=${Math.round(config.maxRequestBodyBytes / 1024 / 1024)} transportMaxBodyMB=${Math.round(transportMaxRequestBodyBytes / 1024 / 1024)} workerConcurrency=${config.requestWorkerConcurrency} queueDepth=${config.requestQueueDepth}`,
)

// Graceful shutdown (ARCHITECTURE_TASKS.md T0.4/T1.5/T2.1): stop accepting
// work and drain claimed queue jobs before closing MCP and SQLite. A drain
// timeout exits non-zero so supervisors don't mistake dropped state for a
// clean stop. SIGKILL bypasses this path; the expired lease is then marked
// process_interrupted by the next worker and is deliberately not replayed.
let shuttingDown = false
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    // Second signal: the operator wants out now.
    console.error(`received ${signal} during shutdown, exiting immediately`)
    process.exit(1)
  }
  shuttingDown = true
  worker.stopAccepting()
  console.log(`received ${signal}, shutting down`)
  let exitCode = 0
  // server.stop() resolves once in-flight requests finish — exiting before
  // that would drop the session writes those requests are about to make. A
  // multi-minute /chat can exceed the drain budget; that path exits non-zero
  // because its state genuinely was not persisted.
  try {
    await withTimeout(server.stop(), config.shutdownDrainTimeoutMs, 'in-flight requests')
  } catch (error) {
    console.error('shutdown: gave up waiting for in-flight requests:', errorMessage(error))
    server.stop(true)
    exitCode = 1
  }
  try {
    await withTimeout(worker.drain(), config.shutdownDrainTimeoutMs, 'request worker')
  } catch (error) {
    console.error('shutdown: gave up waiting for request worker:', errorMessage(error))
    process.exit(1)
  }
  try {
    await mcp.close()
  } catch (error) {
    console.error('shutdown: failed to close MCP client:', errorMessage(error))
  }
  try {
    database.close()
  } catch (error) {
    console.error('shutdown: failed to close audit database:', errorMessage(error))
    exitCode = 1
  }
  process.exit(exitCode)
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ])
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))

function json(payload: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...corsHeaders(),
      ...headers,
    },
  })
}

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Expose-Headers': 'x-request-id, x-trace-id, Location, Retry-After',
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isValidIdempotencyKey(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{8,128}$/.test(value)
}
