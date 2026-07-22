import type { RunnableConfig } from '@langchain/core/runnables'
import {
  BaseCheckpointSaver,
  copyCheckpoint,
  type Checkpoint,
  type CheckpointMetadata,
  type CheckpointTuple,
} from '@langchain/langgraph'
import { WRITES_IDX_MAP } from '@langchain/langgraph-checkpoint'
import type { AppDatabase } from './database'

type CheckpointRow = {
  thread_id: string
  checkpoint_ns: string
  checkpoint_id: string
  parent_checkpoint_id: string | null
  checkpoint_type: string
  checkpoint_blob: Uint8Array
  metadata_type: string
  metadata_blob: Uint8Array
  graph_version: string
}

type WriteRow = {
  task_id: string
  channel: string
  value_type: string
  value_blob: Uint8Array
}

type CheckpointListOptions = {
  limit?: number
  before?: RunnableConfig
  filter?: Record<string, unknown>
}

export class CheckpointGraphVersionMismatchError extends Error {
  constructor(
    readonly expected: string,
    readonly actual: string,
  ) {
    super(`checkpoint graph version mismatch: expected ${expected}, actual ${actual}`)
    this.name = 'CheckpointGraphVersionMismatchError'
  }
}

export class SqliteCheckpointSaver extends BaseCheckpointSaver {
  private closed = false
  private readonly upsertCheckpointStatement
  private readonly exactCheckpointStatement
  private readonly latestCheckpointStatement
  private readonly writesStatement
  private readonly insertWriteStatement
  private readonly replaceWriteStatement
  private readonly extendThreadExpiryStatement
  private readonly deleteThreadStatement
  private readonly expiredThreadsStatement
  private readonly readinessStatement

