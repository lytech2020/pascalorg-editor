import type { DurableWorkflowGraphState } from '../workflow-state'

export type WorkflowSnapshot = {
  values: DurableWorkflowGraphState
  next: string[]
  interrupted: boolean
}

export type WorkflowNodes = {
  route: (state: DurableWorkflowGraphState) => Promise<Partial<DurableWorkflowGraphState>>
  legacy: (state: DurableWorkflowGraphState) => Promise<Partial<DurableWorkflowGraphState>>
  plan: (state: DurableWorkflowGraphState) => Promise<Partial<DurableWorkflowGraphState>>
  construct: (state: DurableWorkflowGraphState) => Promise<Partial<DurableWorkflowGraphState>>
}

export interface WorkflowRuntime {
  start(state: DurableWorkflowGraphState, workflowRunId: string): Promise<DurableWorkflowGraphState>
  resume(workflowRunId: string, requestId: string): Promise<DurableWorkflowGraphState>
  retryPending(workflowRunId: string): Promise<DurableWorkflowGraphState>
  snapshot(workflowRunId: string): Promise<WorkflowSnapshot | undefined>
}

export type WorkflowRuntimeFactory = (nodes: WorkflowNodes) => WorkflowRuntime

export interface WorkflowCheckpointStore {
  deleteThread(workflowRunId: string): Promise<void>
}
