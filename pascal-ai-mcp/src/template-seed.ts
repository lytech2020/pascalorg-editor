// ---------------------------------------------------------------------------
// Template seeding: bias generation toward the reference library.
//
// Before the partitioner runs, the intent is matched against templates/
// (docs/TEMPLATES.md). A "good" reference with the same core program —
// bedroom count, hub form (LDK vs DK vs separate living), standalone-kitchen
// presence — and a lot area within scaling range is adapted by uniform
// scaling and used AS the plan. Real listed floor plans carry the 水回りコア
// / 中央動線 idioms the partitioner hasn't learned yet, so a hit skips the
// solver entirely; any mismatch or post-scale validation fatal falls back to
// partitionLayout. Deterministic, zero model calls.
//
// Deliberate v1 limits:
// - per-room targetAreaSqm in the intent is ignored on a hit (template
//   proportions win; a note says so);
// - strategies with a footprintHint (explicit lot dims) never seed — uniform
//   scaling cannot honor exact lot dimensions;
// - site-constrained typologies (narrow_lot / l_shape) only seed from
//   templates of the same typology, and such templates never seed
//   unconstrained requests.
// ---------------------------------------------------------------------------

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isDiningKitchenName } from './lang/room-vocab'
import { isServiceRoomName } from './lang/strategy-vocab'
import {
  footprintArea,
  polygonArea,
  roundCm,
  type LayoutIntent,
  type LayoutPlan,
  type LayoutPlanRoom,
  type RoomType,
} from './layout-plan'
import type { NormProfile } from './norms/profile'
import type { PartitionStrategyHint } from './layout-partitioner'
import { validateLayoutPlan, type PlanTargets } from './plan-validator'
import {
  formatTemplateSchemaError,
  parseTemplateRecord,
  type TemplateQuality,
  type TemplateRecord,
} from './template-schema'

export type { TemplateRecord } from './template-schema'

export type TemplateSeedResult = {
  plan: LayoutPlan
  templateId: string
  notes: string[]
  validation: ReturnType<typeof validateLayoutPlan>
}

export type TemplateMatchMode = 'direct' | 'after_enrichment' | 'fallback'

export type TemplateMatchTrace = {
  mode: TemplateMatchMode
  market: string
  roomProgram?: string
  targetAreaSqm?: number
  selectedTemplateId?: string
  candidates: Array<{
    templateId: string
    areaRatio: number
    relaxedTypology: boolean
  }>
  rejections: Array<{
    templateId: string
    reasonCodes: string[]
  }>
}

const DEFAULT_TEMPLATES_DIR = join(import.meta.dir, '..', 'templates')

// Area ratio the uniform scaling may bridge (linear scale ≈ ±10%).
const MIN_AREA_RATIO = 0.8
const MAX_AREA_RATIO = 1.25

// Room types the template is allowed to be RICHER in than the intent: real
// references carry 卫浴分离 / 収納 / 玄関 / 廊下 the intent never spells out.
const SERVICE_TYPES: ReadonlySet<RoomType> = new Set([
  'bathroom', 'storage', 'entry', 'hallway', 'balcony',
])
const SITE_CONSTRAINED_TYPOLOGIES = new Set(['narrow_lot', 'l_shape'])

export type TemplateLibraryHealth = {
  ready: boolean
  files: number
  loaded: number
  good: number
  bad: number
  failed: number
  failures: string[]
  blockingFailures: string[]
}

export type TemplateLibrary = {
  records: TemplateRecord[]
  failures: string[]
  health: TemplateLibraryHealth
}

const templateCache = new Map<string, TemplateLibrary>()

// Dev/tests: drop the cached library so edited/added template files are
// re-read without a process restart.
export function invalidateTemplateCache(dir?: string): void {
  if (dir) templateCache.delete(dir)
  else templateCache.clear()
}

// Templates live in quality subfolders (templates/good/, templates/bad/) so
// the library reads at a glance; loose .json at the root keeps working.
export function templateFilePaths(dir: string): string[] {
  const paths: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.json')) paths.push(join(dir, entry.name))
    else if (entry.isDirectory()) {
      for (const file of readdirSync(join(dir, entry.name))) {
        if (file.endsWith('.json')) paths.push(join(dir, entry.name, file))
      }
    }
  }
  return paths.sort()
}

