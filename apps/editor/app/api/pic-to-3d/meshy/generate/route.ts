import { NextResponse } from 'next/server'
import { createMeshyImageTo3DTask, imageBytesToDataUri } from '@/lib/pic-to-3d/meshy'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const MAX_IMAGE_BYTES = 20 * 1024 * 1024
const SUPPORTED_MIME = new Set(['image/jpeg', 'image/jpg', 'image/png'])

export async function POST(request: Request) {
  try {
    const form = await request.formData()
    const file = form.get('image')
    if (!(file instanceof File) || file.size === 0) {
      return NextResponse.json({ error: 'Please upload an image file.' }, { status: 400 })
    }
    if (file.size > MAX_IMAGE_BYTES) {
      return NextResponse.json({ error: 'Image must be 20 MB or smaller.' }, { status: 400 })
    }

    const mime = file.type === 'image/jpg' ? 'image/jpeg' : file.type || 'image/jpeg'
    if (!SUPPORTED_MIME.has(mime)) {
      return NextResponse.json(
        { error: 'Meshy supports JPG and PNG only. Please convert WebP or other formats first.' },
        { status: 400 },
      )
    }

    const bytes = new Uint8Array(await file.arrayBuffer())
    const imageDataUri = imageBytesToDataUri(bytes, mime)

    const shouldRemeshRaw = form.get('shouldRemesh')
    const shouldRemesh =
      shouldRemeshRaw === null || shouldRemeshRaw === ''
        ? true
        : shouldRemeshRaw === 'true' || shouldRemeshRaw === '1'

    const targetPolycountRaw = form.get('targetPolycount')
    let targetPolycount = 50_000
    if (typeof targetPolycountRaw === 'string' && targetPolycountRaw.trim()) {
      targetPolycount = Number.parseInt(targetPolycountRaw.trim(), 10)
      if (!Number.isFinite(targetPolycount)) {
        return NextResponse.json({ error: 'target_polycount must be a number.' }, { status: 400 })
      }
    }

    const taskId = await createMeshyImageTo3DTask(imageDataUri, {
      shouldRemesh,
      targetPolycount,
    })

    return NextResponse.json({
      ok: true,
      taskId,
      message: 'Submitted to Meshy Image to 3D. Waiting for generation...',
    })
  } catch (error) {
    console.error('[pic-to-3d/meshy] generate failed:', error)
    const message =
      error instanceof Error ? error.message : 'Failed to submit Meshy Image to 3D task.'
    const status = message.includes('MESHY_API_KEY') ? 503 : 502
    return NextResponse.json({ error: message }, { status })
  }
}
