import { NextResponse } from 'next/server'
import { type MeshyApiKind, downloadMeshyGlb } from '@/lib/pic-to-3d/meshy'

function parseMeshyKind(value: string | null): MeshyApiKind {
  return value === 'remesh' ? 'remesh' : 'image-to-3d'
}

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams
  const taskId = params.get('taskId')?.trim()
  if (!taskId) {
    return NextResponse.json({ error: 'taskId is required.' }, { status: 400 })
  }
  const kind = parseMeshyKind(params.get('kind'))

  try {
    const buffer = await downloadMeshyGlb(kind, taskId)
    const prefix = kind === 'remesh' ? 'meshy-remesh' : 'meshy'
    const downloadName =
      params.get('downloadName')?.trim() || `${prefix}-${taskId}.glb`

    return new NextResponse(buffer, {
      headers: {
        'Content-Type': 'model/gltf-binary',
        'Content-Disposition': `attachment; filename="${downloadName.replace(/"/g, '')}"`,
        'Cache-Control': 'no-store',
      },
    })
  } catch (error) {
    console.error('[pic-to-3d/meshy] download failed:', error)
    const message = error instanceof Error ? error.message : 'Failed to download Meshy GLB.'
    const status = message.includes('MESHY_API_KEY') ? 503 : 502
    return NextResponse.json({ error: message }, { status })
  }
}
