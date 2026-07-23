import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppDatabase } from '../src/persistence/database'
import { createStoppedDataBackup, restoreStoppedDataBackup } from './stopped-data-backup'

describe('stopped data backup and rollback drill', () => {
  test('restores the old schema and payload instead of opening upgraded data with old code', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pascal-backup-drill-'))
    const live = join(root, 'live')
    const backup = join(root, 'backup')
    const restored = join(root, 'restored')
    const artifacts = join(live, 'request-artifacts')
    mkdirSync(artifacts, { recursive: true })
    writeFileSync(join(artifacts, 'request.bin'), 'private-test-artifact', { mode: 0o600 })
    const databaseFile = join(live, 'ai.db')

    const database = new AppDatabase(databaseFile)
    database.connection.exec(`
      CREATE TABLE drill_payload (
        id TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
      INSERT INTO drill_payload (id, value) VALUES ('before-upgrade', 'old-data');
    `)
    const schema = database.connection.query(
      'SELECT MAX(version) AS version FROM schema_migrations',
    ).get() as { version: number }
    database.close()

    const manifest = await createStoppedDataBackup({
      destination: backup,
      commit: 'old-commit-for-controlled-drill',
      databaseSchemaVersion: schema.version,
      sources: [
        { label: 'ai_data', path: live },
      ],
    })

    const upgraded = new Database(databaseFile, { strict: true })
    upgraded.exec(`
      INSERT INTO drill_payload (id, value) VALUES ('after-upgrade', 'new-data');
    `)
    upgraded.close()
    writeFileSync(join(artifacts, 'request.bin'), 'mutated-after-upgrade')

    rmSync(live, { recursive: true, force: true })
    const restoredManifest = await restoreStoppedDataBackup({
      backup,
      destination: restored,
    })
    const restoredDb = new Database(join(restored, 'ai_data', 'ai.db'), {
      readonly: true,
      strict: true,
    })
    const rows = restoredDb.query(
      'SELECT id, value FROM drill_payload ORDER BY id',
    ).all()
    const restoredSchema = restoredDb.query(
      'SELECT MAX(version) AS version FROM schema_migrations',
    ).get() as { version: number }
    restoredDb.close()

    expect(manifest.commit).toBe('old-commit-for-controlled-drill')
    expect(restoredManifest).toEqual(manifest)
    expect(rows).toEqual([{ id: 'before-upgrade', value: 'old-data' }])
    expect(restoredSchema.version).toBe(manifest.databaseSchemaVersion)
    expect(readFileSync(join(restored, 'ai_data', 'request-artifacts', 'request.bin'), 'utf8')).toBe(
      'private-test-artifact',
    )
    expect(existsSync(join(restored, 'manifest.json'))).toBe(false)
  })

  test('refuses overwrite and detects a corrupted backup before restore', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pascal-backup-corrupt-'))
    const source = join(root, 'source.txt')
    const backup = join(root, 'backup')
    writeFileSync(source, 'original')
    await createStoppedDataBackup({
      destination: backup,
      commit: 'commit-a',
      databaseSchemaVersion: 14,
      sources: [{ label: 'database', path: source }],
    })
    writeFileSync(join(backup, 'data', 'database'), 'corrupted')

    expect(
      restoreStoppedDataBackup({ backup, destination: join(root, 'restored') }),
    ).rejects.toThrow('backup checksum mismatch')
    expect(
      createStoppedDataBackup({
        destination: backup,
        commit: 'commit-b',
        databaseSchemaVersion: 14,
        sources: [{ label: 'database', path: source }],
      }),
    ).rejects.toThrow('backup destination already exists')
  })
})
