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

type AcceptedResponse = {
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
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
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  errorCode?: string
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

function mapSessionMessages(session: WorkflowSession): UiMessage[] {
  return (session.messages ?? [])
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
}

function createSessionId(sceneId?: string): string {
  const storageKey = `pascal-ai-session:${sceneId ?? 'local-editor'}`
  const existing = window.localStorage.getItem(storageKey)
  if (existing) return existing
  const created = crypto.randomUUID()
  window.localStorage.setItem(storageKey, created)
  return created
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
    const controller = new AbortController()
    void fetch(`${aiAgentUrl()}/sessions/${encodeURIComponent(sessionId)}`, {
      cache: 'no-store',
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) return
        const payload = (await response.json()) as { session: WorkflowSession | null }
        if (!payload.session) return
        setSession(payload.session)
        setMessages(mapSessionMessages(payload.session))
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

  const waitForRequest = useCallback(async (requestId: string): Promise<RequestStatusResponse> => {
    const deadline = Date.now() + 30 * 60 * 1000
    while (Date.now() < deadline) {
      const response = await fetch(`${aiAgentUrl()}/requests/${encodeURIComponent(requestId)}`, {
        cache: 'no-store',
      })
      const payload = (await response.json()) as RequestStatusResponse & { error?: string }
      if (!response.ok)
        throw new Error(payload.error ?? `Request status failed (${response.status})`)
      if (payload.status !== 'queued' && payload.status !== 'running') return payload
      await new Promise((resolve) => setTimeout(resolve, 750))
    }
    throw new Error(
      'The AI request is still running after 30 minutes. Refresh later to check its status.',
    )
  }, [])

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
        const completed = await waitForRequest(accepted.requestId)
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
        setMessages((current) => [
          ...current,
          { id: crypto.randomUUID(), role: 'assistant', content: payload.reply },
        ])
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
        setError(requestError instanceof Error ? requestError.message : String(requestError))
        return false
      } finally {
        setBusy(false)
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
      const completed = await waitForRequest(accepted.requestId)
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
        setSession(completed.result.session)
        setMessages(mapSessionMessages(completed.result.session))
      }
    } catch {
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
    } finally {
      setCancelling(false)
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
    pendingChatSubmissionRef.current = null
    pendingCancelSubmissionRef.current = null
    setSessionId(createSessionId(sceneId))
    setSession(null)
    setMessages([])
    setError('')
  }, [busy, sceneId, sessionId])

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="flex h-11 shrink-0 items-center gap-2 border-border/70 border-b px-3">
        <Bot className="h-4 w-4 shrink-0" aria-hidden />
        <span className="truncate font-medium text-sm">AI Floor Plan Designer</span>
        {session && (
          <span className="ml-auto rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
            {phaseLabel(session.phase)}
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
        {busy && (
          <div className="flex items-center gap-2 text-muted-foreground text-xs">
            <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
            <span>
              {session?.phase === 'generating'
                ? 'Generating and checking the scene…'
                : session?.phase === 'modifying'
                  ? 'Modifying and checking the scene…'
                  : 'Understanding your requirements…'}
            </span>
            {(session?.phase === 'generating' || session?.phase === 'modifying') && (
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
        {(session?.executionSteps?.length ?? 0) > 0 && (
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
