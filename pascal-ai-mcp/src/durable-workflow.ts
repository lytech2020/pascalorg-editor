import type { RunnableConfig } from '@langchain/core/runnables'
import { Command, END, interrupt, START, StateGraph } from '@langchain/langgraph'
import type { SqliteCheckpointSaver } from './persistence/sqlite-checkpoint-saver'
import {
  DurableWorkflowState,
  type DurableWorkflowGraphState,
} from './workflow-state'
import { WORKFLOW_GRAPH_VERSION } from './workflow-identity'

export type DurableWorkflowSnapshot = {
  values: DurableWorkflowGraphState
  next: string[]
  interrupted: boolean
}

export type DurableWorkflowNodes = {
  route: (state: DurableWorkflowGraphState) => Promise<Partial<DurableWorkflowGraphState>>
  legacy: (state: DurableWorkflowGraphState) => Promise<Partial<DurableWorkflowGraphState>>
  plan: (state: DurableWorkflowGraphState) => Promise<Partial<DurableWorkflowGraphState>>
  construct: (state: DurableWorkflowGraphState) => Promise<Partial<DurableWorkflowGraphState>>
}

export class DurableWorkflowRuntime {
  private readonly graph

  constructor(nodes: DurableWorkflowNodes, saver: SqliteCheckpointSaver) {
    this.graph = new StateGraph(DurableWorkflowState)
      .addNode('route', nodes.route)
      .addNode('legacy', nodes.legacy)
      .addNode('plan', nodes.plan)
      .addNode('construct', nodes.construct)
      .addNode('wait', (state) => {
        const resumed = interrupt<
          { sessionId: string; sessionVersion: number; phase: string },
          { requestId: string }
        >({
          sessionId: state.sessionId,
          sessionVersion: state.sessionVersion,
          phase: state.phase,
        })
        if (!resumed || typeof resumed.requestId !== 'string') {
          throw new Error('workflow resume is missing requestId')
        }
        return { requestId: resumed.requestId, next: 'legacy' as const }
      })
      .addEdge(START, 'route')
      .addConditionalEdges('route', state => state.next, {
        legacy: 'legacy',
        plan: 'plan',
        construct: 'construct',
        finish: END,
      })
      .addConditionalEdges('legacy', waitingOrFinished, { wait: 'wait', finish: END })
      .addConditionalEdges('plan', state => state.next, {
        construct: 'construct',
        finish: END,
        legacy: 'legacy',
        plan: 'plan',
      })
      .addConditionalEdges('construct', waitingOrFinished, { wait: 'wait', finish: END })
      .addEdge('wait', 'route')
      .compile({ checkpointer: saver })
  }

  async start(state: DurableWorkflowGraphState, workflowRunId: string): Promise<DurableWorkflowGraphState> {
    return await this.graph.invoke(state, workflowConfig(workflowRunId))
  }

  async resume(workflowRunId: string, requestId: string): Promise<DurableWorkflowGraphState> {
    return await this.graph.invoke(
      new Command({ resume: { requestId } }),
      workflowConfig(workflowRunId),
    )
  }

  async retryPending(workflowRunId: string): Promise<DurableWorkflowGraphState> {
    return await this.graph.invoke(null, workflowConfig(workflowRunId))
  }

  async snapshot(workflowRunId: string): Promise<DurableWorkflowSnapshot | undefined> {
    const snapshot = await this.graph.getState(workflowConfig(workflowRunId))
    if (!snapshot.config?.configurable?.checkpoint_id) return undefined
    return {
      values: snapshot.values as DurableWorkflowGraphState,
      next: [...snapshot.next],
      interrupted: snapshot.tasks.some(task => task.interrupts.length > 0),
    }
  }
}

function waitingOrFinished(state: DurableWorkflowGraphState): 'wait' | 'finish' {
  return state.phase === 'clarifying'
    || state.phase === 'awaiting_confirmation'
    || state.phase === 'awaiting_modification_confirmation'
    ? 'wait'
    : 'finish'
}

function workflowConfig(workflowRunId: string): RunnableConfig {
  return {
    configurable: {
      thread_id: workflowRunId,
      checkpoint_ns: '',
      graph_version: WORKFLOW_GRAPH_VERSION,
    },
  }
}
