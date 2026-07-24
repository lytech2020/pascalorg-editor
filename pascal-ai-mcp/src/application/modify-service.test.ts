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
        // A rename patch is a real, confirmed write; a later verification
        // failure must route to the destructive-write reply.
        current.modificationWriteEffect = 'write_confirmed'
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
      expect(result.session.phase).toBe('completed_with_issues')
      expect(result.reply).toContain('room_not_renamed')
      expect(result.reply).toContain('禁止自动重试')
      expect(result.session.pendingModification).toBeUndefined()
      expect(result.session.pendingModifyPlan).toBeUndefined()
      expect(result.session.modificationWriteEffect).toBeUndefined()
      expect(clearCalls).toBe(1)
    } finally {
      if (previousLegacyFlag === undefined) delete process.env.PASCAL_MODIFY_LEGACY
      else process.env.PASCAL_MODIFY_LEGACY = previousLegacyFlag
    }
  })

  // §7 write-effect isolation: a leftover uncertain write from a PREVIOUS
  // attempt must NOT run a fresh edit as if the scene were clean, and must NOT
  // be misattributed to this attempt. Surface it and ask the user to check.
  test('surfaces a leftover uncertain write instead of polluting the new attempt', async () => {
    const previousLegacyFlag = process.env.PASCAL_MODIFY_LEGACY
    delete process.env.PASCAL_MODIFY_LEGACY
    let planFirstCalls = 0
    const session = {
      ...baseSession(),
      language: 'en' as const,
      sceneId: 'scene-9',
      pendingOperation: 'update' as const,
      // Leftover from a prior modification that never resolved its write.
      modificationWriteEffect: 'write_attempted' as const,
    }
    const dependencies: ModifyWorkflowDependencies = {
      persistSession: () => {},
      loadScene: async () => ({ version: 1 }),
      runPlanFirst: async current => {
        planFirstCalls++
        return { session: current, reply: '', next: 'finish' as const }
      },
      snapshotScene: async () => ({}),
      runLegacyPhase: async () => ({ messages: [], toolNamesUsed: new Set(), furnitureIssues: [] }),
      dedupeSharedWalls: async () => {},
      checkProtection: async () => [],
      refine: async () => { throw new Error('refine must not run') },
      persistScene: async () => null,
      evaluateGates: async () => ({ report: { passed: true, failures: [] }, layoutQuality: 1 }),
      clearDestructiveWrite: () => false,
      isCancellationError: () => false,
      errorMessage: error => error instanceof Error ? error.message : String(error),
      planSnapshot: () => '',
    }
    try {
      const result = await runModifyWorkflow({
        input: { sessionId: session.sessionId }, session, reply: '', next: 'modify',
      }, dependencies)
      if (!result.session) throw new Error('expected a session result')
      // The new edit never ran, and the persistent guard remains until the
      // user explicitly acknowledges the inspected scene.
      expect(planFirstCalls).toBe(0)
      expect(result.session.phase).toBe('completed_with_issues')
      expect(result.session.modificationWriteEffect).toBe('write_attempted')
      expect(result.session.destructiveSceneWriteStarted).toBeUndefined()
      expect(result.reply).toContain('unconfirmed')
      expect(result.reply).toContain('confirm')
    } finally {
      if (previousLegacyFlag === undefined) delete process.env.PASCAL_MODIFY_LEGACY
      else process.env.PASCAL_MODIFY_LEGACY = previousLegacyFlag
    }
  })

  test('explicit confirmation clears an uncertain-write guard and invalidates structural snapshots', async () => {
    const previousLegacyFlag = process.env.PASCAL_MODIFY_LEGACY
    delete process.env.PASCAL_MODIFY_LEGACY
    let planFirstCalls = 0
    const session = {
      ...baseSession(),
      language: 'en' as const,
      sceneId: 'scene-9',
      pendingOperation: 'update' as const,
      modificationWriteEffect: 'write_attempted' as const,
    }
    const dependencies: ModifyWorkflowDependencies = {
      persistSession: () => {},
      loadScene: async () => ({ version: 1 }),
      runPlanFirst: async current => {
        planFirstCalls++
        return { session: current, reply: '', next: 'finish' as const }
      },
      snapshotScene: async () => ({}),
      runLegacyPhase: async () => ({ messages: [], toolNamesUsed: new Set(), furnitureIssues: [] }),
      dedupeSharedWalls: async () => {},
      checkProtection: async () => [],
      refine: async () => { throw new Error('refine must not run') },
      persistScene: async () => null,
      evaluateGates: async () => ({ report: { passed: true, failures: [] }, layoutQuality: 1 }),
      clearDestructiveWrite: () => false,
      isCancellationError: () => false,
      errorMessage: error => error instanceof Error ? error.message : String(error),
      planSnapshot: () => '',
    }
    try {
      const result = await runModifyWorkflow({
        input: { sessionId: session.sessionId, message: 'confirm' },
        session,
        reply: '',
        next: 'modify',
      }, dependencies)
      if (!result.session) throw new Error('expected a session result')
      expect(planFirstCalls).toBe(0)
      expect(result.session.modificationWriteEffect).toBeUndefined()
      expect(result.session.layoutIntent).toBeUndefined()
      expect(result.session.layoutPlan).toBeUndefined()
      expect(result.session.strategy).toBeUndefined()
      expect(result.session.phase).toBe('completed_with_issues')
      expect(result.reply).toContain('acknowledged')
      expect(result.reply).toContain('invalidated')
    } finally {
      if (previousLegacyFlag === undefined) delete process.env.PASCAL_MODIFY_LEGACY
      else process.env.PASCAL_MODIFY_LEGACY = previousLegacyFlag
    }
  })

  // A clean session (no leftover) proceeds into the plan-first attempt normally.
  test('does not trip the isolation guard when there is no leftover write', async () => {
    const previousLegacyFlag = process.env.PASCAL_MODIFY_LEGACY
    delete process.env.PASCAL_MODIFY_LEGACY
    let planFirstCalls = 0
    const session = { ...baseSession(), sceneId: 'scene-1', pendingOperation: 'update' as const }
    const dependencies: ModifyWorkflowDependencies = {
      persistSession: () => {},
      loadScene: async () => ({ version: 1 }),
      runPlanFirst: async current => {
        planFirstCalls++
        return { session: current, reply: 'ok', next: 'finish' as const }
      },
      snapshotScene: async () => ({}),
      runLegacyPhase: async () => ({ messages: [], toolNamesUsed: new Set(), furnitureIssues: [] }),
      dedupeSharedWalls: async () => {},
      checkProtection: async () => [],
      refine: async () => { throw new Error('refine must not run') },
      persistScene: async () => null,
      evaluateGates: async () => ({ report: { passed: true, failures: [] }, layoutQuality: 1 }),
      clearDestructiveWrite: () => false,
      isCancellationError: () => false,
      errorMessage: error => String(error),
      planSnapshot: () => '',
    }
    try {
      await runModifyWorkflow({
        input: { sessionId: session.sessionId }, session, reply: '', next: 'modify',
      }, dependencies)
      expect(planFirstCalls).toBe(1)
    } finally {
      if (previousLegacyFlag === undefined) delete process.env.PASCAL_MODIFY_LEGACY
      else process.env.PASCAL_MODIFY_LEGACY = previousLegacyFlag
    }
  })

  // P1-A: a write whose result is UNKNOWN (transport failure) must route to the
  // result-unknown reply — never a normal completion, never auto-retry, never
  // save_scene. The catch handler reads the persisted write-effect state.
  test('routes an unknown-result write to result-unknown (no save, no retry)', async () => {
    const previousLegacyFlag = process.env.PASCAL_MODIFY_LEGACY
    delete process.env.PASCAL_MODIFY_LEGACY
    let persistSceneCalls = 0
    const session = {
      ...baseSession(),
      sceneId: 'scene-1',
      pendingOperation: 'update' as const,
      pendingModifyPlan: { ops: [{ op: 'remove_furniture' as const, room: '主卧', item: '床' }] },
    }
    const dependencies: ModifyWorkflowDependencies = {
      persistSession: () => {},
      loadScene: async () => ({ version: 4 }),
      runPlanFirst: async current => {
        // A delete_node whose response was lost — result unknown.
        current.modificationWriteEffect = 'write_attempted'
        throw new Error('delete_node 写入结果未知')
      },
      snapshotScene: async () => ({}),
      runLegacyPhase: async () => ({ messages: [], toolNamesUsed: new Set(), furnitureIssues: [] }),
      dedupeSharedWalls: async () => {},
      checkProtection: async () => [],
      refine: async () => { throw new Error('refine must not run') },
      persistScene: async () => { persistSceneCalls++; return 5 },
      evaluateGates: async () => ({ report: { passed: true, failures: [] }, layoutQuality: 1 }),
      clearDestructiveWrite: () => false,
      isCancellationError: () => false,
      errorMessage: error => error instanceof Error ? error.message : String(error),
      planSnapshot: () => '',
    }
    try {
      const result = await runModifyWorkflow(
        { input: { sessionId: session.sessionId }, session, reply: '', next: 'modify' },
        dependencies,
      )
      if (!result.session) throw new Error('expected a session result')
      // Result-unknown wording, not the clean-completion or destructive text.
      expect(result.reply).toContain('无法确认')
      expect(result.reply).toContain('不会自动重试')
      // No scene was saved on an uncertain write.
      expect(persistSceneCalls).toBe(0)
      expect(result.session.modificationWriteEffect).toBe('write_attempted')
      expect(result.session.pendingModifyPlan).toBeUndefined()
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
