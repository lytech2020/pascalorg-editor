import { loadConfig } from '../src/config'
import { AppDatabase } from '../src/persistence/database'
import { SqliteCheckpointSaver } from '../src/persistence/sqlite-checkpoint-saver'
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

try {
  const report = saver.maintenanceReport()
  console.log(JSON.stringify({
    mode: execute ? 'execute' : 'dry-run',
    checkpoints: {
      expiredThreads: report.expiredThreadIds.length,
      incompatibleThreads: report.incompatible.length,
      incompatibleGraphVersions: [...new Set(
        report.incompatible.flatMap(entry => entry.graphVersions),
      )],
    },
  }))
  if (execute) {
    const pruned = saver.pruneExpired()
    const incompatibleDeleted = deleteIncompatible ? saver.deleteIncompatibleThreads() : 0
    console.log(JSON.stringify({ pruned, incompatibleDeleted }))
  }
} finally {
  saver.close()
  database.close()
}
