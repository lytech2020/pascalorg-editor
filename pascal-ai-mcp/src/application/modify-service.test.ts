import { describe, expect, test } from 'bun:test'
import type { WorkflowSession } from '../types'
import {
  effectiveGateFailures,
  finishModificationFailure,
  modifyFailureRecovery,
} from './modify-service'

describe('modify application service', () => {
  test('separates inherited gate failures from failures introduced by this change', () => {
    const inherited = { gate: 6, id: 'missing-stove', message: '缺少灶台' }
    const introduced = { gate: 6, id: 'missing-fridge', message: '缺少冰箱' }
    expect(effectiveGateFailures([inherited, introduced], [inherited], [])).toEqual({
      effective: [introduced],
      waived: [inherited],
    })
  })

  test('keeps a failed confirmed change retryable only while its intent remains pending', () => {
    expect(modifyFailureRecovery(true, true)).toEqual({
      canRetry: true,
      phase: 'awaiting_modification_confirmation',
    })
    expect(modifyFailureRecovery(false, true)).toEqual({
      canRetry: false,
      phase: 'completed_with_issues',
    })
  })

  test('owns the retry phase and user-visible failure reply', () => {
    const session = baseSession()
    const result = finishModificationFailure(session, 'failed', '连接中断')
    expect(result.session.phase).toBe('awaiting_modification_confirmation')
    expect(result.reply).toContain('连接中断')
  })
})

function baseSession(): WorkflowSession {
  const now = '2026-07-22T00:00:00.000Z'
  return {
    sessionId: 'session-1', inputType: 'text', phase: 'modifying', availability: 'usable',
    brief: {
      existingCondition: [], designGoals: [], hardConstraints: [], assumptions: [],
      uncertainties: [], conflicts: [],
    },
    questions: [], reasons: [], summary: '', messages: [], clarificationRounds: 0,
    language: 'zh', pendingModification: '移动门', createdAt: now, updatedAt: now,
  }
}
