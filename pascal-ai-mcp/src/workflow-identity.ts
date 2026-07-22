export const WORKFLOW_GRAPH_VERSION = 'pascal-ai:v1'

export function createWorkflowRunId(): string {
  return crypto.randomUUID()
}
