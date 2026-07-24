import { describe, expect, test } from 'bun:test'
import type { WorkflowSession } from '../types'
import {
  effectiveGateFailures,
  finishModificationFailure,
  modifyFailureRecovery,
  runModifyWorkflow,
  type ModifyWorkflowDependencies,
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
    expect(result.reply).toContain('部分操作可能已经提交')
    expect(result.reply).not.toContain('原场景')
  })

  test('uses the classified plan-first result without entering free editing', async () => {
    const previousLegacyFlag = process.env.PASCAL_MODIFY_LEGACY
    delete process.env.PASCAL_MODIFY_LEGACY
    let legacyCalls = 0
    const dependencies: ModifyWorkflowDependencies = {
      persistSession: () => {},
      loadScene: async () => ({ version: 4 }),
      runPlanFirst: async session => ({
        session: { ...session, phase: 'completed' },
        reply: '安全拒绝：场景未修改',
        next: 'finish',
      }),
      snapshotScene: async () => {
        throw new Error('snapshotScene must not run after plan-first classification')
      },
      runLegacyPhase: async () => {
        legacyCalls++
        return { messages: [], toolNamesUsed: new Set(), furnitureIssues: [] }
      },
      dedupeSharedWalls: async () => {},
      checkProtection: async () => [],
      refine: async () => {
        throw new Error('refine must not run after plan-first classification')
      },
      persistScene: async () => null,
      evaluateGates: async () => ({
        report: { passed: true, failures: [] },
        layoutQuality: 1,
      }),
      clearDestructiveWrite: () => false,
      isCancellationError: () => false,
      errorMessage: error => String(error),
      planSnapshot: () => '',
    }
    const session = {
      ...baseSession(),
      sceneId: 'scene-1',
      pendingOperation: 'update' as const,
    }
    try {
      const result = await runModifyWorkflow({
        input: { sessionId: session.sessionId },
        session,
        reply: '',
        next: 'modify',
      }, dependencies)
      expect(result.reply).toBe('安全拒绝：场景未修改')
      expect(legacyCalls).toBe(0)
    } finally {
      if (previousLegacyFlag === undefined) delete process.env.PASCAL_MODIFY_LEGACY
      else process.env.PASCAL_MODIFY_LEGACY = previousLegacyFlag
    }
  })

  test('treats a verifier failure after a local write as failed-recoverable without retrying', async () => {
    const previousLegacyFlag = process.env.PASCAL_MODIFY_LEGACY
    delete process.env.PASCAL_MODIFY_LEGACY
    let clearCalls = 0
    const session = {
      ...baseSession(),
      sceneId: 'scene-1',
      pendingOperation: 'update' as const,
      pendingModifyPlan: {
        ops: [{ op: 'rename_room' as const, room: '卧室', name: '书房' }],
      },
    }
    const dependencies: ModifyWorkflowDependencies = {
      persistSession: () => {},
      loadScene: async () => ({ version: 4 }),
      runPlanFirst: async current => {
        current.modificationWriteStarted = true
        throw new Error('room_not_renamed')
      },
      snapshotScene: async () => ({}),
      runLegacyPhase: async () => ({ messages: [], toolNamesUsed: new Set(), furnitureIssues: [] }),
      dedupeSharedWalls: async () => {},
      checkProtection: async () => [],
      refine: async () => {
        throw new Error('refine must not run')
      },
      persistScene: async () => null,
      evaluateGates: async () => ({
        report: { passed: true, failures: [] },
        layoutQuality: 1,
      }),
      clearDestructiveWrite: () => {
        clearCalls++
        return false
      },
      isCancellationError: () => false,
      errorMessage: error => error instanceof Error ? error.message : String(error),
      planSnapshot: () => '',
    }
    try {
      const result = await runModifyWorkflow({
        input: { sessionId: session.sessionId },
        session,
        reply: '',
        next: 'modify',
      }, dependencies)
      if (!result.session) throw new Error('expected a session result')
      expect(result.session.phase).toBe('failed')
      expect(result.reply).toContain('room_not_renamed')
      expect(result.reply).toContain('禁止自动重试')
      expect(result.session.pendingModification).toBeUndefined()
      expect(result.session.pendingModifyPlan).toBeUndefined()
      expect(result.session.modificationWriteStarted).toBeUndefined()
      expect(clearCalls).toBe(1)
    } finally {
      if (previousLegacyFlag === undefined) delete process.env.PASCAL_MODIFY_LEGACY
      else process.env.PASCAL_MODIFY_LEGACY = previousLegacyFlag
    }
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
