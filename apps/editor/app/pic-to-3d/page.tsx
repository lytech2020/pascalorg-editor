'use client'

import { ImagePlus, Loader2, Sparkles, Wrench } from 'lucide-react'
import Link from 'next/link'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { readApiJson } from '@/lib/pic-to-3d/read-api-json'
import { DetailPresetPicker, type DetailPreset } from './detail-preset-picker'
import { GlbPreviewPanel } from './glb-preview'
import type { PicTo3DParams } from './param-panel'

const PRESET_STORAGE_KEY = 'pic-to-3d-preset-v1'

type JobState = 'idle' | 'uploading' | 'processing' | 'complete' | 'error'

type GlbRef = {
  filename: string
  subfolder: string
  type: string
}

type GlbOutput =
  | { source: 'comfyui'; glb: GlbRef; downloadName: string }
  | { source: 'meshy-image-to-3d'; taskId: string; downloadName: string }
  | { source: 'meshy-remesh'; taskId: string; downloadName: string }
  | null

type JobBackend = 'comfyui' | 'meshy-image-to-3d' | 'meshy-remesh' | null

const DEFAULT_REMESH_POLYCOUNT = 30_000
const DEFAULT_MESHY_POLYCOUNT = 50_000

export default function PicTo3DPage() {
  const [file, setFile] = useState<File | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [jobState, setJobState] = useState<JobState>('idle')
  const [backend, setBackend] = useState<JobBackend>(null)
  const [promptId, setPromptId] = useState<string | null>(null)
  const [meshyTaskId, setMeshyTaskId] = useState<string | null>(null)
  const [meshyShouldRemesh, setMeshyShouldRemesh] = useState(true)
  const [meshyTargetPolycount, setMeshyTargetPolycount] = useState(String(DEFAULT_MESHY_POLYCOUNT))
  const [remeshInputTaskId, setRemeshInputTaskId] = useState('')
  const [remeshTargetPolycount, setRemeshTargetPolycount] = useState(String(DEFAULT_REMESH_POLYCOUNT))
  const [remeshTaskId, setRemeshTaskId] = useState<string | null>(null)
  const [glbOutput, setGlbOutput] = useState<GlbOutput>(null)
  const [glbPreviewVersion, setGlbPreviewVersion] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [statusText, setStatusText] = useState('')
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const [dragOver, setDragOver] = useState(false)

  const [params, setParams] = useState<PicTo3DParams | null>(null)
  const [presets, setPresets] = useState<DetailPreset[]>([])
  const [selectedPresetId, setSelectedPresetId] = useState('default')

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch('/api/pic-to-3d/defaults')
        const body = await readApiJson<{
          defaults: PicTo3DParams
          presets: DetailPreset[]
        }>(response)
        if (!response.ok) return

        setPresets(body.presets)

        const storedId = localStorage.getItem(PRESET_STORAGE_KEY)
        const match =
          storedId && body.presets.some((p) => p.id === storedId)
            ? body.presets.find((p) => p.id === storedId)!
            : body.presets.find((p) => p.id === 'default') ?? body.presets[0]

        if (match) {
          setSelectedPresetId(match.id)
          setParams({ ...match.params })
        } else {
          setParams({ ...body.defaults })
        }
      } catch {
        /* ignore */
      }
    })()
  }, [])

  const selectPreset = useCallback((preset: DetailPreset) => {
    setSelectedPresetId(preset.id)
    setParams({ ...preset.params })
    try {
      localStorage.setItem(PRESET_STORAGE_KEY, preset.id)
    } catch {
      /* quota */
    }
  }, [])

  const clearPoll = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [])

  useEffect(() => {
    return () => {
      clearPoll()
      if (previewUrl) URL.revokeObjectURL(previewUrl)
    }
  }, [clearPoll, previewUrl])

  useEffect(() => {
    const preventDefaults = (event: DragEvent) => {
      event.preventDefault()
    }
    window.addEventListener('dragover', preventDefaults)
    window.addEventListener('drop', preventDefaults)
    return () => {
      window.removeEventListener('dragover', preventDefaults)
      window.removeEventListener('drop', preventDefaults)
    }
  }, [])

  const applyImageFile = useCallback(
    (next: File | null) => {
      if (previewUrl) URL.revokeObjectURL(previewUrl)
      setFile(next)
      setPreviewUrl(next ? URL.createObjectURL(next) : null)
      setJobState('idle')
      setBackend(null)
      setPromptId(null)
      setMeshyTaskId(null)
      setRemeshTaskId(null)
      setGlbOutput(null)
      setGlbPreviewVersion(0)
      setError(null)
      setStatusText('')
      clearPoll()
    },
    [clearPoll, previewUrl],
  )

  const acceptDroppedFile = (candidate: File | undefined) => {
    if (!candidate) return
    if (!candidate.type.startsWith('image/')) {
      setError('Use an image file such as JPG, PNG, or WebP.')
      return
    }
    applyImageFile(candidate)
  }

  const pollStatus = useCallback(
    (id: string) => {
      clearPoll()
      pollRef.current = setInterval(async () => {
        try {
          const response = await fetch(`/api/pic-to-3d/status?promptId=${encodeURIComponent(id)}`)
          const body = await readApiJson<{
            state?: string
            error?: string
            glb?: GlbRef
            downloadName?: string
          }>(response)

          if (!response.ok) {
            throw new Error(body.error ?? 'Failed to fetch status.')
          }

          if (body.state === 'pending') {
            setStatusText('ComfyUI is generating the 3D model (Hunyuan 3D 2.1)...')
            return
          }

          clearPoll()

          if (body.state === 'error') {
            setJobState('error')
            setError(body.error ?? 'Generation failed.')
            return
          }

          if (body.state === 'complete' && body.glb) {
            const name = body.downloadName ?? 'model.glb'
            setGlbOutput({
              source: 'comfyui',
              glb: body.glb,
              downloadName: name,
            })
            setGlbPreviewVersion((v) => v + 1)
            setJobState('complete')
            setStatusText('Generation complete. Preview the model on the right.')
          }
        } catch (pollError) {
          clearPoll()
          setJobState('error')
          setError(pollError instanceof Error ? pollError.message : 'Polling failed.')
        }
      }, 2000)
    },
    [clearPoll],
  )

  const pollMeshyImageTo3DStatus = useCallback(
    (id: string) => {
      clearPoll()
      pollRef.current = setInterval(async () => {
        try {
          const response = await fetch(`/api/pic-to-3d/meshy/status?taskId=${encodeURIComponent(id)}`)
          const body = await readApiJson<{
            state?: string
            error?: string
            progress?: number
            status?: string
            downloadName?: string
          }>(response)

          if (!response.ok) {
            throw new Error(body.error ?? 'Failed to fetch Meshy status.')
          }

          if (body.state === 'pending') {
            const progress =
              typeof body.progress === 'number' ? ` (${body.progress}%)` : ''
            const statusLabel = body.status ?? 'IN_PROGRESS'
            setStatusText(`Meshy Image to 3D${progress} — ${statusLabel}`)
            return
          }

          clearPoll()

          if (body.state === 'error') {
            setJobState('error')
            setError(body.error ?? 'Meshy generation failed.')
            return
          }

          if (body.state === 'complete') {
            const name = body.downloadName ?? `meshy-${id}.glb`
            setGlbOutput({
              source: 'meshy-image-to-3d',
              taskId: id,
              downloadName: name,
            })
            setGlbPreviewVersion((v) => v + 1)
            setJobState('complete')
            setStatusText('Meshy generation complete. Preview the model on the right.')
          }
        } catch (pollError) {
          clearPoll()
          setJobState('error')
          setError(pollError instanceof Error ? pollError.message : 'Meshy polling failed.')
        }
      }, 3000)
    },
    [clearPoll],
  )

  const pollRemeshStatus = useCallback(
    (id: string) => {
      clearPoll()
      pollRef.current = setInterval(async () => {
        try {
          const response = await fetch(
            `/api/pic-to-3d/meshy/remesh/status?taskId=${encodeURIComponent(id)}`,
          )
          const body = await readApiJson<{
            state?: string
            error?: string
            progress?: number
            status?: string
            precedingTasks?: number
            downloadName?: string
          }>(response)

          if (!response.ok) {
            throw new Error(body.error ?? 'Failed to fetch Meshy remesh status.')
          }

          if (body.state === 'pending') {
            const progress =
              typeof body.progress === 'number' ? ` (${body.progress}%)` : ''
            const queue =
              typeof body.precedingTasks === 'number' && body.precedingTasks > 0
                ? `, queue: ${body.precedingTasks}`
                : ''
            const statusLabel = body.status ?? 'IN_PROGRESS'
            setStatusText(`Meshy remesh in progress${progress} — ${statusLabel}${queue}`)
            return
          }

          clearPoll()

          if (body.state === 'error') {
            setJobState('error')
            setError(body.error ?? 'Meshy remesh failed.')
            return
          }

          if (body.state === 'complete') {
            const name = body.downloadName ?? `meshy-remesh-${id}.glb`
            setGlbOutput({
              source: 'meshy-remesh',
              taskId: id,
              downloadName: name,
            })
            setGlbPreviewVersion((v) => v + 1)
            setJobState('complete')
            setStatusText('Meshy remesh complete. Preview the model on the right.')
          }
        } catch (pollError) {
          clearPoll()
          setJobState('error')
          setError(pollError instanceof Error ? pollError.message : 'Meshy remesh polling failed.')
        }
      }, 3000)
    },
    [clearPoll],
  )

  const handleGenerate = async () => {
    if (!file) {
      setError('Select an image first.')
      return
    }
    if (!params) {
      setError('Parameters are still loading. Please wait.')
      return
    }

    setError(null)
    setGlbOutput(null)
    setGlbPreviewVersion(0)
    setPromptId(null)
    setMeshyTaskId(null)
    setRemeshTaskId(null)
    setBackend('comfyui')
    setJobState('uploading')
    setStatusText('Uploading image to ComfyUI...')

    const form = new FormData()
    form.append('image', file)
    form.append('params', JSON.stringify(params))

    try {
      const response = await fetch('/api/pic-to-3d/generate', { method: 'POST', body: form })
      const body = await readApiJson<{
        ok?: boolean
        promptId?: string
        error?: string
        message?: string
      }>(response)

      if (!response.ok || !body.promptId) {
        throw new Error(body.error ?? 'Submit failed.')
      }

      setPromptId(body.promptId)
      setJobState('processing')
      setStatusText(body.message ?? 'Queued. Waiting for generation...')
      pollStatus(body.promptId)
    } catch (generateError) {
      setJobState('error')
      setError(generateError instanceof Error ? generateError.message : 'Submit failed.')
    }
  }

  const handleMeshyGenerate = async () => {
    if (!file) {
      setError('Select an image first.')
      return
    }

    setError(null)
    setGlbOutput(null)
    setGlbPreviewVersion(0)
    setPromptId(null)
    setMeshyTaskId(null)
    setRemeshTaskId(null)
    setBackend('meshy-image-to-3d')
    const targetPolycount = Number.parseInt(meshyTargetPolycount.trim(), 10)
    if (
      meshyShouldRemesh &&
      (!Number.isFinite(targetPolycount) || targetPolycount < 100 || targetPolycount > 300_000)
    ) {
      setError('target_polycount must be between 100 and 300,000.')
      return
    }

    setJobState('uploading')
    setStatusText('Uploading image to Meshy...')

    const form = new FormData()
    form.append('image', file)
    form.append('shouldRemesh', meshyShouldRemesh ? 'true' : 'false')
    if (meshyShouldRemesh) {
      form.append('targetPolycount', String(targetPolycount))
    }

    try {
      const response = await fetch('/api/pic-to-3d/meshy/generate', { method: 'POST', body: form })
      const body = await readApiJson<{
        ok?: boolean
        taskId?: string
        error?: string
        message?: string
      }>(response)

      if (!response.ok || !body.taskId) {
        throw new Error(body.error ?? 'Meshy submit failed.')
      }

      setMeshyTaskId(body.taskId)
      setJobState('processing')
      setStatusText(body.message ?? 'Queued on Meshy. Waiting for generation...')
      pollMeshyImageTo3DStatus(body.taskId)
    } catch (generateError) {
      setJobState('error')
      setError(generateError instanceof Error ? generateError.message : 'Meshy submit failed.')
    }
  }

  const handleRemesh = async () => {
    const inputTaskId = remeshInputTaskId.trim()
    if (!inputTaskId) {
      setError('Enter a Meshy input_task_id (a completed image-to-3d task).')
      return
    }

    const targetPolycount = Number.parseInt(remeshTargetPolycount.trim(), 10)
    if (!Number.isFinite(targetPolycount) || targetPolycount < 100 || targetPolycount > 300_000) {
      setError('target_polycount must be between 100 and 300,000.')
      return
    }

    setError(null)
    setGlbOutput(null)
    setGlbPreviewVersion(0)
    setPromptId(null)
    setMeshyTaskId(null)
    setRemeshTaskId(null)
    setBackend('meshy-remesh')
    setJobState('processing')
    setStatusText('Submitting Meshy remesh task...')

    try {
      const response = await fetch('/api/pic-to-3d/meshy/remesh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inputTaskId, targetPolycount }),
      })
      const body = await readApiJson<{
        ok?: boolean
        taskId?: string
        error?: string
        message?: string
      }>(response)

      if (!response.ok || !body.taskId) {
        throw new Error(body.error ?? 'Meshy remesh submit failed.')
      }

      setRemeshTaskId(body.taskId)
      setStatusText(body.message ?? 'Queued on Meshy Remesh. Waiting for processing...')
      pollRemeshStatus(body.taskId)
    } catch (remeshError) {
      setJobState('error')
      setError(remeshError instanceof Error ? remeshError.message : 'Meshy remesh submit failed.')
    }
  }

  const downloadName = glbOutput?.downloadName ?? 'model.glb'

  const downloadUrl = useMemo(() => {
    if (!glbOutput || glbPreviewVersion === 0) return null
    if (glbOutput.source === 'comfyui') {
      return `/api/pic-to-3d/download?${new URLSearchParams({
        filename: glbOutput.glb.filename,
        subfolder: glbOutput.glb.subfolder,
        type: glbOutput.glb.type,
        downloadName: glbOutput.downloadName,
      }).toString()}`
    }
    const meshyKind = glbOutput.source === 'meshy-remesh' ? 'remesh' : 'image-to-3d'
    return `/api/pic-to-3d/meshy/download?${new URLSearchParams({
      kind: meshyKind,
      taskId: glbOutput.taskId,
      downloadName: glbOutput.downloadName,
    }).toString()}`
  }, [glbOutput, glbPreviewVersion])

  const glbPreviewUrl = useMemo(() => {
    if (!glbOutput || glbPreviewVersion === 0) return null
    if (glbOutput.source === 'comfyui') {
      const params = new URLSearchParams({
        filename: glbOutput.glb.filename,
        subfolder: glbOutput.glb.subfolder,
        type: glbOutput.glb.type,
        downloadName: glbOutput.downloadName,
        v: String(glbPreviewVersion),
      })
      return `/api/pic-to-3d/download?${params.toString()}`
    }
    const meshyKind = glbOutput.source === 'meshy-remesh' ? 'remesh' : 'image-to-3d'
    const params = new URLSearchParams({
      kind: meshyKind,
      taskId: glbOutput.taskId,
      downloadName: glbOutput.downloadName,
      v: String(glbPreviewVersion),
    })
    return `/api/pic-to-3d/meshy/download?${params.toString()}`
  }, [glbOutput, glbPreviewVersion])

  const busy = jobState === 'uploading' || jobState === 'processing'

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-10 border-border border-b bg-background/95 backdrop-blur">
        <div className="container mx-auto flex items-center justify-between gap-4 px-6 py-4">
          <nav className="flex items-center gap-4 text-sm">
            <Link
              className="text-muted-foreground transition-colors hover:text-foreground"
              href="/"
            >
              Editor
            </Link>
            <span className="text-muted-foreground">/</span>
            <span className="font-medium text-foreground">Image to 3D</span>
          </nav>
        </div>
      </header>

      <main className="container mx-auto max-w-6xl px-6 py-10">
        <div className="mb-6 space-y-2">
          <h1 className="flex items-center gap-2 font-bold text-2xl">
            <Sparkles className="size-6 text-primary" />
            Image to 3D
          </h1>
          <p className="text-muted-foreground text-sm leading-relaxed">
            Generate a GLB from a photo. Use ComfyUI (Hunyuan 3D 2.1) with detail presets, Meshy
            Image to 3D API, or Meshy Remesh on an existing task.
          </p>
        </div>

        <div className="grid gap-6 lg:grid-cols-[minmax(0,26rem)_1fr] lg:items-start">
          <div className="space-y-6 rounded-xl border border-border/60 bg-card p-6 shadow-sm">
            <label
              className={`flex cursor-pointer flex-col items-center justify-center gap-3 rounded-lg border border-dashed px-6 py-10 transition-colors ${
                dragOver
                  ? 'border-primary bg-primary/10'
                  : 'border-border bg-muted/20 hover:bg-muted/40'
              }`}
              htmlFor="pic-input"
              onDragEnter={(e) => {
                e.preventDefault()
                e.stopPropagation()
                if (!busy) setDragOver(true)
              }}
              onDragLeave={(e) => {
                e.preventDefault()
                e.stopPropagation()
                if (e.currentTarget.contains(e.relatedTarget as Node)) return
                setDragOver(false)
              }}
              onDragOver={(e) => {
                e.preventDefault()
                e.stopPropagation()
              }}
              onDrop={(e) => {
                e.preventDefault()
                e.stopPropagation()
                setDragOver(false)
                if (busy) return
                acceptDroppedFile(e.dataTransfer.files?.[0])
              }}
            >
              {previewUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  alt="Preview"
                  className="max-h-48 max-w-full rounded-lg object-contain"
                  src={previewUrl}
                />
              ) : (
                <>
                  <ImagePlus className="size-10 text-muted-foreground" />
                  <span className="text-muted-foreground text-sm">
                    Click or drag an image to upload (JPG / PNG)
                  </span>
                </>
              )}
              <input
                accept="image/*"
                className="sr-only"
                disabled={busy}
                id="pic-input"
                onChange={(e) => applyImageFile(e.target.files?.[0] ?? null)}
                type="file"
              />
            </label>

            {file && (
              <p className="text-center text-muted-foreground text-xs">
                {file.name} ({(file.size / 1024).toFixed(1)} KB)
              </p>
            )}

            {presets.length > 0 && (
              <DetailPresetPicker
                disabled={busy}
                onSelect={selectPreset}
                presets={presets}
                selectedId={selectedPresetId}
              />
            )}

            <button
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 font-medium text-primary-foreground text-sm transition-opacity disabled:cursor-not-allowed disabled:opacity-50"
              disabled={!file || busy || !params}
              onClick={() => void handleGenerate()}
              type="button"
            >
              {busy && backend === 'comfyui' ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {jobState === 'uploading' ? 'Uploading...' : 'Generating...'}
                </>
              ) : (
                <>
                  <Sparkles className="size-4" />
                  Generate with ComfyUI
                </>
              )}
            </button>

            <div className="space-y-3 rounded-lg border border-border/60 bg-muted/10 p-3">
              <p className="font-medium text-sm">Meshy Image to 3D</p>
              <label className="flex cursor-pointer items-center gap-2">
                <input
                  checked={meshyShouldRemesh}
                  className="size-4 rounded border-border"
                  disabled={busy}
                  onChange={(e) => setMeshyShouldRemesh(e.target.checked)}
                  type="checkbox"
                />
                <span className="text-sm">should_remesh</span>
              </label>
              <label className="block space-y-1">
                <span className="text-muted-foreground text-xs">
                  target_polycount (100–300,000){meshyShouldRemesh ? '' : ' — only used when remesh is on'}
                </span>
                <input
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-xs disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={busy || !meshyShouldRemesh}
                  inputMode="numeric"
                  onChange={(e) => setMeshyTargetPolycount(e.target.value)}
                  placeholder={String(DEFAULT_MESHY_POLYCOUNT)}
                  type="text"
                  value={meshyTargetPolycount}
                />
              </label>
              <button
                className="flex w-full items-center justify-center gap-2 rounded-lg border border-border bg-background px-4 py-2.5 font-medium text-sm transition-colors hover:bg-muted/40 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={!file || busy}
                onClick={() => void handleMeshyGenerate()}
                type="button"
              >
                {busy && backend === 'meshy-image-to-3d' ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    {jobState === 'uploading' ? 'Uploading...' : 'Generating...'}
                  </>
                ) : (
                  <>
                    <Sparkles className="size-4" />
                    Generate with Meshy
                  </>
                )}
              </button>
            </div>

            {statusText && jobState !== 'error' && (
              <p className="text-center text-muted-foreground text-xs">{statusText}</p>
            )}
            {promptId && backend === 'comfyui' && jobState === 'processing' && (
              <p className="text-center font-mono text-[10px] text-muted-foreground">
                ComfyUI task: {promptId}
              </p>
            )}
            {meshyTaskId && backend === 'meshy-image-to-3d' && jobState === 'processing' && (
              <p className="text-center font-mono text-[10px] text-muted-foreground">
                Meshy image-to-3d task: {meshyTaskId}
              </p>
            )}
            {remeshTaskId && backend === 'meshy-remesh' && jobState === 'processing' && (
              <p className="text-center font-mono text-[10px] text-muted-foreground">
                Meshy remesh task: {remeshTaskId}
              </p>
            )}

            <div className="space-y-3 border-border/60 border-t pt-4">
              <div className="space-y-1">
                <h2 className="font-medium text-sm">Meshy Remesh</h2>
                <p className="text-muted-foreground text-xs leading-relaxed">
                  Rebuild mesh from a completed Meshy image-to-3d task. See{' '}
                  <a
                    className="text-primary underline-offset-2 hover:underline"
                    href="https://docs.meshy.ai/zh/api/remesh"
                    rel="noreferrer"
                    target="_blank"
                  >
                    Remesh API
                  </a>
                  .
                </p>
              </div>
              <label className="block space-y-1">
                <span className="text-muted-foreground text-xs">input_task_id</span>
                <input
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-xs"
                  disabled={busy}
                  onChange={(e) => setRemeshInputTaskId(e.target.value)}
                  placeholder="018a210d-8ba4-705c-b111-1f1776f7f578"
                  type="text"
                  value={remeshInputTaskId}
                />
              </label>
              <label className="block space-y-1">
                <span className="text-muted-foreground text-xs">target_polycount (100–300,000)</span>
                <input
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-xs"
                  disabled={busy}
                  inputMode="numeric"
                  onChange={(e) => setRemeshTargetPolycount(e.target.value)}
                  placeholder={String(DEFAULT_REMESH_POLYCOUNT)}
                  type="text"
                  value={remeshTargetPolycount}
                />
              </label>
              <button
                className="flex w-full items-center justify-center gap-2 rounded-lg border border-border bg-background px-4 py-2.5 font-medium text-sm transition-colors hover:bg-muted/40 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={busy || !remeshInputTaskId.trim()}
                onClick={() => void handleRemesh()}
                type="button"
              >
                {busy && backend === 'meshy-remesh' ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    Remeshing...
                  </>
                ) : (
                  <>
                    <Wrench className="size-4" />
                    Run Meshy Remesh
                  </>
                )}
              </button>
            </div>

            {error && (
              <p className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-destructive text-sm">
                {error}
              </p>
            )}
          </div>

          <div className="lg:sticky lg:top-20">
            <GlbPreviewPanel
              downloadName={downloadName}
              downloadUrl={downloadUrl}
              glbUrl={glbPreviewUrl}
              status={jobState}
              statusText={jobState === 'error' ? error ?? undefined : statusText}
            />
          </div>
        </div>

        <p className="mt-6 text-muted-foreground text-xs leading-relaxed">
          The selected detail preset is saved in the browser. Ultra Detail takes longer and creates
          larger files, but is better for final output. Quick is intended for drafts and checks.
        </p>
      </main>
    </div>
  )
}
