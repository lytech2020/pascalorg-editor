import { NextResponse } from 'next/server'
import { getMeshyRemeshTask, parseMeshyTaskStatus } from '@/lib/pic-to-3d/meshy'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const taskId = new URL(request.url).searchParams.get('taskId')?.trim()
  if (!taskId) {
    return NextResponse.json({ error: 'taskId is required.' }, { status: 400 })
  }

  try {
    const task = await getMeshyRemeshTask(taskId)
    const parsed = parseMeshyTaskStatus(task)

    if (parsed.state === 'error') {
      return NextResponse.json({
        ok: false,
        state: 'error' as const,
        error: parsed.error,
      })
    }

    if (parsed.state === 'complete') {
      return NextResponse.json({
        ok: true,
        state: 'complete' as const,
        taskId,
        downloadName: `meshy-remesh-${taskId}.glb`,
        progress: parsed.progress,
      })
    }

    return NextResponse.json({
      ok: true,
      state: 'pending' as const,
      progress: parsed.progress,
      status: parsed.status,
      precedingTasks: task.preceding_tasks,
    })
  } catch (error) {
    console.error('[pic-to-3d/meshy/remesh] status failed:', error)
    const message = error instanceof Error ? error.message : 'Failed to fetch Meshy remesh status.'
    const status = message.includes('MESHY_API_KEY') ? 503 : 502
    return NextResponse.json({ error: message }, { status })
  }
}
