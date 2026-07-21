import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { runMigrations } from './migrations'

export class AppDatabase {
  readonly connection: Database

  constructor(filePath: string) {
    if (filePath !== ':memory:') mkdirSync(dirname(filePath), { recursive: true })
    this.connection = new Database(filePath, { create: true, strict: true })
    this.connection.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
    if (filePath !== ':memory:') {
      this.connection.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;')
    }
    runMigrations(this.connection)
  }

  transaction<T>(work: () => T): T {
    return this.connection.transaction(work)()
  }

  close(): void {
    this.connection.close()
  }
}
