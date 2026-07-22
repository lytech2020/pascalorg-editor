import type { PascalAiAgent } from './agent'
import { safeErrorLogFields, stableErrorCode } from './error-policy'
import type {
  ChatRequestRecord,
  ChatRequestRepository,
  QueuedChatInput,
  QueuedChatResult,
  SessionPersistence,
} from './persistence/session-repository'
import { RequestPayloadStore } from './request-payload-store'
import type { ChatInput, ChatResult } from './types'
import type { WorkflowStepWriter } from './persistence/workflow-step-repository'
import type { SceneBuildWriter } from './persistence/scene-build-repository'

export type RequestWorkerOptions = {
  concurrency: number
  leaseMs: number
  pollMs: number
  canClaim?: () => boolean
}

type ChatExecutor = Pick<PascalAiAgent, 'executeQueued' | 'requestCancellation'>
  & Partial<Pick<PascalAiAgent, 'expiredRequestRecovery'>>

const ORPHAN_STEP_SWEEP_INTERVAL_MS = 60_000

export class RequestWorker {
  private readonly ownerInstanceId = `worker:${crypto.randomUUID()}`
  private readonly active = new Map<string, Promise<void>>()
  private pollTimer?: ReturnType<typeof setTimeout>
  private accepting = false
  private ticking = false
  private nextOrphanStepSweepAt = 0

  constructor(
    private readonly requests: ChatRequestRepository,
    private readonly sessions: SessionPersistence,
    private readonly payloads: RequestPayloadStore,
    private readonly executor: ChatExecutor,
    private readonly options: RequestWorkerOptions,
    private readonly workflowSteps?: WorkflowStepWriter,
    private readonly sceneBuilds?: SceneBuildWriter,
  ) {}

  start(): void {
    if (this.accepting) return
    this.accepting = true
    void this.recoverExpired()
      .catch(error => console.error(`request recovery failed: ${errorMessage(error)}`))
      .finally(() => this.notify())
  }

  async recoverExpired(): Promise<void> {
    await this.failExpiredRequests()
    this.reconcileOrphanedSteps()
    this.reconcileOrphanedSceneBuilds()
    this.nextOrphanStepSweepAt = Date.now() + ORPHAN_STEP_SWEEP_INTERVAL_MS
  }

  notify(): void {
    if (!this.accepting) return
    if (this.pollTimer) clearTimeout(this.pollTimer)
    this.pollTimer = setTimeout(() => {
      this.pollTimer = undefined
      void this.tick()
    }, 0)
  }

  requestCancellation(sessionId: string): void {
    this.executor.requestCancellation(sessionId)
  }

  stopAccepting(): void {
    this.accepting = false
    if (this.pollTimer) clearTimeout(this.pollTimer)
    this.pollTimer = undefined
  }

  async drain(): Promise<void> {
    while (this.active.size > 0) {
      await Promise.allSettled([...this.active.values()])
    }
  }

  private async tick(): Promise<void> {
    if (!this.accepting || this.ticking) return
    this.ticking = true
    try {
      await this.failExpiredRequests()
      if (Date.now() >= this.nextOrphanStepSweepAt) {
        this.reconcileOrphanedSteps()
        this.reconcileOrphanedSceneBuilds()
        this.nextOrphanStepSweepAt = Date.now() + ORPHAN_STEP_SWEEP_INTERVAL_MS
      }
      while (this.accepting && this.active.size < this.options.concurrency) {
        if (this.options.canClaim && !this.options.canClaim()) break
        const now = new Date()
        const request = this.requests.claimNext(
          this.ownerInstanceId,
          now.toISOString(),
          new Date(now.getTime() + this.options.leaseMs).toISOString(),
        )
        if (!request) break
        const running = this.execute(request).finally(() => {
          this.active.delete(request.requestId)
          this.notify()
        })
        this.active.set(request.requestId, running)
      }
    } finally {
      this.ticking = false
      if (this.accepting && !this.pollTimer) {
        this.pollTimer = setTimeout(() => {
          this.pollTimer = undefined
          void this.tick()
        }, this.options.pollMs)
      }
    }
  }

