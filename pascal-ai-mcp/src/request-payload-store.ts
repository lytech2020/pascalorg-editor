import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { QueuedChatInput } from './persistence/session-repository'

type ImageArtifact = NonNullable<QueuedChatInput['imageArtifact']>

export class RequestPayloadStore {
  constructor(private readonly rootDir: string) {
    mkdirSync(rootDir, { recursive: true, mode: 0o700 })
  }

  persistImage(dataUrl: string): ImageArtifact {
    const match = /^data:image\/(png|jpe?g);base64,([a-z0-9+/=]+)$/i.exec(dataUrl)
    if (!match) throw new Error('image payload is not a supported data URL')
    const mimeType: ImageArtifact['mimeType'] = match[1]!.toLowerCase() === 'png'
      ? 'image/png'
      : 'image/jpeg'
    const bytes = Buffer.from(match[2]!, 'base64')
    const id = randomUUID()
    const artifact: ImageArtifact = {
      id,
      mimeType,
      sizeBytes: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    }
    const target = this.pathFor(artifact)
    const temporary = `${target}.${randomUUID()}.tmp`
    try {
      writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 })
      renameSync(temporary, target)
    } catch (error) {
      rmSync(temporary, { force: true })
      throw error
    }
    return artifact
  }

  loadImage(artifact: ImageArtifact): string {
    const bytes = readFileSync(this.pathFor(artifact))
    if (bytes.byteLength !== artifact.sizeBytes) throw new Error(`artifact ${artifact.id} size mismatch`)
    const hash = createHash('sha256').update(bytes).digest('hex')
    if (hash !== artifact.sha256) throw new Error(`artifact ${artifact.id} hash mismatch`)
    return `data:${artifact.mimeType};base64,${bytes.toString('base64')}`
  }

  deleteImage(artifact: ImageArtifact | undefined): void {
    if (!artifact) return
    rmSync(this.pathFor(artifact), { force: true })
  }

  private pathFor(artifact: ImageArtifact): string {
    if (!/^[0-9a-f-]{36}$/i.test(artifact.id)) throw new Error('invalid artifact id')
    const extension = artifact.mimeType === 'image/png' ? 'png' : 'jpg'
    return join(this.rootDir, `${artifact.id}.${extension}`)
  }
}
