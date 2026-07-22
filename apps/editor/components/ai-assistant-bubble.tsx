'use client'

import { Bot, Check, ImagePlus, LoaderCircle, Send, Trash2, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

type Phase =
  | 'intake'
  | 'clarifying'
  | 'awaiting_confirmation'
  | 'awaiting_modification_confirmation'
  | 'inspecting'
  | 'generating'
  | 'modifying'
  | 'completed'
  | 'completed_with_issues'
  | 'cancelled'
  | 'failed'

type WorkflowSession = {
  phase: Phase
  availability: 'usable' | 'partially_usable' | 'unusable'
  summary: string
  questions: string[]
  messages?: Array<{
    role: 'system' | 'user' | 'assistant' | 'tool'
    content?: string | null | unknown[]
  }>
  sceneResult?: {
    editorUrl: string | null
    version?: number | null
    repairRounds: number
    remainingIssueCount?: number
    verificationIssues?: string[]
    collisions?: Array<{ aId: string; bId: string; kind: string }>
  }
  executionSteps?: Array<{
    phase: string
    status: 'completed' | 'failed'
    label: string
  }>
}

type ChatResponse = {
  reply: string
  session: WorkflowSession
  // Server-authoritative ids (T1.3): requestId keys the call on the AI side;
  // clientRequestId echoes the tag we sent for local correlation.
  requestId?: string
  traceId?: string
  clientRequestId?: string
}

type RequestStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
type RequestKind = 'chat' | 'confirm' | 'cancel'
type WorkflowStepStatus = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'failed_recoverable'

type WorkflowStepProgress = {
  stepId: string
  operationKey: string
  attemptNo: number
  status: WorkflowStepStatus
  errorCode?: string
  startedAt: string
  completedAt?: string
}

type AcceptedResponse = {
  status: RequestStatus
  reused?: boolean
  statusUrl: string
  requestId: string
  traceId: string
  clientRequestId?: string
}

type RequestStatusResponse = {
  requestId: string
  traceId: string
  clientRequestId?: string
  sessionId: string
  kind: RequestKind
  status: RequestStatus
  sessionPhase?: Phase
  errorCode?: string
  steps: WorkflowStepProgress[]
  result?: ChatResponse
}

type UiMessage = { id: string; role: 'user' | 'assistant'; content: string }

// Correlation record for one /chat call (T1.3): clientRequestId is ours,
// requestId/traceId come back from the AI service. Kept for success, failure
// and cancellation so any request can be matched to server-side logs.
type RequestRecord = {
  clientRequestId: string
  requestId?: string
  traceId?: string
  kind: 'chat' | 'cancel'
  status: 'ok' | 'error'
  at: string
}

type PendingSubmission = {
  sessionId: string
  sceneId?: string
  message?: string
  imageDataUrl?: string
  action?: string
  idempotencyKey: string
}

type ActiveRequestReference = {
  requestId: string
  traceId: string
  clientRequestId: string
  sessionId: string
  kind: RequestKind
}

type WaitForRequestOptions = {
  signal?: AbortSignal
  onUpdate?: (request: RequestStatusResponse) => void
  onConnectionChange?: (retrying: boolean) => void
}

class RequestStatusError extends Error {
  constructor(
    message: string,
    readonly permanent: boolean,
  ) {
    super(message)
    this.name = 'RequestStatusError'
  }
}

function aiAgentUrl(): string {
  if (process.env.NEXT_PUBLIC_AI_AGENT_URL) return process.env.NEXT_PUBLIC_AI_AGENT_URL
  return '/api/ai'
}

function editorHref(editorUrl: string): string {
  if (window.location.pathname.startsWith('/_pascal')) {
    return `/_pascal${editorUrl}`
  }
  return editorUrl
}

function mapSessionMessages(
  session: WorkflowSession,
  currentMessages: UiMessage[] = [],
): UiMessage[] {
  const mapped = (session.messages ?? [])
    .filter(
      (message) =>
        (message.role === 'user' || message.role === 'assistant') &&
        typeof message.content === 'string',
    )
    .map((message) => ({
      id: crypto.randomUUID(),
      role: message.role as 'user' | 'assistant',
      content: message.content as string,
    }))

  const currentUserMessages = currentMessages.filter((message) => message.role === 'user')
  const mappedUserIndexes = mapped.flatMap((message, index) =>
    message.role === 'user' ? [index] : [],
  )
  const alignedCount = Math.min(currentUserMessages.length, mappedUserIndexes.length)
  for (let offset = 1; offset <= alignedCount; offset += 1) {
    const current = currentUserMessages[currentUserMessages.length - offset]
    const mappedIndex = mappedUserIndexes[mappedUserIndexes.length - offset]
    const mappedMessage = mappedIndex === undefined ? undefined : mapped[mappedIndex]
    if (current?.content.includes('\n[Image: ') && mappedIndex !== undefined && mappedMessage) {
      mapped[mappedIndex] = { ...mappedMessage, content: current.content }
    }
  }
  return mapped
}

async function fetchSessionSnapshot(
  sessionId: string,
  signal?: AbortSignal,
): Promise<WorkflowSession | null> {
  const response = await fetch(`${aiAgentUrl()}/sessions/${encodeURIComponent(sessionId)}`, {
    cache: 'no-store',
    signal,
  })
  if (!response.ok) return null
  const payload = (await response.json()) as { session?: WorkflowSession | null }
  return payload.session ?? null
}

function createSessionId(sceneId?: string): string {
  const storageKey = `pascal-ai-session:${sceneId ?? 'local-editor'}`
  const existing = window.localStorage.getItem(storageKey)
  if (existing) return existing
  const created = crypto.randomUUID()
  window.localStorage.setItem(storageKey, created)
  return created
}

function activeRequestStorageKey(sessionId: string): string {
  return `pascal-ai-active-request:${sessionId}`
}

function rememberActiveRequest(request: ActiveRequestReference): void {
  try {
    window.localStorage.setItem(activeRequestStorageKey(request.sessionId), JSON.stringify(request))
  } catch (storageError) {
    console.warn('[ai-assistant] could not persist active request reference', storageError)
  }
}

function readActiveRequest(sessionId: string): ActiveRequestReference | null {
  try {
    const raw = window.localStorage.getItem(activeRequestStorageKey(sessionId))
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<ActiveRequestReference>
    if (
      parsed.sessionId !== sessionId ||
      typeof parsed.requestId !== 'string' ||
      typeof parsed.traceId !== 'string' ||
      typeof parsed.clientRequestId !== 'string' ||
      (parsed.kind !== 'chat' && parsed.kind !== 'confirm' && parsed.kind !== 'cancel')
    ) {
      window.localStorage.removeItem(activeRequestStorageKey(sessionId))
      return null
    }
    return parsed as ActiveRequestReference
  } catch {
    try {
      window.localStorage.removeItem(activeRequestStorageKey(sessionId))
    } catch {}
    return null
  }
}

function forgetActiveRequest(sessionId: string, requestId?: string): void {
  if (requestId) {
    const current = readActiveRequest(sessionId)
    if (current?.requestId !== requestId) return
  }
  try {
    window.localStorage.removeItem(activeRequestStorageKey(sessionId))
  } catch {}
}

function waitWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }, ms)
    const abort = () => {
      window.clearTimeout(timer)
      reject(signal?.reason)
    }
    signal?.addEventListener('abort', abort, { once: true })
  })
}

