import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, join, relative, resolve } from 'node:path'

export type StoppedDataSource = {
  label: string
  path: string
}

export type StoppedDataBackupManifest = {
  schemaVersion: 1
  createdAt: string
  commit: string
  databaseSchemaVersion: number
  sources: Array<{
    label: string
    originalBasename: string
    kind: 'file' | 'directory'
    files: Array<{ path: string; bytes: number; sha256: string }>
  }>
}

export async function createStoppedDataBackup(input: {
  destination: string
  commit: string
  databaseSchemaVersion: number
  sources: StoppedDataSource[]
}): Promise<StoppedDataBackupManifest> {
  const destination = resolve(input.destination)
  if (existsSync(destination)) throw new Error('backup destination already exists')
  const labels = new Set<string>()
  for (const source of input.sources) {
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(source.label)) {
      throw new Error(`invalid backup source label: ${source.label}`)
    }
    if (labels.has(source.label)) throw new Error(`duplicate backup source label: ${source.label}`)
    labels.add(source.label)
    if (!existsSync(source.path)) throw new Error(`backup source is missing: ${source.label}`)
  }

  mkdirSync(join(destination, 'data'), { recursive: true, mode: 0o700 })
  const manifest: StoppedDataBackupManifest = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    commit: input.commit,
    databaseSchemaVersion: input.databaseSchemaVersion,
    sources: [],
  }
  for (const source of input.sources) {
    const sourcePath = resolve(source.path)
    const target = join(destination, 'data', source.label)
    const kind = statSync(sourcePath).isDirectory() ? 'directory' : 'file'
    cpSync(sourcePath, target, {
      recursive: kind === 'directory',
      preserveTimestamps: true,
      errorOnExist: true,
    })
    manifest.sources.push({
      label: source.label,
      originalBasename: basename(sourcePath),
      kind,
      files: await inventory(target),
    })
  }
  writeFileSync(
    join(destination, 'manifest.json'),
    JSON.stringify(manifest, null, 2),
    { mode: 0o600 },
  )
  return manifest
}

export async function restoreStoppedDataBackup(input: {
  backup: string
  destination: string
}): Promise<StoppedDataBackupManifest> {
  const backup = resolve(input.backup)
  const destination = resolve(input.destination)
  if (existsSync(destination)) throw new Error('restore destination must not exist')
  const manifest = JSON.parse(
    readFileSync(join(backup, 'manifest.json'), 'utf8'),
  ) as StoppedDataBackupManifest
  validateManifest(manifest)
  for (const source of manifest.sources) {
    const stored = join(backup, 'data', source.label)
    const actual = await inventory(stored)
    if (JSON.stringify(actual) !== JSON.stringify(source.files)) {
      throw new Error(`backup checksum mismatch: ${source.label}`)
    }
  }

  mkdirSync(destination, { recursive: true, mode: 0o700 })
  for (const source of manifest.sources) {
    cpSync(join(backup, 'data', source.label), join(destination, source.label), {
      recursive: source.kind === 'directory',
      preserveTimestamps: true,
      errorOnExist: true,
    })
  }
  return manifest
}

async function inventory(root: string): Promise<Array<{
  path: string
  bytes: number
  sha256: string
}>> {
  const files = statSync(root).isDirectory()
    ? walkFiles(root)
    : [root]
  const result = await Promise.all(files.map(async file => {
    const bytes = readFileSync(file)
    return {
      path: statSync(root).isDirectory() ? relative(root, file) : basename(file),
      bytes: bytes.byteLength,
      sha256: Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex'),
    }
  }))
  return result.sort((a, b) => a.path.localeCompare(b.path))
}

function walkFiles(directory: string): string[] {
  const result: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) result.push(...walkFiles(path))
    else if (entry.isFile()) result.push(path)
  }
  return result
}

function validateManifest(manifest: StoppedDataBackupManifest): void {
  if (
    manifest.schemaVersion !== 1
    || typeof manifest.commit !== 'string'
    || manifest.commit.length === 0
    || !Number.isInteger(manifest.databaseSchemaVersion)
    || !Array.isArray(manifest.sources)
  ) {
    throw new Error('invalid stopped-data backup manifest')
  }
  for (const source of manifest.sources) {
    if (
      !/^[a-z][a-z0-9_-]{0,63}$/.test(source.label)
      || !['file', 'directory'].includes(source.kind)
      || !Array.isArray(source.files)
    ) {
      throw new Error('invalid stopped-data backup manifest source')
    }
  }
}
