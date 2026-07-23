import type { ChatInput, WorkflowSession } from './types'

export type WorkflowGraphState = {
  input: ChatInput
  session: WorkflowSession
  reply: string
  next: 'evaluate' | 'generate' | 'inspect' | 'modify' | 'finish'
}

export type DurableWorkflowNext = 'legacy' | 'plan' | 'construct' | 'finish'

export type DurableWorkflowGraphState = {
  sessionId: string
  sessionVersion: number
  requestId: string
  phase: WorkflowSession['phase']
  next: DurableWorkflowNext
}
