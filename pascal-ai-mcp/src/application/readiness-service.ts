export type ReadinessMcpStatus = {
  ready: boolean
  state: string
  generation: number
  failureCount: number
  lastErrorCode?: string
  nextRetryAt?: string
}

export type ReadinessTelemetryStatus = {
  ok: boolean
  failureCount: number
}

export type ReadinessTemplateSummary = {
  ready: boolean
  files: number
  loaded: number
  good: number
  bad: number
  failed: number
  acceptsTraffic: boolean
}

export type ReadinessReport = {
  ready: boolean
  checks: {
    database: { ready: boolean }
    checkpoints: { ready: boolean; graphVersion: string }
    templates: ReadinessTemplateSummary
    mcp: ReadinessMcpStatus
    telemetry: { ready: boolean; failureCount: number }
    modelProvider: {
      ready: true
      configured: boolean
      degraded: boolean
    }
  }
}

export type ReadinessDependencies = {
  databaseWritable: () => boolean
  checkpointWritable: () => boolean
  checkMcpReady: () => Promise<boolean>
  mcpStatus: () => ReadinessMcpStatus
  telemetryStatus: () => ReadinessTelemetryStatus
  templates: ReadinessTemplateSummary
  graphVersion: string
  modelConfigured: boolean
  onMcpReady?: () => void
}

export class ReadinessService {
  constructor(private readonly dependencies: ReadinessDependencies) {}

  async check(): Promise<ReadinessReport> {
    const mcpReady = await this.dependencies.checkMcpReady()
    if (mcpReady) this.dependencies.onMcpReady?.()
    const databaseReady = this.dependencies.databaseWritable()
    const checkpointReady = this.dependencies.checkpointWritable()
    const telemetry = this.dependencies.telemetryStatus()
    const ready = databaseReady
      && checkpointReady
      && this.dependencies.templates.acceptsTraffic
      && mcpReady
      && telemetry.ok
    return {
      ready,
      checks: {
        database: { ready: databaseReady },
        checkpoints: {
          ready: checkpointReady,
          graphVersion: this.dependencies.graphVersion,
        },
        templates: this.dependencies.templates,
        mcp: this.dependencies.mcpStatus(),
        telemetry: {
          ready: telemetry.ok,
          failureCount: telemetry.failureCount,
        },
        modelProvider: {
          ready: true,
          configured: this.dependencies.modelConfigured,
          degraded: !this.dependencies.modelConfigured,
        },
      },
    }
  }
}