  constructor(
    private readonly database: AppDatabase,
    private readonly options: { graphVersion: string; ttlMs: number },
  ) {
    super()
    if (!options.graphVersion.trim()) throw new Error('checkpoint graphVersion is required')
    if (!Number.isFinite(options.ttlMs) || options.ttlMs <= 0) {
      throw new Error('checkpoint ttlMs must be positive')
    }
    this.upsertCheckpointStatement = database.connection.prepare(`
      INSERT INTO langgraph_checkpoints (
        thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id,
        checkpoint_type, checkpoint_blob, metadata_type, metadata_blob,
        graph_version, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(thread_id, checkpoint_ns, checkpoint_id) DO UPDATE SET
        parent_checkpoint_id = excluded.parent_checkpoint_id,
        checkpoint_type = excluded.checkpoint_type,
        checkpoint_blob = excluded.checkpoint_blob,
        metadata_type = excluded.metadata_type,
        metadata_blob = excluded.metadata_blob,
        graph_version = excluded.graph_version,
        expires_at = excluded.expires_at
    `)
    this.exactCheckpointStatement = database.connection.prepare(`
      SELECT * FROM langgraph_checkpoints
      WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?
    `)
    this.latestCheckpointStatement = database.connection.prepare(`
      SELECT * FROM langgraph_checkpoints
      WHERE thread_id = ? AND checkpoint_ns = ?
      ORDER BY checkpoint_id DESC
      LIMIT 1
    `)
    this.writesStatement = database.connection.prepare(`
      SELECT task_id, channel, value_type, value_blob
      FROM langgraph_checkpoint_writes
      WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?
      ORDER BY task_id, write_index
    `)
    this.insertWriteStatement = database.connection.prepare(`
      INSERT OR IGNORE INTO langgraph_checkpoint_writes (
        thread_id, checkpoint_ns, checkpoint_id, task_id,
        write_index, channel, value_type, value_blob
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    this.replaceWriteStatement = database.connection.prepare(`
      INSERT INTO langgraph_checkpoint_writes (
        thread_id, checkpoint_ns, checkpoint_id, task_id,
        write_index, channel, value_type, value_blob
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(thread_id, checkpoint_ns, checkpoint_id, task_id, write_index)
      DO UPDATE SET
        channel = excluded.channel,
        value_type = excluded.value_type,
        value_blob = excluded.value_blob
    `)
    this.extendThreadExpiryStatement = database.connection.prepare(`
      UPDATE langgraph_checkpoints SET expires_at = ? WHERE thread_id = ?
    `)
    this.deleteThreadStatement = database.connection.prepare(`
      DELETE FROM langgraph_checkpoints WHERE thread_id = ?
    `)
    this.expiredThreadsStatement = database.connection.prepare(`
      SELECT thread_id
      FROM langgraph_checkpoints
      GROUP BY thread_id
      HAVING MAX(expires_at) <= ?
    `)
    this.readinessStatement = database.connection.prepare(`
      UPDATE langgraph_checkpoint_health SET checked_at = ? WHERE id = 1
    `)
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    this.assertOpen()
    this.assertGraphVersion(config)
    const threadId = optionalIdentifier(config.configurable?.thread_id, 'thread_id')
    if (!threadId) return undefined
    const checkpointNs = namespace(config.configurable?.checkpoint_ns)
    const checkpointId = optionalIdentifier(config.configurable?.checkpoint_id, 'checkpoint_id')
    const row = (checkpointId
      ? this.exactCheckpointStatement.get(threadId, checkpointNs, checkpointId)
      : this.latestCheckpointStatement.get(threadId, checkpointNs)) as CheckpointRow | undefined
    if (!row) return undefined
    this.assertRowVersion(row)
    return this.tupleFromRow(row)
  }

  async *list(
    config: RunnableConfig,
    options: CheckpointListOptions = {},
  ): AsyncGenerator<CheckpointTuple> {
    this.assertOpen()
    this.assertGraphVersion(config)
    const threadId = optionalIdentifier(config.configurable?.thread_id, 'thread_id')
    const checkpointNs = config.configurable?.checkpoint_ns === undefined
      ? undefined
      : namespace(config.configurable.checkpoint_ns)
    const checkpointId = optionalIdentifier(config.configurable?.checkpoint_id, 'checkpoint_id')
    const beforeId = optionalIdentifier(options.before?.configurable?.checkpoint_id, 'checkpoint_id')
    const clauses: string[] = []
    const params: string[] = []
    if (threadId) {
      clauses.push('thread_id = ?')
      params.push(threadId)
    }
    if (checkpointNs !== undefined) {
      clauses.push('checkpoint_ns = ?')
      params.push(checkpointNs)
    }
    if (checkpointId) {
      clauses.push('checkpoint_id = ?')
      params.push(checkpointId)
    }
    if (beforeId) {
      clauses.push('checkpoint_id < ?')
      params.push(beforeId)
    }
    const rows = this.database.connection.query(`
      SELECT * FROM langgraph_checkpoints
      ${clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''}
      ORDER BY checkpoint_id DESC
    `).all(...params) as CheckpointRow[]
    let remaining = options.limit
    for (const row of rows) {
      this.assertRowVersion(row)
      const tuple = await this.tupleFromRow(row)
      if (options.filter && !metadataMatches(tuple.metadata, options.filter)) continue
      if (remaining !== undefined) {
        if (remaining <= 0) break
        remaining--
      }
      yield tuple
    }
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
  ): Promise<RunnableConfig> {
    this.assertOpen()
    this.assertGraphVersion(config)
    const threadId = requiredIdentifier(config.configurable?.thread_id, 'thread_id')
    const checkpointNs = namespace(config.configurable?.checkpoint_ns)
    const checkpointId = requiredIdentifier(checkpoint.id, 'checkpoint_id')
    const parentCheckpointId = optionalIdentifier(config.configurable?.checkpoint_id, 'checkpoint_id')
    const prepared = copyCheckpoint(checkpoint)
    const [[checkpointType, checkpointBlob], [metadataType, metadataBlob]] = await Promise.all([
      this.serde.dumpsTyped(prepared),
      this.serde.dumpsTyped(metadata),
    ])
    const now = new Date()
    const expiresAt = new Date(now.getTime() + this.options.ttlMs).toISOString()
    this.database.transaction(() => {
      this.extendThreadExpiryStatement.run(expiresAt, threadId)
      this.upsertCheckpointStatement.run(
        threadId,
        checkpointNs,
        checkpointId,
        parentCheckpointId ?? null,
        checkpointType,
        checkpointBlob,
        metadataType,
        metadataBlob,
        this.options.graphVersion,
        now.toISOString(),
        expiresAt,
      )
    })
    return {
      configurable: {
        thread_id: threadId,
        checkpoint_ns: checkpointNs,
        checkpoint_id: checkpointId,
        graph_version: this.options.graphVersion,
      },
    }
  }

  async putWrites(
    config: RunnableConfig,
    writes: Array<[string, unknown]>,
    taskId: string,
  ): Promise<void> {
    this.assertOpen()
    this.assertGraphVersion(config)
    const threadId = requiredIdentifier(config.configurable?.thread_id, 'thread_id')
    const checkpointNs = namespace(config.configurable?.checkpoint_ns)
    const checkpointId = requiredIdentifier(config.configurable?.checkpoint_id, 'checkpoint_id')
    requiredIdentifier(taskId, 'task_id')
    const serialized = await Promise.all(writes.map(async ([channel, value], offset) => {
      const [valueType, valueBlob] = await this.serde.dumpsTyped(value)
      return {
        channel,
        index: WRITES_IDX_MAP[channel] ?? offset,
        valueType,
        valueBlob,
      }
    }))
    const expiresAt = new Date(Date.now() + this.options.ttlMs).toISOString()
    this.database.transaction(() => {
      this.extendThreadExpiryStatement.run(expiresAt, threadId)
      for (const write of serialized) {
        const statement = write.index < 0 ? this.replaceWriteStatement : this.insertWriteStatement
        statement.run(
          threadId,
          checkpointNs,
          checkpointId,
          taskId,
          write.index,
          write.channel,
          write.valueType,
          write.valueBlob,
        )
      }
    })
  }

  async deleteThread(threadId: string): Promise<void> {
    this.assertOpen()
    this.deleteThreadStatement.run(requiredIdentifier(threadId, 'thread_id'))
  }

  pruneExpired(now = new Date().toISOString()): number {
    this.assertOpen()
    return this.database.connection.transaction(() => {
      const rows = this.expiredThreadsStatement.all(now) as Array<{ thread_id: string }>
      for (const row of rows) this.deleteThreadStatement.run(row.thread_id)
      return rows.length
    }).immediate()
  }

  maintenanceReport(now = new Date().toISOString()): {
    expiredThreadIds: string[]
    incompatible: Array<{ threadId: string; graphVersions: string[] }>
  } {
    this.assertOpen()
    const expiredThreadIds = (this.expiredThreadsStatement.all(now) as Array<{ thread_id: string }>)
      .map(row => row.thread_id)
    const incompatibleRows = this.database.connection.query(`
      SELECT thread_id, graph_version
      FROM langgraph_checkpoints
      WHERE graph_version <> ?
      GROUP BY thread_id, graph_version
      ORDER BY thread_id, graph_version
    `).all(this.options.graphVersion) as Array<{ thread_id: string; graph_version: string }>
    const byThread = new Map<string, string[]>()
    for (const row of incompatibleRows) {
      const versions = byThread.get(row.thread_id) ?? []
      versions.push(row.graph_version)
      byThread.set(row.thread_id, versions)
    }
    return {
      expiredThreadIds,
      incompatible: [...byThread].map(([threadId, graphVersions]) => ({ threadId, graphVersions })),
    }
  }

  deleteIncompatibleThreads(): number {
    this.assertOpen()
    return this.database.connection.transaction(() => {
      const report = this.maintenanceReport()
      for (const entry of report.incompatible) this.deleteThreadStatement.run(entry.threadId)
      return report.incompatible.length
    }).immediate()
  }

  isWritable(): boolean {
    if (this.closed) return false
    try {
      return this.database.connection.transaction(() =>
        this.readinessStatement.run(new Date().toISOString()).changes === 1,
      ).immediate()
    } catch {
      return false
    }
  }

  close(): void {
    this.closed = true
  }

  private async tupleFromRow(row: CheckpointRow): Promise<CheckpointTuple> {
    const pendingWrites = await Promise.all(
      (this.writesStatement.all(
        row.thread_id,
        row.checkpoint_ns,
        row.checkpoint_id,
      ) as WriteRow[]).map(async write => [
        write.task_id,
        write.channel,
        await this.serde.loadsTyped(write.value_type, write.value_blob),
      ] as [string, string, unknown]),
    )
    const tuple: CheckpointTuple = {
      config: {
        configurable: {
          thread_id: row.thread_id,
          checkpoint_ns: row.checkpoint_ns,
          checkpoint_id: row.checkpoint_id,
          graph_version: row.graph_version,
        },
      },
      checkpoint: await this.serde.loadsTyped(row.checkpoint_type, row.checkpoint_blob) as Checkpoint,
      metadata: await this.serde.loadsTyped(row.metadata_type, row.metadata_blob) as CheckpointMetadata,
      pendingWrites,
    }
    if (row.parent_checkpoint_id) {
      tuple.parentConfig = {
        configurable: {
          thread_id: row.thread_id,
          checkpoint_ns: row.checkpoint_ns,
          checkpoint_id: row.parent_checkpoint_id,
          graph_version: row.graph_version,
        },
      }
    }
    return tuple
  }

  private assertGraphVersion(config: RunnableConfig): void {
    const configured = config.configurable?.graph_version
    if (configured !== undefined && configured !== this.options.graphVersion) {
      throw new CheckpointGraphVersionMismatchError(this.options.graphVersion, String(configured))
    }
  }

  private assertRowVersion(row: CheckpointRow): void {
    if (row.graph_version !== this.options.graphVersion) {
      throw new CheckpointGraphVersionMismatchError(this.options.graphVersion, row.graph_version)
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('checkpoint saver is closed')
  }
}

function requiredIdentifier(value: unknown, field: string): string {
  const identifier = optionalIdentifier(value, field)
  if (!identifier) throw new Error(`checkpoint ${field} is required`)
  return identifier
}

function optionalIdentifier(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,160}$/.test(value)) {
    throw new Error(`invalid checkpoint ${field}`)
  }
  return value
}

function namespace(value: unknown): string {
  if (value === undefined || value === null || value === '') return ''
  if (
    typeof value !== 'string'
    || value.length > 512
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error('invalid checkpoint checkpoint_ns')
  }
  return value
}

function metadataMatches(
  metadata: CheckpointMetadata | undefined,
  filter: Record<string, unknown>,
): boolean {
  if (!metadata) return false
  const fields = metadata as CheckpointMetadata & Record<string, unknown>
  return Object.entries(filter).every(([key, value]) => fields[key] === value)
}