  private async execute(request: ChatRequestRecord): Promise<void> {
    const input = request.input
    if (!input) {
      this.finishFailed(request, 'missing_request_payload')
      return
    }
    const heartbeatEveryMs = Math.max(250, Math.floor(this.options.leaseMs / 3))
    let heartbeatLost = false
    const stopAfterHeartbeatFailure = (message: string): void => {
      if (heartbeatLost) return
      heartbeatLost = true
      console.error(JSON.stringify({
        level: 'error', event: 'request_lease_lost', requestId: request.requestId,
        traceId: request.traceId, message,
      }))
      this.executor.requestCancellation(request.sessionId)
    }
    const heartbeat = setInterval(() => {
      try {
        const now = new Date()
        const ok = this.requests.heartbeat(
          request.requestId,
          this.ownerInstanceId,
          now.toISOString(),
          new Date(now.getTime() + this.options.leaseMs).toISOString(),
        )
        if (!ok) stopAfterHeartbeatFailure('request lease heartbeat lost; cancelling local execution')
      } catch (error) {
        logWorkerError(request, 'request_lease_heartbeat_failed', error)
        stopAfterHeartbeatFailure('request lease heartbeat failed; cancelling local execution')
      }
    }, heartbeatEveryMs)
    try {
      const chatInput = this.chatInput(request, input)
      const result = await this.executor.executeQueued(chatInput)
      const stored = this.sessions.load(result.sessionId)
      if (!stored) throw new Error(`session ${result.sessionId} was not persisted`)
      const queuedResult: QueuedChatResult = {
        sessionId: result.sessionId,
        reply: result.reply,
        phase: result.session.phase,
        sessionVersion: stored.version,
      }
      const status = request.kind !== 'cancel' && result.session.phase === 'cancelled'
        ? 'cancelled'
        : 'succeeded'
      this.reconcileRunningSteps(request.requestId)
      this.requests.complete(
        request.requestId,
        this.ownerInstanceId,
        status,
        new Date().toISOString(),
        queuedResult,
      )
    } catch (error) {
      logWorkerError(request, 'queued_request_failed', error)
      this.finishFailed(request, classifyError(error))
    } finally {
      clearInterval(heartbeat)
      try {
        this.payloads.deleteImage(input.imageArtifactId)
      } catch (error) {
        logWorkerError(request, 'artifact_cleanup_failed', error)
      }
    }
  }

  private chatInput(request: ChatRequestRecord, input: QueuedChatInput): ChatInput {
    return {
      sessionId: input.sessionId,
      ...(input.message ? { message: input.message } : {}),
      ...(input.imageArtifactId ? { imageDataUrl: this.payloads.loadImage(input.imageArtifactId) } : {}),
      ...(input.sceneId ? { sceneId: input.sceneId } : {}),
      ...(input.action ? { action: input.action } : {}),
      context: {
        requestId: request.requestId,
        traceId: request.traceId,
        ...(request.clientRequestId ? { clientRequestId: request.clientRequestId } : {}),
        ...(request.workflowRunId ? { workflowRunId: request.workflowRunId } : {}),
        ...(request.graphVersion ? { graphVersion: request.graphVersion } : {}),
      },
    }
  }

  private finishFailed(request: ChatRequestRecord, errorCode: string): void {
    try {
      this.reconcileRunningSteps(request.requestId)
      this.requests.complete(
        request.requestId,
        this.ownerInstanceId,
        'failed',
        new Date().toISOString(),
        undefined,
        errorCode,
      )
    } catch (error) {
      logWorkerError(request, 'request_failure_persistence_failed', error)
    }
  }

  private reconcileRunningSteps(requestId: string): void {
    try {
      this.workflowSteps?.failRunningForRequest(
        requestId,
        new Date().toISOString(),
        'step_persistence_incomplete',
      )
    } catch (error) {
      console.error(`[req ${requestId}] workflow step reconciliation failed: ${errorMessage(error)}`)
    }
  }