// Per-file fault isolation keeps development usable while still making the
// whole-library state explicit. Production gates traffic on blockingFailures;
// CI parses the same schema without legacy migration.
export function loadTemplateLibrary(dir: string = DEFAULT_TEMPLATES_DIR): TemplateLibrary {
  const cached = templateCache.get(dir)
  if (cached) return cached
  const records: TemplateRecord[] = []
  const failures: string[] = []
  const blockingFailures: string[] = []
  let paths: string[] = []
  try {
    paths = templateFilePaths(dir)
  } catch (error) {
    const message = `templates dir unreadable: ${dir} (${error instanceof Error ? error.message : String(error)})`
    failures.push(message)
    blockingFailures.push(message)
  }
  if (paths.length === 0 && failures.length === 0) {
    const message = `templates dir contains no template files: ${dir}`
    failures.push(message)
    blockingFailures.push(message)
  }
  for (const path of paths) {
    let quality: TemplateQuality | undefined
    try {
      const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
      quality = qualityHint(raw)
      records.push(parseTemplateRecord(raw))
    } catch (error) {
      const message = `${path}: ${formatTemplateSchemaError(error)}`
      failures.push(message)
      if (quality !== 'bad') blockingFailures.push(message)
    }
  }
  if (records.every(record => record.meta.quality !== 'good')) {
    const message = `templates dir contains no valid good templates: ${dir}`
    if (!failures.includes(message)) failures.push(message)
    if (!blockingFailures.includes(message)) blockingFailures.push(message)
  }
  const health: TemplateLibraryHealth = {
    ready: blockingFailures.length === 0,
    files: paths.length,
    loaded: records.length,
    good: records.filter(record => record.meta.quality === 'good').length,
    bad: records.filter(record => record.meta.quality === 'bad').length,
    failed: failures.length,
    failures,
    blockingFailures,
  }
  const library = { records, failures, health }
  templateCache.set(dir, library)
  return library
}

export function loadTemplates(dir: string = DEFAULT_TEMPLATES_DIR): TemplateRecord[] {
  return loadTemplateLibrary(dir).records
}

export function templateLibraryAllowsTraffic(
  health: TemplateLibraryHealth,
  environment: string | undefined = process.env.NODE_ENV,
): boolean {
  return environment !== 'production' || health.ready
}

function qualityHint(raw: unknown): TemplateQuality | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const meta = (raw as Record<string, unknown>).meta
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return undefined
  const quality = (meta as Record<string, unknown>).quality
  return quality === 'good' || quality === 'bad' ? quality : undefined
}

type HubForm = 'ldk' | 'dk' | 'separate' | 'none'

function hubFormOf(rooms: Array<{ type: RoomType; name: string }>): HubForm {
  const combined = rooms.filter(room => room.type === 'living_kitchen')
  if (combined.length === 1) return isDiningKitchenName(combined[0]!.name) ? 'dk' : 'ldk'
  if (combined.length > 1) return 'none'
  return rooms.some(room => room.type === 'living') ? 'separate' : 'none'
}

function countOfType(rooms: Array<{ type: RoomType }>, type: RoomType): number {
  return rooms.filter(room => room.type === type).length
}

// 1R/1K compact single-person units: the corridor (narrow_lot) layout IS the
// canonical built form of the program in the JP market, so a request WITHOUT
// a site constraint may still take such a template — but only for these
// programs and only on an exact program match. Everything else keeps the
// strict rule (an unconstrained 1LDK request must not land on the 4.5×12m
// うなぎの寝床 reference).
const CANONICALLY_CONSTRAINED_PROGRAMS = new Set(['1r', '1k'])

type TemplateMatch =
  | { ok: true; ratio: number; relaxedTypology: boolean }
  | { ok: false; reasons: string[] }

