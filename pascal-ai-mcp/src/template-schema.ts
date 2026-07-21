import { z } from 'zod'
import { ROOM_TYPES, type LayoutPlan } from './layout-plan'
import type { JapaneseRoomProgram } from './lang/strategy-vocab'

export const TEMPLATE_SCHEMA_VERSION = 1 as const

export const TEMPLATE_MARKETS = ['default', 'jp'] as const
export const TEMPLATE_QUALITIES = ['good', 'bad'] as const
export const TEMPLATE_TYPOLOGIES = [
  'studio',
  'standard_band',
  'narrow_lot',
  'tanoji',
  'l_shape',
] as const
export const TEMPLATE_ROOM_PROGRAMS = [
  '1r',
  '1k',
  '1dk',
  '1ldk',
  '2dk',
  '2ldk',
  '3dk',
  '3ldk',
  '4dk',
  '4ldk',
  '5dk',
  '5ldk',
  '6dk',
  '6ldk',
  '7dk',
  '7ldk',
  '8dk',
  '8ldk',
  '9dk',
  '9ldk',
] as const satisfies readonly JapaneseRoomProgram[]

const nonEmptyString = z.string().trim().min(1)
const identifier = z.string().min(1).refine(value => value === value.trim(), {
  message: 'must not have leading or trailing whitespace',
})
const coordinate = z.number().finite()
const point = z.tuple([coordinate, coordinate])
const polygon = z.array(point).min(3)

const LayoutPlanSchema: z.ZodType<LayoutPlan> = z.strictObject({
  footprint: z.strictObject({
    width: z.number().finite().positive(),
    depth: z.number().finite().positive(),
    polygon: polygon.optional(),
  }),
  entry: z.strictObject({ roomId: identifier }),
  rooms: z.array(z.strictObject({
    id: identifier,
    name: nonEmptyString,
    type: z.enum(ROOM_TYPES),
    polygon,
    requiresExteriorWindow: z.boolean(),
  })).min(1),
  connections: z.array(z.strictObject({
    from: identifier,
    to: identifier,
    type: z.literal('door'),
  })),
  notes: z.array(z.string()).optional(),
})

export const TemplateRecordSchema = z.strictObject({
  schemaVersion: z.literal(TEMPLATE_SCHEMA_VERSION),
  id: identifier,
  meta: z.strictObject({
    market: z.enum(TEMPLATE_MARKETS),
    label: nonEmptyString,
    source: nonEmptyString,
    quality: z.enum(TEMPLATE_QUALITIES),
    badReasons: z.array(nonEmptyString),
    typology: z.enum(TEMPLATE_TYPOLOGIES).optional(),
    roomProgram: z.enum(TEMPLATE_ROOM_PROGRAMS).optional(),
    notes: z.string().optional(),
  }),
  plan: LayoutPlanSchema,
}).superRefine((template, context) => {
  const roomIds = new Set<string>()
  for (let index = 0; index < template.plan.rooms.length; index++) {
    const roomId = template.plan.rooms[index]!.id
    if (roomIds.has(roomId)) {
      context.addIssue({
        code: 'custom',
        path: ['plan', 'rooms', index, 'id'],
        message: `duplicate room id: ${roomId}`,
      })
    }
    roomIds.add(roomId)
  }
  if (!roomIds.has(template.plan.entry.roomId)) {
    context.addIssue({
      code: 'custom',
      path: ['plan', 'entry', 'roomId'],
      message: `unknown room id: ${template.plan.entry.roomId}`,
    })
  }
  for (let index = 0; index < template.plan.connections.length; index++) {
    const connection = template.plan.connections[index]!
    for (const endpoint of ['from', 'to'] as const) {
      if (!roomIds.has(connection[endpoint])) {
        context.addIssue({
          code: 'custom',
          path: ['plan', 'connections', index, endpoint],
          message: `unknown room id: ${connection[endpoint]}`,
        })
      }
    }
  }
  const connectionPairs = new Set<string>()
  for (let index = 0; index < template.plan.connections.length; index++) {
    const connection = template.plan.connections[index]!
    if (connection.from === connection.to) {
      context.addIssue({
        code: 'custom',
        path: ['plan', 'connections', index],
        message: `self-loop connection: ${connection.from}`,
      })
      continue
    }
    const pair = [connection.from, connection.to].sort().join('\u0000')
    if (connectionPairs.has(pair)) {
      context.addIssue({
        code: 'custom',
        path: ['plan', 'connections', index],
        message: `duplicate connection: ${connection.from} <-> ${connection.to}`,
      })
    }
    connectionPairs.add(pair)
  }
})

export type TemplateRecord = z.infer<typeof TemplateRecordSchema>
export type TemplateMarket = TemplateRecord['meta']['market']
export type TemplateQuality = TemplateRecord['meta']['quality']

export function migrateTemplateRecord(raw: unknown): unknown {
  if (!isRecord(raw)) return raw
  if (raw.schemaVersion === undefined) {
    return { ...raw, schemaVersion: TEMPLATE_SCHEMA_VERSION }
  }
  if (raw.schemaVersion === TEMPLATE_SCHEMA_VERSION) return raw
  throw new Error(`schemaVersion: unsupported template schema version ${JSON.stringify(raw.schemaVersion)}`)
}

export function parseTemplateRecord(raw: unknown): TemplateRecord {
  return TemplateRecordSchema.parse(migrateTemplateRecord(raw))
}

export function formatTemplateSchemaError(error: unknown): string {
  if (!(error instanceof z.ZodError)) return error instanceof Error ? error.message : String(error)
  return error.issues
    .map(issue => `${formatPath(issue.path)}: ${issue.message}`)
    .join('; ')
}

function formatPath(path: PropertyKey[]): string {
  if (path.length === 0) return '<root>'
  return path.reduce<string>((result, part) => {
    if (typeof part === 'number') return `${result}[${part}]`
    return result ? `${result}.${String(part)}` : String(part)
  }, '')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
