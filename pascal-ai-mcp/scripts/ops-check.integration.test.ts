import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppDatabase } from '../src/persistence/database'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('ops:check CLI', () => {
  test('combines the live readiness contract with read-only queue metrics', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ops-check-'))
    directories.push(directory)
    const databaseFile = join(directory, 'ai.db')
    const database = new AppDatabase(databaseFile)
    database.close()
    const port = await availablePort()
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port,
      fetch(request) {
        if (request.headers.get('authorization') !== 'Bearer test-readiness-token') {
          return Response.json({ error: 'unauthorized' }, { status: 401 })
        }
        return Response.json(healthyReadiness())
      },
    })
    try {
      const process = Bun.spawn(['bun', 'scripts/ops-check.ts'], {
        cwd: join(import.meta.dir, '..'),
        env: {
          ...Bun.env,
          AI_MCP_DATABASE_FILE: databaseFile,
          AI_MCP_SESSION_FILE: join(directory, 'sessions.json'),
          AI_MCP_REQUEST_ARTIFACTS_DIR: join(directory, 'artifacts'),
          AI_MCP_READINESS_TOKEN: 'test-readiness-token',
          AI_MCP_OPS_READY_URL: `http://127.0.0.1:${port}/ready`,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
        process.exited,
      ])
      expect(exitCode).toBe(0)
      expect(stderr).toBe('')
      expect(JSON.parse(stdout)).toMatchObject({
        healthy: true,
        exitCode: 0,
        metrics: {
          queuedCount: 0,
          expiredRunningLeases: 0,
          recentFailureRate: 0,
        },
        findings: [],
      })
    } finally {
      server.stop(true)
    }
  })
})

function healthyReadiness() {
  return {
    ready: true,
    checks: {
      database: { ready: true },
      checkpoints: { ready: true, graphVersion: 'graph-v1' },
      templates: {
        ready: true,
        files: 15,
        loaded: 15,
        good: 14,
        bad: 1,
        failed: 0,
        acceptsTraffic: true,
      },
      mcp: { ready: true, state: 'ready', generation: 1, failureCount: 0 },
      telemetry: { ready: true, failureCount: 0 },
      modelProvider: { ready: true, configured: true, degraded: false },
    },
  }
}

function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      if (!address || typeof address === 'string') {
        probe.close()
        reject(new Error('failed to allocate an ops-check test port'))
        return
      }
      probe.close(error => error ? reject(error) : resolve(address.port))
    })
  })
}
