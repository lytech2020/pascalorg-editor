import { describe, expect, test } from 'bun:test'
import type { WorkflowSession } from '../types'
import {
  buildCompletionReply,
  countAllIssues,
  countDiagnosticIssues,
  finishSceneWorkflow,
  type DiagnosticsSummary,
} from './generate-service'

describe('generate application service', () => {
  test('keeps the success path free of issue messaging', () => {
    const diagnostics = emptyDiagnostics()
    expect(countDiagnosticIssues(diagnostics)).toBe(0)
    expect(countAllIssues(diagnostics, [])).toBe(0)
    expect(buildCompletionReply({
      lang: 'zh',
      successText: '生成完成',
      repairRounds: 0,
      diagnostics,
      toolNamesUsed: new Set(),
      furnitureIssues: [],
      gateFailures: [],
    })).toBe('生成完成')
  })

  test('reports structural and gate failures without declaring success', () => {
    const diagnostics = emptyDiagnostics()
    diagnostics.validation.errors.push('卧室面积不足')
    const reply = buildCompletionReply({
      lang: 'zh',
      successText: '生成完成',
      repairRounds: 2,
      diagnostics,
      toolNamesUsed: new Set(),
      furnitureIssues: [],
      gateFailures: [{ gate: 1, id: 'missing-room', message: '缺少卫生间' }],
    })
    expect(countDiagnosticIssues(diagnostics)).toBe(1)
    expect(reply).toContain('卧室面积不足')
    expect(reply).toContain('缺少卫生间')
    expect(reply).not.toBe('生成完成')
  })

  test('owns the final scene result, phase and reply transition', () => {
    const diagnostics = emptyDiagnostics()
    const session = baseSession()
    session.toolTrace = [{
      phase: 'plan', modelCalls: 2, toolCalls: [], toolCounts: {}, converged: true,
      continuationAttempts: 0,
    }]
    const result = finishSceneWorkflow({
      session,
      sceneId: 'scene-1',
      editorUrl: '/scene-1',
      version: 3,
      diagnostics,
      repairRounds: 0,
      toolNamesUsed: new Set(),
      furnitureIssues: [],
      gateFailures: [],
      gatesPassed: true,
      successText: '生成完成',
    })
    expect(result.sceneResult).toMatchObject({ sceneId: 'scene-1', version: 3, modelCallsUsed: 2 })
    expect(session.phase).toBe('completed')
    expect(result.reply).toBe('生成完成')
  })
})

function emptyDiagnostics(): DiagnosticsSummary {
  return {
    validation: { valid: true, errors: [] },
    verificationIssues: [],
    collisions: [],
    doorlessRooms: [],
    strayWindows: [],
    requirementMismatches: [],
    isolatedBedrooms: [],
  }
}

function baseSession(): WorkflowSession {
  const now = '2026-07-22T00:00:00.000Z'
  return {
    sessionId: 'session-1', inputType: 'text', phase: 'generating', availability: 'usable',
    brief: {
      existingCondition: [], designGoals: [], hardConstraints: [], assumptions: [],
      uncertainties: [], conflicts: [],
    },
    questions: [], reasons: [], summary: '', messages: [], clarificationRounds: 0,
    language: 'zh', createdAt: now, updatedAt: now,
  }
}
