import { createHash, randomUUID } from 'node:crypto'
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import {
  type ArtifactMimeType,
  type ArtifactRecord,
  ArtifactRepository,
} from './persistence/artifact-repository'

const ORPHAN_GRACE_MS = 5 * 60 * 1000
const ARTIFACT_ID_PATTERN = /^[0-9a-f-]{36}$/i
const STORAGE_KEY_PATTERN = /^[0-9a-f-]{36}\.(?:png|jpg)$/i
const TEMPORARY_KEY_PATTERN = /^[0-9a-f-]{36}\.(?:png|jpg)\.[0-9a-f-]{36}\.tmp$/i

export type ArtifactIdentity = {
  requestId: string
  sessionId: string
  now?: Date
}

export type ArtifactMaintenanceReport = {
  databaseCandidates: string[]
  orphanStorageKeys: string[]
}

export type ArtifactCleanupResult = {
  deleted: number
  failed: number
}

export class RequestPayloadStore {
  constructor(
    private readonly rootDir: string,
    private readonly artifacts: ArtifactRepository,
    private readonly ttlMs: number,
  ) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error('artifact ttlMs must be positive')
    mkdirSync(rootDir, { recursive: true, mode: 0o700 })
  }

  persistImage(dataUrl: string, identity: ArtifactIdentity): string {
    const match = /^data:image\/(png|jpe?g);base64,([a-z0-9+/=]+)$/i.exec(dataUrl)
    if (!match) throw new Error('image payload is not a supported data URL')
    const mimeType: ArtifactMimeType = match[1]!.toLowerCase() === 'png'
      ? 'image/png'
      : 'image/jpeg'
    const bytes = Buffer.from(match[2]!, 'base64')
    const artifactId = randomUUID()
    const storageKey = `${artifactId}.${mimeType === 'image/png' ? 'png' : 'jpg'}`
    const target = this.pathForStorageKey(storageKey)
    const temporaryKey = `${storageKey}.${randomUUID()}.tmp`
    const temporary = this.pathForTemporaryKey(temporaryKey)
    const now = identity.now ?? new Date()
    try {
      writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 })
      renameSync(temporary, target)
      this.artifacts.create({
        artifactId,
        requestId: identity.requestId,
        sessionId: identity.sessionId,
        kind: 'request_image',
        storageKey,
        mimeType,
        sizeBytes: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        expiresAt: new Date(now.getTime() + this.ttlMs).toISOString(),
        createdAt: now.toISOString(),
      })
    } catch (error) {
      rmSync(temporary, { force: true })
      rmSync(target, { force: true })
      throw error
    }
    return artifactId
  }

  loadImage(artifactId: string): string {
    this.assertArtifactId(artifactId)
    const artifact = this.artifacts.findReadable(artifactId)
    if (!artifact) throw new Error(`artifact ${artifactId} is unavailable`)
    const bytes = readFileSync(this.pathForStorageKey(artifact.storageKey))
    if (bytes.byteLength !== artifact.sizeBytes) throw new Error(`artifact ${artifactId} size mismatch`)
    const hash = createHash('sha256').update(bytes).digest('hex')
    if (hash !== artifact.sha256) throw new Error(`artifact ${artifactId} hash mismatch`)
    return `data:${artifact.mimeType};base64,${bytes.toString('base64')}`
  }

  deleteImage(artifactId: string | undefined): void {
    if (!artifactId) return
    this.assertArtifactId(artifactId)
    const artifact = this.artifacts.find(artifactId)
    if (!artifact) {
      this.deleteUnregisteredFiles(artifactId)
      return
    }
    const now = new Date().toISOString()
    this.artifacts.markDeletePending(artifactId, now)
    try {
      rmSync(this.pathForStorageKey(artifact.storageKey), { force: true })
      this.artifacts.remove(artifactId)
    } catch (error) {
      this.artifacts.markDeleteFailed(artifactId, 'filesystem_delete_failed', new Date().toISOString())
      throw error
    }
  }

  deleteSessionImages(sessionId: string): ArtifactCleanupResult {
    return this.deleteRecords(this.artifacts.findBySessionId(sessionId))
  }

  maintenanceReport(now = new Date()): ArtifactMaintenanceReport {
    const orphanBefore = new Date(now.getTime() - ORPHAN_GRACE_MS)
    return {
      databaseCandidates: this.artifacts
        .cleanupCandidates(now.toISOString(), orphanBefore.toISOString())
        .map(record => record.artifactId),
      orphanStorageKeys: this.orphanStorageKeys(orphanBefore),
    }
  }

  cleanup(now = new Date()): ArtifactCleanupResult {
    const orphanBefore = new Date(now.getTime() - ORPHAN_GRACE_MS)
    const result = this.deleteRecords(
      this.artifacts.cleanupCandidates(now.toISOString(), orphanBefore.toISOString()),
    )
    for (const storageKey of this.orphanStorageKeys(orphanBefore)) {
      try {
        rmSync(this.pathForMaintenanceKey(storageKey), { force: true })
        result.deleted++
      } catch {
        result.failed++
      }
    }
    return result
  }

  private deleteRecords(records: ArtifactRecord[]): ArtifactCleanupResult {
    const result = { deleted: 0, failed: 0 }
    for (const record of records) {
      try {
        this.deleteImage(record.artifactId)
        result.deleted++
      } catch {
        result.failed++
      }
    }
    return result
  }

  private orphanStorageKeys(orphanBefore: Date): string[] {
    const referenced = this.artifacts.storageKeys()
    return readdirSync(this.rootDir, { withFileTypes: true })
      .filter(entry => entry.isFile() || entry.isDirectory())
      .map(entry => entry.name)
      .filter(name => STORAGE_KEY_PATTERN.test(name) || TEMPORARY_KEY_PATTERN.test(name))
      .filter(name => !referenced.has(name))
      .filter((name) => {
        try {
          return statSync(this.pathForMaintenanceKey(name)).mtime <= orphanBefore
        } catch {
          return false
        }
      })
      .sort()
  }

  private deleteUnregisteredFiles(artifactId: string): void {
    rmSync(this.pathForStorageKey(`${artifactId}.png`), { force: true })
    rmSync(this.pathForStorageKey(`${artifactId}.jpg`), { force: true })
  }

  private assertArtifactId(artifactId: string): void {
    if (!ARTIFACT_ID_PATTERN.test(artifactId)) throw new Error('invalid artifact id')
  }

  private pathForStorageKey(storageKey: string): string {
    if (!STORAGE_KEY_PATTERN.test(storageKey)) throw new Error('invalid artifact storage key')
    return join(this.rootDir, storageKey)
  }

  private pathForTemporaryKey(storageKey: string): string {
    if (!TEMPORARY_KEY_PATTERN.test(storageKey)) throw new Error('invalid temporary artifact key')
    return join(this.rootDir, storageKey)
  }

  private pathForMaintenanceKey(storageKey: string): string {
    if (!STORAGE_KEY_PATTERN.test(storageKey) && !TEMPORARY_KEY_PATTERN.test(storageKey)) {
      throw new Error('invalid maintenance artifact key')
    }
    return join(this.rootDir, storageKey)
  }
}