function matchTemplate(
  intent: LayoutIntent,
  template: TemplateRecord,
  strategy?: PartitionStrategyHint & { roomProgram?: string; serviceRoomCount?: number },
  requiredRooms?: Array<{ type: RoomType; count: number }>,
): TemplateMatch {
  const reasons: string[] = []
  const roomProgram = strategy?.roomProgram
  const templateProgram = template.meta.roomProgram
  if (roomProgram && templateProgram && roomProgram !== templateProgram) {
    reasons.push(`roomProgram mismatch: ${roomProgram} != ${templateProgram}`)
  }

  const templateTypology = template.meta.typology
  const strategyConstrained = strategy?.typology !== undefined
    && SITE_CONSTRAINED_TYPOLOGIES.has(strategy.typology)
  const templateConstrained = templateTypology !== undefined
    && SITE_CONSTRAINED_TYPOLOGIES.has(templateTypology)
  let relaxedTypology = false
  if (strategyConstrained !== templateConstrained) {
    const canonicalCompact = templateConstrained && !strategyConstrained
      && roomProgram !== undefined && roomProgram === templateProgram
      && CANONICALLY_CONSTRAINED_PROGRAMS.has(roomProgram)
    if (canonicalCompact) {
      relaxedTypology = true
    } else {
      reasons.push(`typology constraint mismatch: strategy ${strategy?.typology ?? 'none'} vs template ${templateTypology ?? 'none'}`)
    }
  } else if (strategyConstrained && strategy!.typology !== templateTypology) {
    reasons.push(`typology mismatch: ${strategy!.typology} != ${templateTypology}`)
  }

  const intentRooms = intent.rooms
  const templateRooms = template.plan.rooms
  const demandedServiceRooms = strategy?.serviceRoomCount ?? 0
  const templateServiceRooms = templateRooms.filter(
    room => room.type === 'storage' && isServiceRoomName(room.name),
  ).length
  if (templateServiceRooms < demandedServiceRooms) {
    reasons.push(`service room count below floor: template ${templateServiceRooms} < required ${demandedServiceRooms}`)
  }
  if (countOfType(intentRooms, 'bedroom') !== countOfType(templateRooms, 'bedroom')) {
    reasons.push(`bedroom count mismatch: ${countOfType(intentRooms, 'bedroom')} != ${countOfType(templateRooms, 'bedroom')}`)
  }
  if (hubFormOf(intentRooms) !== hubFormOf(templateRooms)) {
    reasons.push(`hubForm mismatch: ${hubFormOf(intentRooms)} != ${hubFormOf(templateRooms)}`)
  }
  // Core rooms must match EXACTLY in both directions — a template must never
  // smuggle in a study/dining the user didn't ask for (they'd keep their
  // template identity, invisible to the intent correspondence).
  for (const type of ['kitchen', 'living', 'dining', 'study', 'other'] as RoomType[]) {
    if (countOfType(intentRooms, type) !== countOfType(templateRooms, type)) {
      reasons.push(`${type} count mismatch: ${countOfType(intentRooms, type)} != ${countOfType(templateRooms, type)}`)
    }
  }
  // Service rooms: the template may be RICHER (卫浴分离/収納/玄関), never
  // poorer — "2 bathrooms requested" must not land on a 1-bathroom template.
  // The floor is the max of the intent's own rooms and the brief-derived
  // requiredRooms counts (which validation deliberately drops later).
  for (const type of SERVICE_TYPES) {
    const required = Math.max(
      countOfType(intentRooms, type),
      requiredRooms?.find(entry => entry.type === type)?.count ?? 0,
    )
    if (countOfType(templateRooms, type) < required) {
      reasons.push(`${type} count below floor: template ${countOfType(templateRooms, type)} < required ${required}`)
    }
  }
  const templateArea = footprintArea(template.plan.footprint)
  if (!(templateArea > 0)) {
    reasons.push('template footprint area is not positive')
    return { ok: false, reasons }
  }
  const ratio = intent.targetTotalAreaSqm / templateArea
  const areaRange = template.adaptation?.areaRatio ?? {
    min: MIN_AREA_RATIO,
    max: MAX_AREA_RATIO,
  }
  if (ratio < areaRange.min || ratio > areaRange.max) {
    reasons.push(`area ratio out of range: ${ratio.toFixed(2)} not in [${areaRange.min}, ${areaRange.max}]`)
  }
  if (reasons.length > 0) return { ok: false, reasons }
  return { ok: true, ratio, relaxedTypology }
}

