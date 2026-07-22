import { Annotation } from '@langchain/langgraph'
import type { ChatInput, WorkflowSession } from './types'

export type WorkflowGraphState = {
  input: ChatInput
  session: WorkflowSession
  reply: string
  next: 'evaluate' | 'generate' | 'inspect' | 'modify' | 'finish'
}

export type DurableWorkflowNext = 'legacy' | 'plan' | 'construct' | 'finish'

export const DurableWorkflowState = Annotation.Root({
  sessionId: Annotation<string>,
  sessionVersion: Annotation<number>,
  requestId: Annotation<string>,
  phase: Annotation<WorkflowSession['phase']>,
  next: Annotation<DurableWorkflowNext>,
})

export type DurableWorkflowGraphState = typeof DurableWorkflowState.State
