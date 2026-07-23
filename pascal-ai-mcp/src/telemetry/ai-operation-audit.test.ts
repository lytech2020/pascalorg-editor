import { describe, expect, test } from 'bun:test'
import { AiAuditRepository, type AiAuditWriter } from '../persistence/audit-repository'
import { AppDatabase } from '../persistence/database'
import { ChatRequestRepository } from '../persistence/session-repository'
import { WorkflowStepRepository } from '../persistence/workflow-step-repository'
import { AiOperationAuditor, summarizeToolArgs } from './ai-operation-audit'

function auditFixture() {
  const database = new AppDatabase(':memory:')
  const requests = new ChatRequestRepository(database)
  const workflowRunId = requests.start({
    requestId: 'request-1',
    traceId: 'trace-12345678',
    sessionId: 'session-1',
    kind: 'chat',
    sceneId: 'scene-1',
    startedAt: '2026-07-22T00:00:00.000Z',
  })
  const step = new WorkflowStepRepository(database).start({
    requestId: 'request-1',
    sessionId: 'session-1',
    sceneId: 'scene-1',
    operationKey: 'structure-openings',
    startedAt: '2026-07-22T00:00:00.000Z',
  })
  const repository = new AiAuditRepository(database)
  return {
    database,
    repository,
    auditor: new AiOperationAuditor(repository),
    identity: {
      requestId: 'request-1',
      workflowRunId,
      workflowStepId: step.stepId,
      sessionId: 'session-1',
      sceneId: 'scene-1',
      operationKey: 'structure-openings',
    },
  }
}