function rejectionCode(reason: string): string {
  if (reason.startsWith('roomProgram mismatch')) return 'room_program_mismatch'
  if (reason.startsWith('typology constraint mismatch')) return 'typology_constraint_mismatch'
  if (reason.startsWith('typology mismatch')) return 'typology_mismatch'
  if (reason.startsWith('service room count below floor')) return 'service_room_shortage'
  if (reason.startsWith('bedroom count mismatch')) return 'bedroom_count_mismatch'
  if (reason.startsWith('hubForm mismatch')) return 'hub_form_mismatch'
  if (reason.startsWith('area ratio out of range')) return 'area_ratio_out_of_range'
  if (reason.includes('count mismatch')) return 'core_room_count_mismatch'
  if (reason.includes('count below floor')) return 'service_room_count_shortage'
  if (reason === 'template footprint area is not positive') return 'invalid_template_area'
  return 'other_mismatch'
}

type StretchBand = { from: number; to: number; weight: number }

function localAxisMapper(
  length: number,
  bands: StretchBand[] | undefined,
  targetLength: number,
): (value: number) => number {
  if (!bands) {
    const scale = targetLength / length
    return value => roundCm(value * scale)
  }
  const capacity = bands.reduce((sum, band) => sum + (band.to - band.from) * band.weight, 0)
  const delta = targetLength - length
  return value => {
    let weightedBefore = 0
    for (const band of bands) {
      weightedBefore += Math.max(0, Math.min(value, band.to) - band.from) * band.weight
    }
    return roundCm(value + delta * weightedBefore / capacity)
  }
}

// Core (non-service) template rooms take the intent's ids and names so the
// plan↔intent correspondence the modify path and gates rely on holds; the
// template's richer service program keeps its own identity.
function coreRoomRemap(
  intent: LayoutIntent,
  templateRooms: LayoutPlanRoom[],
): Map<string, { id: string; name: string; window?: boolean }> | null {
  const remap = new Map<string, { id: string; name: string; window?: boolean }>()
  const coreTypes: RoomType[] = ['bedroom', 'living_kitchen', 'living', 'kitchen', 'dining', 'study', 'other']
  for (const type of coreTypes) {
    const fromTemplate = templateRooms
      .filter(room => room.type === type)
      .sort((a, b) => polygonArea(b.polygon) - polygonArea(a.polygon))
    const fromIntent = intent.rooms
      .filter(room => room.type === type)
      .sort((a, b) => (b.targetAreaSqm ?? 0) - (a.targetAreaSqm ?? 0))
    for (let i = 0; i < Math.min(fromTemplate.length, fromIntent.length); i++) {
      const target = fromIntent[i]!
      remap.set(fromTemplate[i]!.id, {
        id: target.id,
        name: target.name,
        ...(target.requiresExteriorWindow !== undefined ? { window: target.requiresExteriorWindow } : {}),
      })
    }
  }
  const finalIds = templateRooms.map(room => remap.get(room.id)?.id ?? room.id)
  if (new Set(finalIds).size !== finalIds.length) return null
  return remap
}

