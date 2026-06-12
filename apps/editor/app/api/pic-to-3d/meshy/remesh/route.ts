import { NextResponse } from 'next/server'
import { createMeshyRemeshTask } from '@/lib/pic-to-3d/meshy'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 120

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      inputTaskId?: string
      targetPolycount?: number
    }

    const inputTaskId = body.inputTaskId?.trim()
    if (!inputTaskId) {
      return NextResponse.json({ error: 'input_task_id is required.' }, { status: 400 })
    }

    const targetPolycount =
      typeof body.targetPolycount === 'number' && Number.isFinite(body.targetPolycount)
        ? body.targetPolycount
        : 30_000

    const taskId = await createMeshyRemeshTask(inputTaskId, { targetPolycount })

    return NextResponse.json({
      ok: true,
      taskId,
      message: 'Submitted to Meshy Remesh. Waiting for processing...',
    })
  } catch (error) {
    console.error('[pic-to-3d/meshy/remesh] create failed:', error)
    const message =
      error instanceof Error ? error.message : 'Failed to submit Meshy remesh task.'
    const status = message.includes('MESHY_API_KEY') ? 503 : 502
    return NextResponse.json({ error: message }, { status })
  }
}