describe('AI operation audit', () => {
  test('stores normalized template decisions so hit and rejection rates are queryable with SQL', () => {
    const fixture = auditFixture()
    try {
      fixture.repository.recordTemplateMatch({
        decisionId: 'decision-1',
        requestId: 'request-1',
        workflowRunId: fixture.identity.workflowRunId,
        sessionId: 'session-1',
        mode: 'direct',
        market: 'jp',
        roomProgram: '2ldk',
        targetAreaSqm: 55,
        selectedTemplateId: 'tpl-jp-2ldk-54',
        candidates: [
          { templateId: 'tpl-jp-2ldk-54', areaRatio: 1.02, relaxedTypology: false },
        ],
        rejections: [
          { templateId: 'tpl-jp-2ldk-58', reasonCodes: ['hub_form_mismatch'] },
        ],
        createdAt: '2026-07-22T00:00:01.000Z',
      })
      expect(fixture.repository.findTemplateDecisionsByRequest('request-1')[0]).toMatchObject({
        mode: 'direct',
        room_program: '2ldk',
        area_band: '50_69',
        selected_template_id: 'tpl-jp-2ldk-54',
      })
      expect(fixture.database.connection.query(`
        SELECT selected_template_id, COUNT(*) AS hits
        FROM ai_template_decisions
        WHERE selected_template_id IS NOT NULL
        GROUP BY selected_template_id
      `).all()).toEqual([{ selected_template_id: 'tpl-jp-2ldk-54', hits: 1 }])
      expect(fixture.database.connection.query(`
        SELECT reason_code, COUNT(*) AS rejections
        FROM ai_template_rejections
        GROUP BY reason_code
      `).all()).toEqual([{ reason_code: 'hub_form_mismatch', rejections: 1 }])
    } finally {
      fixture.database.close()
    }
  })

  test('reconstructs read, write, failure, cancellation, version, and validation summaries', async () => {
    const fixture = auditFixture()
    const privateValue = 'private prompt and api-key-value'
    try {
      await fixture.auditor.callTool(
        fixture.identity,
        'get_project_status',
        { id: 'scene-1', authorization: privateValue },
        async () => ({ structuredContent: { version: 4, graphHash: privateValue } }),
      )
      await fixture.auditor.callTool(
        fixture.identity,
        'apply_patch',
        {
          patches: [
            { op: 'update', id: 'wall-1', data: { name: privateValue } },
            { op: 'update', id: 'wall-2', data: { name: privateValue } },
          ],
        },
        async () => ({ content: [{ type: 'text', text: JSON.stringify({ version: 5 }) }] }),
      )
      await expect(fixture.auditor.callTool(
        fixture.identity,
        'add_window',
        { wallId: privateValue },
        async () => { throw new Error(`provider leaked ${privateValue}`) },
      )).rejects.toThrow('provider leaked')
      await expect(fixture.auditor.callTool(
        fixture.identity,
        'delete_node',
        { id: privateValue },
        async () => { throw new DOMException('aborted by user', 'AbortError') },
      )).rejects.toThrow()

      fixture.auditor.recordValidation(
        fixture.identity,
        'scene-diagnostics',
        'failed',
        2,
        { validationErrors: 1, collisions: 1 },
        1,
      )
      fixture.auditor.recordValidation(
        fixture.identity,
        'future-validator',
        'failed',
        1,
        {
          safeKinds: ['missing-room', privateValue],
          unsafeMessage: privateValue,
          nestedPayload: { secret: privateValue },
        },
      )

      const tools = fixture.repository.findToolCallsByRequest('request-1')
      expect(tools.map(row => row.status)).toEqual([
        'succeeded',
        'succeeded',
        'failed',
        'cancelled',
      ])
      expect(tools.map(row => row.error_code)).toEqual([null, null, 'mcp_error', 'cancelled'])
      expect(tools.every(row => row.workflow_step_id === fixture.identity.workflowStepId)).toBe(true)
      expect(JSON.parse(String(tools[0]?.args_summary_json))).toEqual({
        keys: ['authorization', 'id'],
      })

      const changes = fixture.repository.findSceneChangesByRequest('request-1')
      expect(changes).toHaveLength(1)
      expect(changes[0]).toMatchObject({
        change_type: 'apply_patch',
        before_version: 4,
        after_version: 5,
        node_count: 2,
      })
      const validations = fixture.repository.findValidationsByRequest('request-1')
      expect(validations).toHaveLength(2)
      expect(validations[0]).toMatchObject({
        validator: 'scene-diagnostics',
        validated_version: 5,
        repair_round: 1,
        issue_count: 2,
      })
      expect(JSON.parse(String(validations[1]?.summary_json))).toEqual({
        safeKinds: ['missing-room'],
        droppedValueCount: 3,
      })
      expect(JSON.stringify({ tools, changes, validations })).not.toContain(privateValue)
    } finally {
      fixture.database.close()
    }
  })

  test('stores only parameter shape, never values or nested payloads', () => {
    const summary = summarizeToolArgs({
      prompt: 'do not retain me',
      imageDataUrl: 'data:image/png;base64,secret',
      patches: [{ data: { secret: 'value' } }],
      options: { authorization: 'Bearer secret', nested: { private: true } },
      'user said do not retain this sentence': true,
    })
    expect(summary).toEqual({
      keys: ['imageDataUrl', 'options', 'patches', 'prompt'],
      arrayLengths: { patches: 1 },
      objectKeyCounts: { options: 2 },
      invalidKeyCount: 1,
    })
    expect(JSON.stringify(summary)).not.toContain('do not retain me')
    expect(JSON.stringify(summary)).not.toContain('base64,secret')
    expect(JSON.stringify(summary)).not.toContain('Bearer secret')
    expect(JSON.stringify(summary)).not.toContain('user said do not retain')
  })

  test('fails closed before a tool call when the start record cannot be persisted', async () => {
    let invoked = false
    const writer = throwingWriter('start')
    const auditor = new AiOperationAuditor(writer)
    await expect(auditor.callTool({
      requestId: 'request-1',
      sessionId: 'session-1',
      operationKey: 'request',
    }, 'get_scene', {}, async () => {
      invoked = true
      return {}
    })).rejects.toThrow('start failed')
    expect(invoked).toBe(false)
  })

  test('fails open after the tool has completed when terminal audit persistence fails', async () => {
    const writer = throwingWriter('finish')
    const auditor = new AiOperationAuditor(writer)
    expect(await auditor.callTool({
      requestId: 'request-1',
      sessionId: 'session-1',
      operationKey: 'request',
    }, 'get_scene', {}, async () => ({ structuredContent: { ok: true } }))).toEqual({
      structuredContent: { ok: true },
    })
  })
})

function throwingWriter(point: 'start' | 'finish'): AiAuditWriter {
  return {
    startToolCall() {
      if (point === 'start') throw new Error('start failed')
    },
    finishToolCall() {
      if (point === 'finish') throw new Error('finish failed')
      return true
    },
    recordSceneChange() {},
    recordValidation() {},
    recordGuardrail() {},
    recordTemplateMatch() {},
  }
}
