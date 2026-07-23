import { describe, expect, test } from 'bun:test'
import { inspectExistingScene, planExistingSceneRequest } from './existing-scene-service'
import type { WorkflowSession } from '../types'

describe('existing scene application service', () => {
  test('routes destructive changes through confirmation', () => {
    const session = baseSession()
    const result = planExistingSceneRequest(session, 'remove that wall', 'delete')
    expect(result.next).toBe('finish')
    expect(result.session.phase).toBe('awaiting_modification_confirmation')
    expect(result.session.pendingOperation).toBe('delete')
  })

  test('a new modification clears stale mode consent from the previous request', () => {
    const session = baseSession()
    session.pendingModificationMode = 'plan_rebuild'
    session.pendingModificationReasonCode = 'remove_room'
    session.pendingModificationPlanHash = 'hash-a'
    session.modifyModeConfirmed = true
    session.modifyDriftConfirmed = true
    const result = planExistingSceneRequest(session, 'rename the bedroom', 'update')
    expect(result.session.pendingModificationMode).toBeUndefined()
    expect(result.session.pendingModificationReasonCode).toBeUndefined()
    expect(result.session.pendingModificationPlanHash).toBeUndefined()
    expect(result.session.modifyModeConfirmed).toBeUndefined()
    expect(result.session.modifyDriftConfirmed).toBeUndefined()
  })

  test('inspection owns state transitions without importing a scene adapter', async () => {
    const session = baseSession()
    let loaded = ''
    const result = await inspectExistingScene({
      session,
      question: 'How many rooms?',
      loadScene: async sceneId => { loaded = sceneId },
      answerQuestion: async () => 'Two rooms.',
      errorMessage: String,
    })
    expect(loaded).toBe('scene-1')
    expect(result).toMatchObject({ next: 'finish', reply: 'Two rooms.' })
    expect(result.session.phase).toBe('completed')
  })
})

function baseSession(): WorkflowSession {
  const now = '2026-07-22T00:00:00.000Z'
  return {
    sessionId: 'session-1',
    sceneId: 'scene-1',
    inputType: 'text',
    phase: 'completed',
    availability: 'usable',
    brief: {
      existingCondition: [], designGoals: [], hardConstraints: [], assumptions: [],
      uncertainties: [], conflicts: [],
    },
    questions: [], reasons: [], summary: '', messages: [], clarificationRounds: 0,
    createdAt: now, updatedAt: now,
  }
}
