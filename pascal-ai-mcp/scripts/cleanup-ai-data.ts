import { loadConfig } from '../src/config'
import { AppDatabase } from '../src/persistence/database'
import { ArtifactRepository } from '../src/persistence/artifact-repository'
import { SqliteCheckpointSaver } from '../src/persistence/sqlite-checkpoint-saver'
import { RequestPayloadStore } from '../src/request-payload-store'
import { WORKFLOW_GRAPH_VERSION } from '../src/workflow-identity'

const execute = process.argv.includes('--execute')
const deleteIncompatible = process.argv.includes('--delete-incompatible')
if (deleteIncompatible && !execute) {
  throw new Error('--delete-incompatible requires --execute')
}

const config = loadConfig()
const database = new AppDatabase(config.databaseFile)
const saver = new SqliteCheckpointSaver(database, {
  graphVersion: WORKFLOW_GRAPH_VERSION,
  ttlMs: config.workflowCheckpointTtlMs,
})
const payloads = new RequestPayloadStore(
  config.requestArtifactsDir,
  new ArtifactRepository(database),
  config.requestArtifactTtlMs,
)

try {
  const report = saver.maintenanceReport()
  const artifactReport = payloads.maintenanceReport()
  console.log(JSON.stringify({
    mode: execute ? 'execute' : 'dry-run',
    checkpoints: {
      expiredThreads: report.expiredThreadIds.length,
      incompatibleThreads: report.incompatible.length,
      incompatibleGraphVersions: [...new Set(
        report.incompatible.flatMap(entry => entry.graphVersions),
      )],
    },
    artifacts: {
      databaseCandidates: artifactReport.databaseCandidates.length,
      orphanFiles: artifactReport.orphanStorageKeys.length,
    },
  }))
  if (execute) {
    const pruned = saver.pruneExpired()
    const incompatibleDeleted = deleteIncompatible ? saver.deleteIncompatibleThreads() : 0
    const artifactCleanup = payloads.cleanup()
    console.log(JSON.stringify({ pruned, incompatibleDeleted, artifactCleanup }))
  }
} finally {
  saver.close()
  database.close()
}
