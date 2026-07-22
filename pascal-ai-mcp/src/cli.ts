import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { PascalAiAgent } from './agent'
import { loadConfig } from './config'
import { PascalMcpClient } from './mcp'
import { AppDatabase } from './persistence/database'
import { ModelCallRepository } from './persistence/model-call-repository'
import { ChatRequestRepository, SqliteSessionPersistence } from './persistence/session-repository'
import { SqliteModelAttemptRecorder } from './telemetry/model-attempt-recorder'
import { WorkflowStepRepository } from './persistence/workflow-step-repository'
import { SceneBuildRepository } from './persistence/scene-build-repository'
import { SqliteCheckpointSaver } from './persistence/sqlite-checkpoint-saver'
import { AiAuditRepository } from './persistence/audit-repository'
import { WORKFLOW_GRAPH_VERSION } from './workflow-identity'

const config = loadConfig()
const database = new AppDatabase(config.databaseFile)
const modelAttempts = new SqliteModelAttemptRecorder(new ModelCallRepository(database))
const sessions = new SqliteSessionPersistence(database)
sessions.importLegacyFile(config.sessionFile)
const requests = new ChatRequestRepository(database)
const workflowSteps = new WorkflowStepRepository(database)
const sceneBuilds = new SceneBuildRepository(database)
const audits = new AiAuditRepository(database)
const checkpointSaver = new SqliteCheckpointSaver(database, {
  graphVersion: WORKFLOW_GRAPH_VERSION,
  ttlMs: config.workflowCheckpointTtlMs,
})
const mcp = new PascalMcpClient(config)
await mcp.connect()

const agent = new PascalAiAgent(
  config,
  mcp,
  modelAttempts,
  sessions,
  requests,
  workflowSteps,
  sceneBuilds,
  checkpointSaver,
  audits,
)
const sessionId = process.env.AI_MCP_CLI_SESSION || 'cli'
const rl = createInterface({ input, output })

console.log(`Pascal AI MCP CLI. sessionId=${sessionId}. Type "exit" to quit.`)

try {
  while (true) {
    const message = await rl.question('> ')
    if (message.trim().toLowerCase() === 'exit') break
    const normalized = message.trim().toLowerCase()
    const result = await agent.chat(
      normalized === 'confirm'
        ? { sessionId, action: 'confirm' }
        : normalized === 'cancel'
          ? { sessionId, action: 'cancel' }
          : { sessionId, message },
    )
    console.log(result.reply)
    if (result.session.phase === 'awaiting_confirmation') {
      console.log('Type "confirm" to generate, or continue with a correction.')
    }
  }
} finally {
  rl.close()
  checkpointSaver.close()
  await mcp.close()
  database.close()
}