function isRequestStatusResponse(value: unknown): value is RequestStatusResponse {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<RequestStatusResponse>
  return (
    typeof candidate.requestId === 'string' &&
    typeof candidate.traceId === 'string' &&
    typeof candidate.sessionId === 'string' &&
    (candidate.kind === 'chat' || candidate.kind === 'confirm' || candidate.kind === 'cancel') &&
    (candidate.status === 'queued' ||
      candidate.status === 'running' ||
      candidate.status === 'succeeded' ||
      candidate.status === 'failed' ||
      candidate.status === 'cancelled') &&
    Array.isArray(candidate.steps)
  )
}

export function AiAssistantPanel({ sceneId }: { sceneId?: string }) {
  const [sessionId, setSessionId] = useState('')
  const [session, setSession] = useState<WorkflowSession | null>(null)
  const [messages, setMessages] = useState<UiMessage[]>([])
  const [input, setInput] = useState('')
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null)
  const [imageName, setImageName] = useState('')
  const [busy, setBusy] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [error, setError] = useState('')
  const [requestProgress, setRequestProgress] = useState<RequestStatusResponse | null>(null)
  const [pollReconnecting, setPollReconnecting] = useState(false)
  // Rolling log of recent request correlations (client id -> server ids);
  // kept in a ref (not render state) and mirrored to console.debug.
  const requestLogRef = useRef<RequestRecord[]>([])
  const pendingChatSubmissionRef = useRef<PendingSubmission | null>(null)
  const pendingCancelSubmissionRef = useRef<PendingSubmission | null>(null)
  const recordRequest = useCallback((record: RequestRecord) => {
    requestLogRef.current = [...requestLogRef.current.slice(-19), record]
    console.debug(
      `[ai-assistant] ${record.kind} ${record.status} client=${record.clientRequestId} server=${record.requestId ?? '-'} trace=${record.traceId ?? '-'}`,
    )
  }, [])
  const fileInputRef = useRef<HTMLInputElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setSessionId(createSessionId(sceneId))
  }, [sceneId])

  useEffect(() => {
    if (!sessionId) return
    if (readActiveRequest(sessionId)) return
    const controller = new AbortController()
    void fetchSessionSnapshot(sessionId, controller.signal)
      .then((restored) => {
        if (!restored) return
        setSession(restored)
        setMessages(mapSessionMessages(restored))
      })
      .catch((loadError: unknown) => {
        if (!(loadError instanceof DOMException && loadError.name === 'AbortError')) {
          console.warn('[ai-assistant] session restore failed', loadError)
        }
      })
    return () => controller.abort()
  }, [sessionId])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  })

  const waitForRequest = useCallback(
    async (
      requestId: string,
      options: WaitForRequestOptions = {},
    ): Promise<RequestStatusResponse> => {
      const deadline = Date.now() + 30 * 60 * 1000
      let retryDelayMs = 750
      while (Date.now() < deadline) {
        try {
          const response = await fetch(
            `${aiAgentUrl()}/requests/${encodeURIComponent(requestId)}`,
            {
              cache: 'no-store',
              signal: options.signal,
            },
          )
          const payload = (await response
            .json()
            .catch(() => ({}))) as Partial<RequestStatusResponse> & {
            error?: string
          }
          if (!response.ok) {
            const permanent =
              response.status >= 400 &&
              response.status < 500 &&
              response.status !== 408 &&
              response.status !== 429
            throw new RequestStatusError(
              payload.error ?? `Request status failed (${response.status})`,
              permanent,
            )
          }
          if (!isRequestStatusResponse(payload)) {
            throw new RequestStatusError('AI request status response was incomplete', false)
          }
          options.onConnectionChange?.(false)
          options.onUpdate?.(payload)
          if (payload.status !== 'queued' && payload.status !== 'running') return payload
          retryDelayMs = 750
          await waitWithSignal(750, options.signal)
        } catch (statusError) {
          if (options.signal?.aborted) throw statusError
          if (statusError instanceof RequestStatusError && statusError.permanent) throw statusError
          options.onConnectionChange?.(true)
          await waitWithSignal(retryDelayMs, options.signal)
          retryDelayMs = Math.min(5_000, Math.ceil(retryDelayMs * 1.5))
        }
      }
      throw new Error(
        'The AI request is still running after 30 minutes. Refresh later to check its status.',
      )
    },
    [],
  )

  const maybeRedirectToScene = useCallback(
    (body: Record<string, unknown>, target: WorkflowSession) => {
      const generatedUrl = target.sceneResult?.editorUrl
      if (
        body.action === 'confirm' &&
        generatedUrl &&
        (target.phase === 'completed' || target.phase === 'completed_with_issues') &&
        !sceneId
      ) {
        window.location.assign(editorHref(generatedUrl))
      }
    },
    [sceneId],
  )

  useEffect(() => {
    if (!sessionId) return
    const active = readActiveRequest(sessionId)
    if (!active) return
    const controller = new AbortController()
    setBusy(true)
    setError('')
    setRequestProgress({
      requestId: active.requestId,
      traceId: active.traceId,
      clientRequestId: active.clientRequestId,
      sessionId: active.sessionId,
      kind: active.kind,
      status: 'running',
      steps: [],
    })
    void waitForRequest(active.requestId, {
      signal: controller.signal,
      onUpdate: setRequestProgress,
      onConnectionChange: setPollReconnecting,
    })
      .then(async (completed) => {
        forgetActiveRequest(sessionId, active.requestId)
        const ok = completed.status === 'succeeded' || completed.status === 'cancelled'
        recordRequest({
          clientRequestId: active.clientRequestId,
          requestId: completed.requestId,
          traceId: completed.traceId,
          kind: active.kind === 'cancel' ? 'cancel' : 'chat',
          status: ok ? 'ok' : 'error',
          at: new Date().toISOString(),
        })
        if (!ok || !completed.result) {
          const restored = await fetchSessionSnapshot(sessionId, controller.signal).catch(
            () => null,
          )
          if (controller.signal.aborted) return
          if (restored) {
            setSession(restored)
            setMessages((current) => mapSessionMessages(restored, current))
          }
          setError(completed.errorCode ?? `AI request ${completed.status}`)
          return
        }
        const result = completed.result
        setSession(result.session)
        setMessages((current) => mapSessionMessages(result.session, current))
        maybeRedirectToScene(active.kind === 'confirm' ? { action: 'confirm' } : {}, result.session)
      })
      .catch(async (resumeError: unknown) => {
        if (controller.signal.aborted) return
        if (resumeError instanceof RequestStatusError && resumeError.permanent) {
          forgetActiveRequest(sessionId, active.requestId)
          const restored = await fetchSessionSnapshot(sessionId, controller.signal).catch(
            () => null,
          )
          if (controller.signal.aborted) return
          if (restored) {
            setSession(restored)
            setMessages((current) => mapSessionMessages(restored, current))
          }
        }
        setError(resumeError instanceof Error ? resumeError.message : String(resumeError))
      })
      .finally(() => {
        if (controller.signal.aborted) return
        setBusy(false)
        setRequestProgress((current) => (current?.requestId === active.requestId ? null : current))
        setPollReconnecting(false)
      })
    return () => {
      controller.abort()
      setBusy(false)
      setRequestProgress((current) => (current?.requestId === active.requestId ? null : current))
      setPollReconnecting(false)
    }
  }, [maybeRedirectToScene, recordRequest, sessionId, waitForRequest])

  const callAgent = useCallback(
    async (body: Record<string, unknown>) => {
      if (!sessionId) return false
      setBusy(true)
      setError('')
      const clientRequestId = crypto.randomUUID()
      const submission = submissionFor(sessionId, sceneId, body)
      const pending = pendingChatSubmissionRef.current
      const idempotencyKey =
        pending && sameSubmission(pending, submission)
          ? pending.idempotencyKey
          : crypto.randomUUID()
      pendingChatSubmissionRef.current = { ...submission, idempotencyKey }
      const clearPendingSubmission = () => {
        if (pendingChatSubmissionRef.current?.idempotencyKey === idempotencyKey) {
          pendingChatSubmissionRef.current = null
        }
      }
      let recorded = false
      let requestId: string | undefined
      let traceId: string | undefined
      try {
        const response = await fetch(`${aiAgentUrl()}/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId,
            clientRequestId,
            idempotencyKey,
            ...(sceneId ? { sceneId } : {}),
            ...body,
          }),
        })
        const accepted = (await response.json()) as AcceptedResponse & { error?: string }
        requestId = accepted.requestId
        traceId = accepted.traceId
        if (response.status !== 202) {
          clearPendingSubmission()
          throw new Error(accepted.error ?? `AI request failed (${response.status})`)
        }
        const requestKind: RequestKind =
          body.action === 'confirm' ? 'confirm' : body.action === 'cancel' ? 'cancel' : 'chat'
        rememberActiveRequest({
          requestId: accepted.requestId,
          traceId: accepted.traceId,
          clientRequestId,
          sessionId,
          kind: requestKind,
        })
        setRequestProgress({
          requestId: accepted.requestId,
          traceId: accepted.traceId,
          clientRequestId,
          sessionId,
          kind: requestKind,
          status: accepted.status,
          steps: [],
        })
        const completed = await waitForRequest(accepted.requestId, {
          onUpdate: setRequestProgress,
          onConnectionChange: setPollReconnecting,
        })
        forgetActiveRequest(sessionId, accepted.requestId)
        clearPendingSubmission()
        const ok = completed.status === 'succeeded' || completed.status === 'cancelled'
        recordRequest({
          clientRequestId,
          requestId: completed.requestId,
          traceId: completed.traceId,
          kind: 'chat',
          status: ok ? 'ok' : 'error',
          at: new Date().toISOString(),
        })
        recorded = true
        if (!ok || !completed.result) {
          throw new Error(completed.errorCode ?? `AI request ${completed.status}`)
        }
        const payload = completed.result
        setSession(payload.session)
        setMessages((current) => mapSessionMessages(payload.session, current))
        maybeRedirectToScene(body, payload.session)
        return true
      } catch (requestError) {
        // fetch itself failed (network error, aborted stream) — nothing was
        // recorded yet, so leave at least the client-side half of the trail.
        if (!recorded) {
          recordRequest({
            clientRequestId,
            ...(requestId ? { requestId } : {}),
            ...(traceId ? { traceId } : {}),
            kind: 'chat',
            status: 'error',
            at: new Date().toISOString(),
          })
        }
        if (requestId && requestError instanceof RequestStatusError && requestError.permanent) {
          forgetActiveRequest(sessionId, requestId)
        }
        setError(requestError instanceof Error ? requestError.message : String(requestError))
        return false
      } finally {
        setBusy(false)
        setRequestProgress((current) =>
          !requestId || current?.requestId === requestId ? null : current,
        )
        setPollReconnecting(false)
      }
    },
    [maybeRedirectToScene, recordRequest, sceneId, sessionId, waitForRequest],
  )

  // Stop an in-flight generation/modification. Sent as a separate, concurrent
  // request (not through the busy-gated `callAgent`) so it reaches the backend
  // while the long generation request is still pending — the backend aborts
  // that run, which then resolves with the cancelled session and updates the
  // UI. We deliberately don't setSession from here to avoid racing with it.
  const cancelGeneration = useCallback(async () => {
    if (!sessionId || cancelling) return
    setCancelling(true)
    const clientRequestId = crypto.randomUUID()
    const submission = submissionFor(sessionId, sceneId, { action: 'cancel' })
    const pending = pendingCancelSubmissionRef.current
    const idempotencyKey =
      pending && sameSubmission(pending, submission) ? pending.idempotencyKey : crypto.randomUUID()
    pendingCancelSubmissionRef.current = { ...submission, idempotencyKey }
    const clearPendingSubmission = () => {
      if (pendingCancelSubmissionRef.current?.idempotencyKey === idempotencyKey) {
        pendingCancelSubmissionRef.current = null
      }
    }
    let requestId: string | undefined
    let traceId: string | undefined
    let recorded = false
    try {
      const response = await fetch(`${aiAgentUrl()}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          clientRequestId,
          idempotencyKey,
          ...(sceneId ? { sceneId } : {}),
          action: 'cancel',
        }),
      })
      const accepted = (await response.json()) as AcceptedResponse & { error?: string }
      requestId = accepted.requestId
      traceId = accepted.traceId
      if (response.status !== 202) {
        clearPendingSubmission()
        throw new Error(accepted.error ?? `Cancel failed (${response.status})`)
      }
      rememberActiveRequest({
        requestId: accepted.requestId,
        traceId: accepted.traceId,
        clientRequestId,
        sessionId,
        kind: 'cancel',
      })
      const completed = await waitForRequest(accepted.requestId, {
        onConnectionChange: setPollReconnecting,
      })
      forgetActiveRequest(sessionId, accepted.requestId)
      clearPendingSubmission()
      const ok = completed.status === 'succeeded' || completed.status === 'cancelled'
      recordRequest({
        clientRequestId,
        requestId: completed.requestId,
        traceId: completed.traceId,
        kind: 'cancel',
        status: ok ? 'ok' : 'error',
        at: new Date().toISOString(),
      })
      recorded = true
      if (completed.result) {
        const result = completed.result
        setSession(result.session)
        setMessages((current) => mapSessionMessages(result.session, current))
      }
    } catch (cancelError) {
      // Best-effort: the in-flight request will still surface the outcome.
      if (!recorded) {
        recordRequest({
          clientRequestId,
          ...(requestId ? { requestId } : {}),
          ...(traceId ? { traceId } : {}),
          kind: 'cancel',
          status: 'error',
          at: new Date().toISOString(),
        })
      }
      if (requestId && cancelError instanceof RequestStatusError && cancelError.permanent) {
        forgetActiveRequest(sessionId, requestId)
      }
    } finally {
      setCancelling(false)
      setRequestProgress((current) =>
        !requestId || current?.requestId === requestId ? null : current,
      )
      setPollReconnecting(false)
    }
  }, [cancelling, recordRequest, sceneId, sessionId, waitForRequest])

  const send = useCallback(async () => {
    const message = input.trim()
    if ((!message && !imageDataUrl) || busy) return
    const image = imageDataUrl
    const submittedImageName = imageName
    const body = {
      ...(message ? { message } : {}),
      ...(image ? { imageDataUrl: image } : {}),
    }
    const pending = pendingChatSubmissionRef.current
    const retryingAmbiguousSubmission = Boolean(
      pending && sameSubmission(pending, submissionFor(sessionId, sceneId, body)),
    )
    if (!retryingAmbiguousSubmission) {
      setMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: 'user',
          content: image
            ? `${message || 'Please analyze this floor plan'}\n[Image: ${submittedImageName}]`
            : message,
        },
      ])
    }
    setInput('')
    setImageDataUrl(null)
    setImageName('')
    const completed = await callAgent(body)
    if (!completed) {
      setInput(message)
      setImageDataUrl(image)
      setImageName(image ? submittedImageName : '')
    }
  }, [busy, callAgent, imageDataUrl, imageName, input, sceneId, sessionId])

  const handleImage = useCallback(async (file: File | undefined) => {
    if (!file) return
    setError('')
    if (!['image/png', 'image/jpeg'].includes(file.type)) {
      setError('Only JPG, JPEG, or PNG floor plans are supported.')
      return
    }
    if (file.size > 20 * 1024 * 1024) {
      setError('The image must be smaller than 20 MB.')
      return
    }
    try {
      const bitmap = await createImageBitmap(file)
      const longSide = Math.max(bitmap.width, bitmap.height)
      const shortSide = Math.min(bitmap.width, bitmap.height)
      bitmap.close()
      if (longSide < 1200 || shortSide < 600) {
        setError(
          'Image resolution too low: at least 1200px on the long side and 600px on the short side.',
        )
        return
      }
      const reader = new FileReader()
      reader.onload = () => {
        setImageDataUrl(typeof reader.result === 'string' ? reader.result : null)
        setImageName(file.name)
      }
      reader.onerror = () => setError('Could not read the image. Please choose it again.')
      reader.readAsDataURL(file)
    } catch {
      setError('Could not parse the image. Please make sure the file is not corrupted.')
    }
  }, [])

  const clearSession = useCallback(async () => {
    if (!sessionId || busy) return
    const response = await fetch(`${aiAgentUrl()}/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
    })
    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as { error?: string }
      setError(
        payload.error === 'session_busy'
          ? 'This session still has a queued or running AI request. Wait for it to finish before clearing.'
          : (payload.error ?? `Could not clear session (${response.status}).`),
      )
      return
    }
    const storageKey = `pascal-ai-session:${sceneId ?? 'local-editor'}`
    window.localStorage.removeItem(storageKey)
    forgetActiveRequest(sessionId)
    pendingChatSubmissionRef.current = null
    pendingCancelSubmissionRef.current = null
    setSessionId(createSessionId(sceneId))
    setSession(null)
    setMessages([])
    setError('')
  }, [busy, sceneId, sessionId])

  const visiblePhase = requestProgress?.sessionPhase ?? session?.phase
  const visibleProgressSteps = requestProgress ? latestWorkflowSteps(requestProgress.steps) : []
  const canStopActiveRequest =
    busy &&
    !cancelling &&
    requestProgress?.kind !== 'cancel' &&
    (visiblePhase === 'generating' || visiblePhase === 'modifying')

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="flex h-11 shrink-0 items-center gap-2 border-border/70 border-b px-3">
        <Bot className="h-4 w-4 shrink-0" aria-hidden />
        <span className="truncate font-medium text-sm">AI Floor Plan Designer</span>
        {visiblePhase && (
          <span className="ml-auto rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
            {phaseLabel(visiblePhase)}
          </span>
        )}
        <button
          aria-label="Clear session"
          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={() => void clearSession()}
          type="button"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </header>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {messages.length === 0 && (
          <div className="rounded-xl border border-border/70 bg-muted/20 p-3 text-sm">
            <p className="font-medium">Describe the home you want</p>
            <p className="mt-1 text-muted-foreground text-xs leading-5">
              Enter the floor area, rooms, occupants, and constraints, or upload a floor plan image.
              I will ask follow-up questions when details are missing, and only change the scene
              after you confirm.
            </p>
          </div>
        )}
        {messages.map((message) => (
          <div
            className={
              message.role === 'user'
                ? 'ml-6 rounded-xl bg-blue-600 px-3 py-2 text-sm text-white'
                : 'mr-3 whitespace-pre-wrap rounded-xl border border-border/70 bg-muted/20 px-3 py-2 text-sm leading-5'
            }
            key={message.id}
          >
            {message.content}
          </div>
        ))}
        {(busy || cancelling) && (
          <div className="flex items-center gap-2 text-muted-foreground text-xs">
            <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
            <span>
              {cancelling
                ? 'Stopping the current request…'
                : requestProgressLabel(requestProgress, pollReconnecting, visiblePhase)}
            </span>
            {canStopActiveRequest && (
              <button
                className="ml-auto flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-muted disabled:opacity-50"
                disabled={cancelling}
                onClick={() => void cancelGeneration()}
                type="button"
              >
                <X className="h-3 w-3" />
                {cancelling ? 'Stopping…' : 'Stop generating'}
              </button>
            )}
          </div>
        )}
        {error && (
          <p className="rounded-lg bg-destructive/10 px-3 py-2 text-destructive text-xs">{error}</p>
        )}
        {(busy || cancelling) && visibleProgressSteps.length > 0 && (
          <div className="space-y-1 rounded-xl border border-border/70 bg-muted/20 p-3 text-xs">
            {visibleProgressSteps.map((step) => (
              <div className="flex items-center gap-2" key={step.operationKey}>
                <WorkflowStepIcon status={step.status} />
                <span>{workflowStepLabel(step.operationKey)}</span>
                {step.attemptNo > 1 && (
                  <span className="text-muted-foreground">attempt {step.attemptNo}</span>
                )}
              </div>
            ))}
          </div>
        )}
        {!busy && !cancelling && (session?.executionSteps?.length ?? 0) > 0 && (
          <div className="space-y-1 rounded-xl border border-border/70 bg-muted/20 p-3 text-xs">
            {session?.executionSteps?.map((step) => (
              <div className="flex items-center gap-2" key={step.phase}>
                <span
                  className={step.status === 'completed' ? 'text-green-600' : 'text-destructive'}
                >
                  {step.status === 'completed' ? '✓' : '×'}
                </span>
                <span>{step.label}</span>
              </div>
            ))}
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {(session?.phase === 'awaiting_confirmation' ||
        session?.phase === 'awaiting_modification_confirmation' ||
        session?.phase === 'clarifying') && (
        <div className="flex gap-2 border-border/70 border-t p-3">
          <button
            className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 font-medium text-sm text-white hover:bg-blue-500 disabled:opacity-50"
            disabled={busy}
            onClick={() => void callAgent({ action: 'confirm' })}
            type="button"
          >
            <Check className="h-4 w-4" />
            {session.phase === 'awaiting_modification_confirmation'
              ? 'Confirm and apply'
              : session.phase === 'clarifying'
                ? 'Accept defaults and generate'
                : 'Confirm and generate'}
          </button>
          <button
            className="flex items-center justify-center gap-1 rounded-lg border border-border px-3 py-2 text-sm hover:bg-muted disabled:opacity-50"
            disabled={busy}
            onClick={() => void callAgent({ action: 'cancel' })}
            type="button"
          >
            <X className="h-4 w-4" />
            Cancel
          </button>
        </div>
      )}

      {(session?.sceneResult?.remainingIssueCount ?? 0) > 0 && (
        <div className="mx-3 mb-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-amber-700 text-xs">
          Automated checks still found {session?.sceneResult?.remainingIssueCount} issue(s). You can
          open the scene to review, or keep typing change requests.
        </div>
      )}

      <div className="border-border/70 border-t p-3">
        {imageDataUrl && (
          <div className="mb-2 flex items-center gap-2 rounded-lg bg-muted px-2 py-1.5 text-xs">
            <ImagePlus className="h-3.5 w-3.5" />
            <span className="min-w-0 flex-1 truncate">{imageName}</span>
            <button
              onClick={() => {
                setImageDataUrl(null)
                setImageName('')
              }}
              type="button"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
        <div className="flex items-end gap-2">
          <button
            aria-label="Upload floor plan"
            className="rounded-lg border border-border p-2 text-muted-foreground hover:bg-muted hover:text-foreground"
            disabled={busy}
            onClick={() => fileInputRef.current?.click()}
            type="button"
          >
            <ImagePlus className="h-4 w-4" />
          </button>
          <input
            accept="image/jpeg,image/png"
            className="hidden"
            onChange={(event) => {
              void handleImage(event.target.files?.[0])
              event.target.value = ''
            }}
            ref={fileInputRef}
            type="file"
          />
          <textarea
            className="max-h-32 min-h-9 flex-1 resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus:border-blue-500"
            disabled={busy || session?.phase === 'generating' || session?.phase === 'modifying'}
            maxLength={5000}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                void send()
              }
            }}
            placeholder={
              session?.phase === 'clarifying'
                ? 'Answer the questions above…'
                : session?.phase === 'completed' || session?.phase === 'completed_with_issues'
                  ? 'Keep refining the current floor plan…'
                  : 'Describe the area, rooms, and design requirements…'
            }
            rows={1}
            value={input}
          />
          <button
            aria-label="Send"
            className="rounded-lg bg-blue-600 p-2 text-white hover:bg-blue-500 disabled:opacity-40"
            disabled={busy || (!input.trim() && !imageDataUrl)}
            onClick={() => void send()}
            type="button"
          >
            <Send className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  )
}

function submissionFor(
  sessionId: string,
  sceneId: string | undefined,
  body: Record<string, unknown>,
): Omit<PendingSubmission, 'idempotencyKey'> {
  return {
    sessionId,
    ...(sceneId ? { sceneId } : {}),
    ...(typeof body.message === 'string' ? { message: body.message } : {}),
    ...(typeof body.imageDataUrl === 'string' ? { imageDataUrl: body.imageDataUrl } : {}),
    ...(typeof body.action === 'string' ? { action: body.action } : {}),
  }
}

function sameSubmission(
  pending: PendingSubmission,
  next: Omit<PendingSubmission, 'idempotencyKey'>,
): boolean {
  return (
    pending.sessionId === next.sessionId &&
    pending.sceneId === next.sceneId &&
    pending.message === next.message &&
    pending.imageDataUrl === next.imageDataUrl &&
    pending.action === next.action
  )
}

function phaseLabel(phase: Phase): string {
  return {
    intake: 'Waiting for input',
    clarifying: 'Needs details',
    awaiting_confirmation: 'Awaiting confirmation',
    awaiting_modification_confirmation: 'Awaiting change confirmation',
    inspecting: 'Inspecting',
    generating: 'Generating',
    modifying: 'Modifying',
    completed: 'Completed',
    completed_with_issues: 'Needs review',
    cancelled: 'Cancelled',
    failed: 'Needs attention',
  }[phase]
}

function latestWorkflowSteps(steps: WorkflowStepProgress[]): WorkflowStepProgress[] {
  const latest = new Map<string, WorkflowStepProgress>()
  for (const step of steps) latest.set(step.operationKey, step)
  return [...latest.values()]
}

function workflowStepLabel(operationKey: string): string {
  if (operationKey.startsWith('repair:')) {
    return `Repairing detected issues (round ${operationKey.slice('repair:'.length)})`
  }
  return (
    {
      route: 'Routing the request',
      plan: 'Planning the layout',
      scaffold: 'Creating the scene',
      'structure-openings': 'Building rooms, walls, doors, and windows',
      furniture: 'Placing furniture',
      gates: 'Checking requirements',
      verification: 'Verifying the scene',
      modify: 'Applying requested changes',
      'modify-plan': 'Planning requested changes',
    }[operationKey] ?? operationKey
  )
}

function requestProgressLabel(
  progress: RequestStatusResponse | null,
  reconnecting: boolean,
  phase?: Phase,
): string {
  if (reconnecting) return 'Connection interrupted. Reconnecting to the running request…'
  if (progress?.status === 'queued') return 'Waiting in the AI request queue…'
  if (progress?.kind === 'cancel') return 'Stopping the current request…'
  const runningStep = [...(progress?.steps ?? [])]
    .reverse()
    .find((step) => step.status === 'running')
  if (runningStep) return `${workflowStepLabel(runningStep.operationKey)}…`
  if (phase === 'generating') return 'Generating and checking the scene…'
  if (phase === 'modifying') return 'Modifying and checking the scene…'
  if (phase === 'inspecting') return 'Inspecting the current scene…'
  return 'Understanding your requirements…'
}

function WorkflowStepIcon({ status }: { status: WorkflowStepStatus }) {
  if (status === 'running') {
    return <LoaderCircle className="h-3 w-3 animate-spin text-blue-600" aria-hidden />
  }
  if (status === 'succeeded') return <span className="text-green-600">✓</span>
  if (status === 'failed_recoverable') return <span className="text-amber-600">!</span>
  return <span className="text-destructive">×</span>
}
