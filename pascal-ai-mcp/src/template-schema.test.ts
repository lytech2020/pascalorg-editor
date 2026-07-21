import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  formatTemplateSchemaError,
  migrateTemplateRecord,
  parseTemplateRecord,
  TEMPLATE_SCHEMA_VERSION,
  TemplateRecordSchema,
} from './template-schema'

const samplePath = join(import.meta.dir, '..', 'templates', 'good', 'tpl-jp-2dk-44.json')

function sample(): Record<string, unknown> {
  return JSON.parse(readFileSync(samplePath, 'utf8')) as Record<string, unknown>
}

describe('TemplateRecordSchema', () => {
  test('parses a current template with explicit schemaVersion', () => {
    const parsed = TemplateRecordSchema.parse(sample())
    expect(parsed.schemaVersion).toBe(TEMPLATE_SCHEMA_VERSION)
    expect(parsed.id).toBe('tpl-jp-2dk-44')
  })

  test('reports the exact path of a malformed nested field', () => {
    const raw = sample()
    const plan = raw.plan as { rooms: Array<Record<string, unknown>> }
    plan.rooms[2]!.type = 'dining_room'

    const result = TemplateRecordSchema.safeParse(raw)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(formatTemplateSchemaError(result.error)).toContain('plan.rooms[2].type')
    }
  })

  test('legacy migration is explicit while the current schema requires a version', () => {
    const raw = sample()
    delete raw.schemaVersion
    expect(TemplateRecordSchema.safeParse(raw).success).toBe(false)
    expect(parseTemplateRecord(raw).schemaVersion).toBe(TEMPLATE_SCHEMA_VERSION)
  })

  test('rejects unsupported future versions instead of guessing', () => {
    const raw = sample()
    raw.schemaVersion = 2
    expect(() => migrateTemplateRecord(raw)).toThrow('schemaVersion')
  })

  test('rejects self-loop and duplicate undirected connections at exact indexes', () => {
    const raw = sample()
    const plan = raw.plan as { connections: Array<{ from: string; to: string; type: string }> }
    const original = plan.connections[0]!
    plan.connections.push(
      { from: original.from, to: original.from, type: 'door' },
      { from: original.to, to: original.from, type: 'door' },
    )

    const result = TemplateRecordSchema.safeParse(raw)
    expect(result.success).toBe(false)
    if (!result.success) {
      const message = formatTemplateSchemaError(result.error)
      expect(message).toContain(`plan.connections[${plan.connections.length - 2}]: self-loop connection`)
      expect(message).toContain(`plan.connections[${plan.connections.length - 1}]: duplicate connection`)
    }
  })

  test('rejects surrounding whitespace in identifiers instead of normalizing it', () => {
    const raw = sample()
    const plan = raw.plan as { entry: { roomId: string } }
    plan.entry.roomId = `${plan.entry.roomId} `
    const result = TemplateRecordSchema.safeParse(raw)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(formatTemplateSchemaError(result.error)).toContain('plan.entry.roomId')
    }
  })
})