function adaptTemplate(
  intent: LayoutIntent,
  template: TemplateRecord,
  ratio: number,
): Omit<TemplateSeedResult, 'validation'> | null {
  const remap = coreRoomRemap(intent, template.plan.rooms)
  if (!remap) return null
  const adaptation = template.adaptation
  const xShare = adaptation
    ? adaptation.xBands && adaptation.zBands ? 0.5 : adaptation.xBands ? 1 : 0
    : 0.5
  const xScale = Math.pow(ratio, xShare)
  const zScale = ratio / xScale
  const mapX = localAxisMapper(
    template.plan.footprint.width,
    adaptation?.xBands,
    template.plan.footprint.width * xScale,
  )
  const mapZ = localAxisMapper(
    template.plan.footprint.depth,
    adaptation?.zBands,
    template.plan.footprint.depth * zScale,
  )
  const scalePolygon = (polygon: Array<[number, number]>): Array<[number, number]> =>
    polygon.map(([x, z]) => [mapX(x), mapZ(z)])

  const rooms: LayoutPlanRoom[] = template.plan.rooms.map(room => {
    const mapped = remap.get(room.id)
    return {
      ...room,
      id: mapped?.id ?? room.id,
      name: mapped?.name ?? room.name,
      polygon: scalePolygon(room.polygon),
      requiresExteriorWindow: mapped?.window ?? room.requiresExteriorWindow,
    }
  })
  const mappedId = (id: string) => remap.get(id)?.id ?? id
  const plan: LayoutPlan = {
    footprint: {
      width: mapX(template.plan.footprint.width),
      depth: mapZ(template.plan.footprint.depth),
      ...(template.plan.footprint.polygon
        ? { polygon: scalePolygon(template.plan.footprint.polygon) }
        : {}),
    },
    entry: { roomId: mappedId(template.plan.entry.roomId) },
    rooms,
    connections: template.plan.connections.map(connection => ({
      ...connection,
      from: mappedId(connection.from),
      to: mappedId(connection.to),
    })),
  }
  const notes = [
    adaptation
      ? `复用参照户型「${template.meta.label}」（${template.id}），在声明的可伸缩区域适配到 ${Math.round(ratio * 100)}% 面积`
      : `复用参照户型「${template.meta.label}」（${template.id}），整体缩放到 ${Math.round(ratio * 100)}% 面积`,
  ]
  if (intent.rooms.some(room => room.targetAreaSqm !== undefined)) {
    notes.push('参照户型的房间比例优先，Intent 中的单房间目标面积未逐间套用')
  }
  return { plan, templateId: template.id, notes }
}

// Returns the adapted plan of the best-matching good reference, or null when
// nothing in the library fits (the partitioner is the fallback, always).
// `targets.requiredRooms` is deliberately dropped from the VALIDATION step —
// the template's service program may be richer than the brief's counts
// (卫浴分离/収納) by design — but its counts DO participate in matching as a
// lower bound (see matchRatio), so richer is allowed and poorer is not.
export function findTemplateSeed(
  intent: LayoutIntent,
  profile: NormProfile,
  strategy?: PartitionStrategyHint & {
    footprintHint?: { widthM: number; depthM: number }
    roomProgram?: string
    serviceRoomCount?: number
  },
  // `trace` collects per-template rejection reasons for the request trace —
  // debug data only, never rendered to users.
  options?: {
    targets?: PlanTargets
    templatesDir?: string
    trace?: string[]
    matchTrace?: TemplateMatchTrace
  },
): TemplateSeedResult | null {
  const trace = options?.trace
  if (strategy?.footprintHint) {
    trace?.push('seeding skipped: strategy carries an explicit footprintHint')
    return null
  }
  const { requiredRooms, ...targetRest } = options?.targets ?? {}
  const candidates: Array<{ template: TemplateRecord; ratio: number; relaxedTypology: boolean }> = []
  const library = loadTemplateLibrary(options?.templatesDir)
  for (const failure of library.failures) trace?.push(`template load failure: ${failure}`)
  for (const template of library.records) {
    if (template.meta.quality !== 'good' || template.meta.market !== profile.id) continue
    const match = matchTemplate(intent, template, strategy, requiredRooms)
    if (match.ok) {
      candidates.push({ template, ratio: match.ratio, relaxedTypology: match.relaxedTypology })
    } else {
      trace?.push(`${template.id} rejected: ${match.reasons.join('; ')}`)
      options?.matchTrace?.rejections.push({
        templateId: template.id,
        reasonCodes: [...new Set(match.reasons.map(rejectionCode))],
      })
    }
  }
  // Typology-consistent hits outrank canonical-form relaxations; area
  // closeness breaks ties.
  candidates.sort((a, b) =>
    Number(a.relaxedTypology) - Number(b.relaxedTypology)
    || Math.abs(Math.log(a.ratio)) - Math.abs(Math.log(b.ratio)))
  if (options?.matchTrace) {
    options.matchTrace.candidates.push(...candidates.map(candidate => ({
      templateId: candidate.template.id,
      areaRatio: candidate.ratio,
      relaxedTypology: candidate.relaxedTypology,
    })))
  }
  for (const { template, ratio } of candidates) {
    const adapted = adaptTemplate(intent, template, ratio)
    if (!adapted) {
      trace?.push(`${template.id} rejected: core-room remap produced duplicate ids`)
      options?.matchTrace?.rejections.push({
        templateId: template.id,
        reasonCodes: ['core_room_id_collision'],
      })
      continue
    }
    const validation = validateLayoutPlan(
      adapted.plan,
      { ...targetRest, totalAreaSqm: intent.targetTotalAreaSqm },
      profile,
    )
    if (validation.fatal.length > 0) {
      trace?.push(`${template.id} rejected: post-scale validation fatal: ${validation.fatal.join('; ')}`)
      options?.matchTrace?.rejections.push({
        templateId: template.id,
        reasonCodes: ['post_adaptation_validation_fatal'],
      })
      continue
    }
    if (options?.matchTrace) options.matchTrace.selectedTemplateId = template.id
    return { ...adapted, validation }
  }
  return null
}

