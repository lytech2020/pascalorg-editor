import { loadConfig } from '../src/config'
import { PascalMcpClient } from '../src/mcp'
import { AppDatabase } from '../src/persistence/database'
import { SceneBuildRepository } from '../src/persistence/scene-build-repository'
import { cleanupAbandonedScenes } from '../src/scene-build-cleanup'

const config = loadConfig()
const database = new AppDatabase(config.databaseFile)
const builds = new SceneBuildRepository(database)
const mcp = new PascalMcpClient(config)

try {
  if (!process.argv.includes('--execute')) {
    console.log(JSON.stringify(
      {
        execute: false,
        warning:
          'Dry run only. Stop normal traffic and ensure abandoned scenes are not open for editing, then rerun with --execute.',
        candidates: builds.cleanupCandidates(),
      },
      null,
      2,
    ))
    process.exitCode = 2
  } else {
    await mcp.connect()
    const result = await cleanupAbandonedScenes(builds, (name, args) => mcp.callTool(name, args))
    console.log(JSON.stringify(result, null, 2))
    if (result.skipped.length > 0) process.exitCode = 1
  }
} finally {
  await mcp.close()
  database.close()
}
