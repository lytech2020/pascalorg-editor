import { readApiJson } from './read-api-json'

const MESHY_API_BASE = 'https://api.meshy.ai'

export type MeshyTaskStatus = 'PENDING' | 'IN_PROGRESS' | 'SUCCEEDED' | 'FAILED' | 'CANCELED'

export type MeshyApiKind = 'image-to-3d' | 'remesh'

export type MeshyTask = {
  id: string
  status: MeshyTaskStatus
  progress: number
  model_urls?: {
    glb?: string
  }
  task_error?: {
    message?: string
  }
  preceding_tasks?: number
}

/** @deprecated Use MeshyTask */
export type MeshyImageTo3DTask = MeshyTask

export type MeshyRemeshOptions = {
  targetPolycount?: number
  topology?: 'quad' | 'triangle'
}

export type MeshyCreateTaskOptions = {
  aiModel?: 'meshy-5' | 'meshy-6' | 'latest'
  shouldTexture?: boolean
  enablePbr?: boolean
  shouldRemesh?: boolean
  targetPolycount?: number
}

function getMeshyApiKey(): string {
  const key = process.env.MESHY_API_KEY?.trim()
  if (!key) {
    throw new Error('MESHY_API_KEY is not configured.')
  }
  return key
}

async function meshyFetch(path: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(`${MESHY_API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${getMeshyApiKey()}`,
      ...(init?.headers ?? {}),
    },
  })
  return response
}

export function imageBytesToDataUri(bytes: Uint8Array, mimeType: string): string {
  const mime = mimeType === 'image/jpg' ? 'image/jpeg' : mimeType
  const base64 = Buffer.from(bytes).toString('base64')
  return `data:${mime};base64,${base64}`
}

export async function createMeshyImageTo3DTask(
  imageDataUri: string,
  options: MeshyCreateTaskOptions = {},
): Promise<string> {
  const shouldRemesh = options.shouldRemesh ?? true
  const targetPolycount = options.targetPolycount ?? 50_000
  if (!Number.isFinite(targetPolycount) || targetPolycount < 100 || targetPolycount > 300_000) {
    throw new Error('target_polycount must be between 100 and 300,000.')
  }

  const payload: Record<string, unknown> = {
    image_url: imageDataUri,
    ai_model: options.aiModel ?? 'latest',
    should_texture: options.shouldTexture ?? false,
    should_remesh: shouldRemesh,
    target_formats: ['glb'],
  }
  if (shouldRemesh) {
    payload.target_polycount = Math.round(targetPolycount)
  }

  const response = await meshyFetch('/openapi/v1/image-to-3d', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })

  const body = await readApiJson<{ result?: string; message?: string }>(response)
  if (!response.ok) {
    throw new Error(body.message ?? `Meshy create task failed (${response.status}).`)
  }
  if (!body.result) {
    throw new Error('Meshy did not return a task id.')
  }
  return body.result
}

function meshyTaskEndpoint(kind: MeshyApiKind, taskId: string): string {
  const base = kind === 'image-to-3d' ? '/openapi/v1/image-to-3d' : '/openapi/v1/remesh'
  return `${base}/${encodeURIComponent(taskId)}`
}

export async function getMeshyTask(kind: MeshyApiKind, taskId: string): Promise<MeshyTask> {
  const response = await meshyFetch(meshyTaskEndpoint(kind, taskId))
  const body = await readApiJson<MeshyTask & { message?: string }>(response)
  if (!response.ok) {
    throw new Error(body.message ?? `Meshy get task failed (${response.status}).`)
  }
  return body
}

export async function getMeshyImageTo3DTask(taskId: string): Promise<MeshyTask> {
  return getMeshyTask('image-to-3d', taskId)
}

export async function getMeshyRemeshTask(taskId: string): Promise<MeshyTask> {
  return getMeshyTask('remesh', taskId)
}

export async function createMeshyRemeshTask(
  inputTaskId: string,
  options: MeshyRemeshOptions = {},
): Promise<string> {
  const targetPolycount = options.targetPolycount ?? 30_000
  if (!Number.isFinite(targetPolycount) || targetPolycount < 100 || targetPolycount > 300_000) {
    throw new Error('target_polycount must be between 100 and 300,000.')
  }

  const response = await meshyFetch('/openapi/v1/remesh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      input_task_id: inputTaskId,
      target_polycount: Math.round(targetPolycount),
      target_formats: ['glb'],
      topology: options.topology ?? 'triangle',
    }),
  })

  const body = await readApiJson<{ result?: string; message?: string }>(response)
  if (!response.ok) {
    throw new Error(body.message ?? `Meshy remesh create failed (${response.status}).`)
  }
  if (!body.result) {
    throw new Error('Meshy did not return a remesh task id.')
  }
  return body.result
}

export async function downloadMeshyGlb(kind: MeshyApiKind, taskId: string): Promise<ArrayBuffer> {
  const task = await getMeshyTask(kind, taskId)
  if (task.status !== 'SUCCEEDED') {
    throw new Error(`Meshy task is not complete (status: ${task.status}).`)
  }

  const glbUrl = task.model_urls?.glb
  if (!glbUrl) {
    throw new Error('Meshy task succeeded but no GLB URL was returned.')
  }

  const response = await fetch(glbUrl)
  if (!response.ok) {
    throw new Error(`Failed to download GLB from Meshy (${response.status}).`)
  }
  return response.arrayBuffer()
}

export function parseMeshyTaskStatus(task: MeshyTask) {
  if (task.status === 'FAILED' || task.status === 'CANCELED') {
    return {
      state: 'error' as const,
      error: task.task_error?.message?.trim() || `Meshy task ${task.status.toLowerCase()}.`,
    }
  }

  if (task.status === 'SUCCEEDED' && task.model_urls?.glb) {
    return {
      state: 'complete' as const,
      progress: task.progress,
      glbUrl: task.model_urls.glb,
    }
  }

  return {
    state: 'pending' as const,
    progress: task.progress,
    status: task.status,
  }
}