function intentFromTemplate(template: TemplateRecord, targetAreaSqm: number): LayoutIntent {
  const ratio = targetAreaSqm / footprintArea(template.plan.footprint)
  return {
    targetTotalAreaSqm: targetAreaSqm,
    rooms: template.plan.rooms.map(room => ({
      id: room.id,
      name: room.name,
      type: room.type,
      targetAreaSqm: Math.round(polygonArea(room.polygon) * ratio * 100) / 100,
      requiresExteriorWindow: room.requiresExteriorWindow,
    })),
  }
}

export function findDirectTemplateSeed(
  targetAreaSqm: number | undefined,
  profile: NormProfile,
  strategy: PartitionStrategyHint & {
    footprintHint?: { widthM: number; depthM: number }
    roomProgram?: string
    serviceRoomCount?: number
    kitchenMode?: 'open' | 'closed'
  },
  options?: { targets?: PlanTargets; templatesDir?: string },
): { intent: LayoutIntent | null; seed: TemplateSeedResult | null; matchTrace: TemplateMatchTrace } {
  const matchTrace: TemplateMatchTrace = {
    mode: 'direct',
    market: profile.id,
    ...(strategy.roomProgram ? { roomProgram: strategy.roomProgram } : {}),
    ...(targetAreaSqm !== undefined ? { targetAreaSqm } : {}),
    candidates: [],
    rejections: [],
  }
  if (!targetAreaSqm || !strategy.roomProgram || strategy.footprintHint) {
    return { intent: null, seed: null, matchTrace }
  }
  const library = loadTemplateLibrary(options?.templatesDir)
  const preferred = library.records
    .filter(template => template.meta.quality === 'good')
    .filter(template => template.meta.market === profile.id)
    .filter(template => template.meta.roomProgram === strategy.roomProgram)
    .filter(template => {
      const hub = hubFormOf(template.plan.rooms)
      return strategy.kitchenMode === 'open' ? hub !== 'separate' : hub === 'separate'
    })
    .filter(template => (options?.targets?.requiredRooms ?? []).every(required =>
      countOfType(template.plan.rooms, required.type) >= required.count))
    .filter(template => {
      const demandedServiceRooms = strategy.serviceRoomCount ?? 0
      if (demandedServiceRooms === 0) return true
      return template.plan.rooms.filter(
        room => room.type === 'storage' && isServiceRoomName(room.name),
      ).length >= demandedServiceRooms
    })
    .sort((a, b) => {
      const aRatio = targetAreaSqm / footprintArea(a.plan.footprint)
      const bRatio = targetAreaSqm / footprintArea(b.plan.footprint)
      return Math.abs(Math.log(aRatio)) - Math.abs(Math.log(bRatio)) || a.id.localeCompare(b.id)
    })
  const best = preferred[0]
  if (!best) return { intent: null, seed: null, matchTrace }
  const intent = intentFromTemplate(best, targetAreaSqm)
  const seed = findTemplateSeed(intent, profile, strategy, {
    ...options,
    matchTrace,
  })
  return { intent, seed, matchTrace }
}