  private reconcileOrphanedSteps(): void {
    try {
      const recovered = this.workflowSteps?.failOrphanedRunningSteps(new Date().toISOString()) ?? 0
      if (recovered > 0) console.warn(`recovered ${recovered} orphaned workflow step(s)`)
    } catch (error) {
      console.error(`orphaned workflow step reconciliation failed: ${errorMessage(error)}`)
    }
  }

  private reconcileOrphanedSceneBuilds(): void {
    try {
      const recovered = this.sceneBuilds?.abandonOrphaned(new Date().toISOString()) ?? 0
      if (recovered > 0) console.warn(`recovered ${recovered} orphaned scene build(s)`)
    } catch (error) {
      console.error(`orphaned scene build reconciliation failed: ${errorMessage(error)}`)
    }
  }

  private async failExpiredRequests(): Promise<void> {
    const now = new Date().toISOString()
    const expired = this.requests.expiredWorkerRequests(now)
    for (const request of expired) {
      const disposition = await this.executor.expiredRequestRecovery?.(request) ?? 'fail_recoverable'
      if (disposition === 'complete') {
        const stored = this.sessions.load(request.sessionId)
        if (stored && request.ownerInstanceId) {
          const result: QueuedChatResult = {
            sessionId: stored.session.sessionId,
            reply: latestAssistantReply(stored.session.messages),
            phase: stored.session.phase,
            sessionVersion: stored.version,
          }
          try {
            this.reconcileRunningSteps(request.requestId)
            this.requests.complete(
              request.requestId,
              request.ownerInstanceId,
              request.kind !== 'cancel' && stored.session.phase === 'cancelled'
                ? 'cancelled'
                : 'succeeded',
              now,
              result,
            )
            try {
              this.payloads.deleteImage(request.input?.imageArtifactId)
            } catch (error) {
              logWorkerError(request, 'recovered_artifact_cleanup_failed', error)
            }
            console.warn(`[req ${request.requestId}] recovered terminal result from durable session state`)
          } catch (error) {
            logWorkerError(request, 'terminal_recovery_lost_ownership', error)
          }
          continue
        }
      }
      if (disposition === 'resume') {
        if (request.ownerInstanceId && this.requests.requeueExpiredWorkerRequest(
          request.requestId,
          request.ownerInstanceId,
        )) {
          console.warn(`[req ${request.requestId}] expired worker lease requeued from durable plan checkpoint`)
        }
        continue
      }
      if (
        !request.ownerInstanceId
        || !this.requests.failExpiredWorkerRequest(request.requestId, request.ownerInstanceId, now)
      ) continue
      try {
        this.workflowSteps?.failRunningForRequest(
          request.requestId,
          new Date().toISOString(),
          'process_interrupted',
        )
      } catch (error) {
        logWorkerError(request, 'workflow_step_recovery_failed', error)
      }
      try {
        this.payloads.deleteImage(request.input?.imageArtifactId)
      } catch (error) {
        logWorkerError(request, 'expired_artifact_cleanup_failed', error)
      }
      console.warn(`[req ${request.requestId}] expired worker lease marked process_interrupted`)
    }
  }
}

function classifyError(error: unknown): string {
  if (
    error instanceof Error
    && error.name === 'WorkflowResumeBoundaryError'
    && typeof (error as Error & { code?: unknown }).code === 'string'
  ) {
    return (error as Error & { code: string }).code
  }
  const message = errorMessage(error)
  if (/artifact .* (?:size|hash) mismatch|ENOENT/.test(message)) return 'artifact_unavailable'
  return stableErrorCode(error)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function logWorkerError(request: ChatRequestRecord, event: string, error: unknown): void {
  console.error(JSON.stringify({
    level: 'error',
    event,
    requestId: request.requestId,
    traceId: request.traceId,
    ...safeErrorLogFields(error),
  }))
}

function latestAssistantReply(messages: import('./types').ChatMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message?.role === 'assistant' && typeof message.content === 'string') return message.content
  }
  return ''
}
