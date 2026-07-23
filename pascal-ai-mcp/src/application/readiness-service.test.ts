import { describe, expect, test } from 'bun:test'
import { ReadinessService, type ReadinessDependencies } from './readiness-service'

function dependencies(
  overrides: Partial<ReadinessDependencies> = {},
): ReadinessDependencies {
  return {
    databaseWritable: () => true,
    checkpointWritable: () => true,
    checkMcpReady: async () => true,
    mcpStatus: () => ({
      ready: true,
      state: 'ready',
      generation: 2,
      failureCount: 0,
    }),
    telemetryStatus: () => ({ ok: true, failureCount: 0 }),
    templates: {
      ready: true,
      files: 15,
      loaded: 15,
      good: 14,
      bad: 1,
      failed: 0,
      acceptsTraffic: true,
    },
    graphVersion: 'graph-v1',
    modelConfigured: true,
    ...overrides,
  }
}

describe('readiness application service', () => {
  test('preserves the authenticated /ready payload contract', async () => {
    let notified = 0
    const report = await new ReadinessService(dependencies({
      onMcpReady: () => notified++,
    })).check()
    expect(report).toEqual({
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
        mcp: {
          ready: true,
          state: 'ready',
          generation: 2,
          failureCount: 0,
        },
        telemetry: { ready: true, failureCount: 0 },
        modelProvider: { ready: true, configured: true, degraded: false },
      },
    })
    expect(notified).toBe(1)
  })

  test('reports every degraded dependency without exposing error text', async () => {
    const report = await new ReadinessService(dependencies({
      databaseWritable: () => false,
      checkpointWritable: () => false,
      checkMcpReady: async () => false,
      mcpStatus: () => ({
        ready: false,
        state: 'degraded',
        generation: 3,
        failureCount: 2,
        lastErrorCode: 'connection_refused',
      }),
      telemetryStatus: () => ({ ok: false, failureCount: 4 }),
      templates: {
        ...dependencies().templates,
        ready: false,
        failed: 1,
        acceptsTraffic: false,
      },
      modelConfigured: false,
    })).check()
    expect(report.ready).toBe(false)
    expect(report.checks).toMatchObject({
      database: { ready: false },
      checkpoints: { ready: false },
      templates: { ready: false, acceptsTraffic: false },
      mcp: { ready: false, lastErrorCode: 'connection_refused' },
      telemetry: { ready: false, failureCount: 4 },
      modelProvider: { configured: false, degraded: true },
    })
  })
})
