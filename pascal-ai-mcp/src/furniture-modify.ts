// ---------------------------------------------------------------------------
// Deterministic furniture modify (docs/MODIFY_REDESIGN.md §5, batch M1).
//
// Executes the furniture ModifyOps against the live scene with zero model
// calls, reusing the generation executor's machinery: catalog search +
// smallest-first ranking + wall-adjacent placement scan + door clearances.
// Structure is never touched — these ops exist precisely so "换个沙发" does
// not re-partition anything.
//
// Item matching for remove/swap: the requested term is resolved through
// `search_assets` (the catalog owns the trilingual vocabulary) and existing
// room items match by asset id; a case-insensitive name match is the
// fallback for items whose asset left the catalog. Multiple matches delete
// the LAST placed one (§5) — the most recently added item is the most likely
// regret.
// ---------------------------------------------------------------------------

import {
  doorClearances,
  findCenterPlacement,
  findWallPlacement,
  footprintAt,
  parseCandidates,
  rankCandidates,
  type CatalogCandidate,
  type Footprint2D,
  type FurnitureRoom,
} from './furniture-executor'
import { findVocabularyOption, isFixedEquipmentName } from './furniture-checklist'
import {
  placementStrategyFor,
  resolveFurnitureConcept,
  type PlacementStrategy,
} from './domain/furniture-concepts'
import { pointInPolygon } from './layout-plan'
import type { FurnitureModifyOp, SkippedFurnitureOp } from './modify-ops'
import { callWithRetry, WriteEffectLedger, type McpCaller, type WriteEffectState } from './scene-executor'

const MAX_CANDIDATES = 4

// R3.4: stable, low-sensitivity outcome codes so the user, logs and tests can
// tell WHY a furniture op did not achieve its goal — instead of one opaque
// furniture_target_not_met. Only carried on failed results.
export type FurnitureModifyReasonCode =
  | 'room_not_found'
  | 'needs_clarification'
  | 'catalog_no_match'
  | 'no_safe_position'
  | 'item_not_found'
  | 'mutation_failed'
  | 'catalog_unavailable'
  | 'not_executed'
  | 'scene_read_failed'
  | 'skipped_dependency'

export type FurnitureModifyResult = {
  op: FurnitureModifyOp
  ok: boolean
  // A dependency made this operation unnecessary before execution (for
  // example, its room was removed by another op in the same plan).
  status?: 'skipped'
  // zh internal, re-rendered at the reply boundary like executor reports.
  detail: string
  // R3.4: structured non-success reason. A skipped result carries
  // `skipped_dependency` even though `ok` remains true for compatibility.
  reasonCode?: FurnitureModifyReasonCode
  // Set whenever a scene item was actually deleted (remove / swap, even a
  // swap whose replacement then failed) — the modify gates use it to waive
  // "missing equipment" failures the user's own removal caused.
  removed?: { roomName: string; itemName: string }
  removedItemId?: string
  // R4: a bulk clear deletes many items in one op — every deleted id so the
  // local-patch scope check treats each removal as in-scope.
  removedItemIds?: string[]
  addedItemId?: string
}

export type FurnitureModifyReport = {
  results: FurnitureModifyResult[]
  executionIssues: string[]
  // R1.3: real side-effect state produced by the mutation wrapper.
  writeEffect: WriteEffectState
}

export function skippedFurnitureResults(
  entries: readonly SkippedFurnitureOp[],
): FurnitureModifyResult[] {
  return entries.map(entry => ({
    op: entry.op,
    ok: true,
    status: 'skipped',
    reasonCode: 'skipped_dependency',
    detail: `「${entry.roomName}」已随房间删除，家具操作（${entry.op.op}）未执行`,
  }))
}

type SceneItem = {
  id: string
  name: string
  assetId: string | null
  assetName: string
  dimensions: [number, number, number]
  position: [number, number, number]
  rotationY: number
  roomId: string | null
}

function isNumberTriple(value: unknown): value is [number, number, number] {
  return Array.isArray(value) && value.length === 3 && value.every(v => typeof v === 'number')
}

function itemFootprint(item: SceneItem): Footprint2D {
  return footprintAt(item.position[0], item.position[2], item.dimensions[0], item.dimensions[2], item.rotationY)
}

// FurnitureRoom reference resolution: zone id → exact name only (R2.2). The
// substring-first guess is gone — when 卧室1/卧室2 both exist and the ref is a
// bare 卧室, picking the first array element is exactly the silent wrong-room
// bug (P1-3). Ambiguity is resolved deterministically UPSTREAM (resolveRoomRef
// binds every op to a concrete roomId before it reaches here), so by this point
// a ref is either a bound id/zoneId or an exact name.
function resolveRoom(ref: string, rooms: FurnitureRoom[]): FurnitureRoom | null {
  return rooms.find(room => room.id === ref || room.zoneId === ref)
    ?? rooms.find(room => room.name === ref)
    ?? null
}

// Recognizer for a furniture term: the concept registry (R3.1) is consulted
// first — it owns the modify vocabulary and covers concepts the generation
// checklist lacks (餐桌) — falling back to the checklist option for anything
// the registry does not model.
function recognizerFor(term: string): { match: RegExp; searchTerms: string[] } | null {
  const resolution = resolveFurnitureConcept(term)
  if (resolution.kind === 'concept') {
    return { match: resolution.concept.match, searchTerms: resolution.concept.searchTerms }
  }
  const option = findVocabularyOption(term)
  return option ? { match: option.match, searchTerms: option.searchTerms } : null
}

async function searchTerm(
  callMcp: McpCaller,
  term: string,
  issues: string[],
  beforeCall?: () => void,
): Promise<CatalogCandidate[]> {
  // When the term maps to a known concept/option, only candidates its matcher
  // recognizes count — same guard as the generation executor's
  // searchCandidates. Without it, a broad catalog search ("bed" hits every
  // asset tagged "bedroom") makes swap delete the wardrobe and place a
  // bedside table as the "单人床" (case-18 online regression).
  const recognizer = recognizerFor(term)
  const recognized = (candidates: CatalogCandidate[]) =>
    recognizer ? candidates.filter(candidate => recognizer.match.test(candidate.name)) : candidates
  const query = async (q: string) => recognized(parseCandidates(
    await callWithRetry(callMcp, 'search_assets', { query: q }, issues, `检索「${q}」`, beforeCall)))
  const primary = await query(term)
  if (primary.length > 0) return primary
  // The op translator emits terms in the user's language while the catalog
  // is English-only — retry through the concept's English-first search terms
  // before declaring the term unknown.
  if (!recognizer) return primary
  for (const fallback of recognizer.searchTerms) {
    if (fallback === term) continue
    const candidates = await query(fallback)
    if (candidates.length > 0) return candidates
  }
  return primary
}

// Existing room items matching a user term: catalog-id match first (the
// catalog owns the vocabulary), then the checklist option's trilingual
// matcher, then name substring as a last resort — the term may be CJK while
// placed items carry English catalog names.
function matchRoomItems(items: SceneItem[], room: FurnitureRoom, term: string, catalogIds: Set<string>): SceneItem[] {
  const inRoom = items.filter(item => item.roomId === room.id)
  const byAsset = inRoom.filter(item => item.assetId !== null && catalogIds.has(item.assetId))
  if (byAsset.length > 0) return byAsset
  const matcher = recognizerFor(term)?.match
  if (matcher) {
    const byVocab = inRoom.filter(item => matcher.test(item.name) || matcher.test(item.assetName))
    if (byVocab.length > 0) return byVocab
  }
  const needle = term.toLowerCase()
  return inRoom.filter(item =>
    item.name.toLowerCase().includes(needle) || item.assetName.toLowerCase().includes(needle))
}

// Reads placed floor items (wall/ceiling fixtures excluded) and assigns each to
// its home room by centre-point containment. Shared by the modify executor and
// the clear-furniture preview so both see the exact same item set.
async function loadFloorItems(
  callMcp: McpCaller,
  rooms: FurnitureRoom[],
  issues: string[],
  beforeCall?: () => void,
): Promise<{ items: SceneItem[]; readFailed: boolean }> {
  const summaryPayload = await callWithRetry(callMcp, 'get_level_summary', {}, issues, '读取已放置家具', beforeCall)
  // P1-B: a FAILED read (null after retries) is NOT an empty scene. Signal it so
  // callers never mistake a read failure for "no furniture" — which would let a
  // clear report success while deleting nothing, or a remove claim the item is
  // absent.
  if (summaryPayload === null) return { items: [], readFailed: true }
  const rawItems = Array.isArray(summaryPayload.items) ? summaryPayload.items : []
  const items: SceneItem[] = []
  for (const entry of rawItems) {
    const value = entry as {
      id?: unknown
      name?: unknown
      position?: unknown
      rotation?: unknown
      asset?: { id?: unknown; name?: unknown; dimensions?: unknown; attachTo?: unknown }
    }
    if (typeof value.id !== 'string' || !isNumberTriple(value.position)) continue
    if (value.asset?.attachTo === 'wall' || value.asset?.attachTo === 'ceiling') continue
    const position = value.position
    const dims = isNumberTriple(value.asset?.dimensions)
      ? value.asset.dimensions
      : [1, 1, 1] as [number, number, number]
    const home = rooms.find(room => pointInPolygon(position[0], position[2], room.polygon))
    items.push({
      id: value.id,
      name: typeof value.name === 'string' ? value.name : value.id,
      assetId: typeof value.asset?.id === 'string' ? value.asset.id : null,
      assetName: typeof value.asset?.name === 'string' ? value.asset.name : '',
      dimensions: dims,
      position: value.position,
      rotationY: isNumberTriple(value.rotation) ? value.rotation[1] : 0,
      roomId: home?.id ?? null,
    })
  }
  return { items, readFailed: false }
}

// R4 movable-furniture test: a floor item that is NOT fixed kitchen/bath
// equipment. (Wall/ceiling fixtures are already excluded by loadFloorItems.)
function isMovableFurniture(item: SceneItem): boolean {
  return !isFixedEquipmentName(item.name) && !isFixedEquipmentName(item.assetName)
}

export type RoomClearPreview = {
  roomId: string
  roomName: string
  itemIds: string[]
  itemNames: string[]
}

// R4.3: before a bulk clear writes anything, enumerate exactly which movable
// items would be deleted per room — the count-and-confirm turn shows this and
// the confirmed execution can be checked against it.
export async function previewRoomFurnitureClear(options: {
  rooms: FurnitureRoom[]
  levelId: string
  callMcp: McpCaller
  beforeCall?: () => void
}): Promise<{ perRoom: RoomClearPreview[]; readFailed: boolean; executionIssues: string[] }> {
  const { rooms, callMcp, beforeCall } = options
  const issues: string[] = []
  const { items, readFailed } = await loadFloorItems(callMcp, rooms, issues, beforeCall)
  if (readFailed) return { perRoom: [], readFailed: true, executionIssues: issues }
  const perRoom = rooms.map(room => {
    const movable = items.filter(item => item.roomId === room.id && isMovableFurniture(item))
    return {
      roomId: room.id,
      roomName: room.name,
      itemIds: movable.map(item => item.id),
      itemNames: movable.map(item => item.name),
    }
  })
  return { perRoom, readFailed: false, executionIssues: issues }
}

export async function executeFurnitureModifyOps(options: {
  ops: FurnitureModifyOp[]
  rooms: FurnitureRoom[]
  levelId: string
  callMcp: McpCaller
  beforeCall?: () => void
  // P1-3: called on every write-effect transition so the caller can persist the
  // real side-effect state in real time (before the executor even returns).
  onWriteEffect?: (state: WriteEffectState) => void
  // P1-5: for clear_room_furniture, the exact item ids confirmed for deletion,
  // keyed by roomId. When present, the clear deletes ONLY these ids (still
  // movable and present) — never a freshly-read set that may have changed since
  // confirmation.
  clearTargets?: Record<string, string[]>
  // Confirmed writes that already landed before this stage (e.g. a rename
  // apply_patch) so onWriteEffect reports a verdict spanning both.
  priorConfirmedWrites?: number
}): Promise<FurnitureModifyReport> {
  const { ops, rooms, levelId, callMcp, beforeCall, onWriteEffect, clearTargets } = options
  const issues: string[] = []
  const results: FurnitureModifyResult[] = []
  const ledger = new WriteEffectLedger(onWriteEffect)
  ledger.seedConfirmed(options.priorConfirmedWrites ?? 0)

  const wallsPayload = await callWithRetry(callMcp, 'get_walls', { levelId }, issues, '读取墙体清单', beforeCall)
  const isPair = (v: unknown): v is [number, number] =>
    Array.isArray(v) && v.length === 2 && typeof v[0] === 'number' && typeof v[1] === 'number'
  const walls = (Array.isArray(wallsPayload?.walls) ? wallsPayload.walls : [])
    .filter((wall): wall is { start: [number, number]; end: [number, number]; openings: never[] } => {
      const value = wall as { start?: unknown; end?: unknown; openings?: unknown }
      return isPair(value?.start) && isPair(value?.end) && Array.isArray(value?.openings)
    })
  const keepClear = doorClearances(walls)

  const { items, readFailed } = await loadFloorItems(callMcp, rooms, issues, beforeCall)
  // P1-B: the placed-furniture read is the source of truth for what to
  // remove/clear/match. If it FAILED, we cannot tell an empty room from an
  // unread one — fail every op with zero writes rather than delete nothing and
  // call it success, or claim an item is absent.
  if (readFailed) {
    for (const op of ops) {
      results.push({ op, ok: false, detail: '读取场景家具失败，未执行任何修改（请稍后重试）', reasonCode: 'scene_read_failed' })
    }
    return { results, executionIssues: issues, writeEffect: ledger.state }
  }

  // Occupied footprints track deletions/additions across ops in this run.
  const occupied = new Map<string, Footprint2D>()
  for (const item of items) occupied.set(item.id, itemFootprint(item))
  const liveItems = [...items]

  const removeItem = async (item: SceneItem): Promise<boolean> => {
    const payload = await callWithRetry(callMcp, 'delete_node', { id: item.id }, issues, `删除「${item.name}」`, beforeCall, ledger)
    if (payload === null) return false
    occupied.delete(item.id)
    const index = liveItems.findIndex(entry => entry.id === item.id)
    if (index !== -1) liveItems.splice(index, 1)
    return true
  }

  // R3.3: the placement scan follows the concept's strategy — 餐桌/茶几 land in
  // the room centre, everything else against a wall. `room_center` falls back
  // to the wall scan if the centre is genuinely blocked (a lit spot beats none).
  const scanFor = (
    strategy: PlacementStrategy,
    polygon: Array<[number, number]>,
    itemDims: [number, number, number],
    obstacles: Footprint2D[],
  ): { position: [number, number, number]; rotationY: number } | null => {
    if (strategy === 'room_center') {
      return findCenterPlacement({ polygon, itemDims, occupied: obstacles, keepClear })
        ?? findWallPlacement({ polygon, itemDims, occupied: obstacles, keepClear })
    }
    return findWallPlacement({ polygon, itemDims, occupied: obstacles, keepClear })
  }

  const placeCandidate = async (
    room: FurnitureRoom,
    candidates: CatalogCandidate[],
    strategy: PlacementStrategy,
    excluded?: Footprint2D,
  ): Promise<{ item: SceneItem; candidate: CatalogCandidate } | { reason: string; reasonCode: FurnitureModifyReasonCode; placeholderId?: string }> => {
    const floorCandidates = rankCandidates(candidates).slice(0, MAX_CANDIDATES)
    if (floorCandidates.length === 0) {
      return { reason: '目录中检索不到匹配资产', reasonCode: 'catalog_no_match' }
    }
    const obstacles = [...occupied.values()].filter(fp => fp !== excluded)
    for (const candidate of floorCandidates) {
      const spot = scanFor(strategy, room.polygon, candidate.dimensions, obstacles)
      if (!spot) continue
      const payload = await callWithRetry(
        callMcp,
        'place_item',
        {
          catalogItemId: candidate.id,
          targetNodeId: room.zoneId ?? levelId,
          position: spot.position,
          rotation: spot.rotationY,
        },
        issues,
        `在「${room.name}」放置「${candidate.name}」`,
        beforeCall,
        ledger,
      )
      const itemId = typeof payload?.itemId === 'string' ? payload.itemId : null
      // P1-4: a catalog_unavailable placeholder was written — STOP. Trying more
      // candidates would create more placeholders. Report it as a write, not a
      // clean no-op, and hand back the placeholder id for scope/cleanup.
      if (itemId && payload?.status === 'catalog_unavailable') {
        return { reason: '目录资产暂不可用，已生成占位物但未放置目标家具', reasonCode: 'catalog_unavailable', placeholderId: itemId }
      }
      // P1-2: the place call's result is unknown — stop trying candidates.
      if (ledger.halted) {
        return { reason: '放置写入结果未知，已停止后续放置', reasonCode: 'mutation_failed' }
      }
      if (!itemId) continue
      const item: SceneItem = {
        id: itemId,
        name: candidate.name,
        assetId: candidate.id,
        assetName: candidate.name,
        dimensions: candidate.dimensions,
        position: spot.position,
        rotationY: spot.rotationY,
        roomId: room.id,
      }
      occupied.set(itemId, itemFootprint(item))
      liveItems.push(item)
      return { item, candidate }
    }
    return { reason: '所有候选规格都放不进剩余空间（无合法位置）', reasonCode: 'no_safe_position' }
  }

  // R3.2/R3.5: a vague furniture term (「桌子」) that spans several concepts is
  // NOT silently bound to one — it fails with a clarification listing the
  // candidate concepts, zero writes. Used by add and swap's target term.
  const clarifyIfAmbiguous = (op: FurnitureModifyOp, term: string): FurnitureModifyResult | null => {
    const resolution = resolveFurnitureConcept(term)
    if (resolution.kind !== 'ambiguous') return null
    const options = resolution.candidates.map(concept => concept.label).join('、')
    return {
      op,
      ok: false,
      detail: `「${term}」可能指${options}，请明确是哪一种再试`,
      reasonCode: 'needs_clarification',
    }
  }

  for (const op of ops) {
    // P1-2: a prior write's result is unknown — do not start any further op.
    // The remaining ops are reported as not-executed, never silently passed.
    if (ledger.halted) {
      results.push({ op, ok: false, detail: '因前序写入结果未知，此操作未执行', reasonCode: 'not_executed' })
      continue
    }
    const room = resolveRoom(op.room, rooms)
    if (!room) {
      results.push({ op, ok: false, detail: `找不到房间「${op.room}」`, reasonCode: 'room_not_found' })
      continue
    }

    if (op.op === 'remove_furniture') {
      const catalog = await searchTerm(callMcp, op.item, issues, beforeCall)
      const matches = matchRoomItems(liveItems, room, op.item, new Set(catalog.map(c => c.id)))
      if (matches.length === 0) {
        results.push({ op, ok: false, detail: `「${room.name}」里没有找到「${op.item}」`, reasonCode: 'item_not_found' })
        continue
      }
      // R3.5 / P2-6: with several matches and no reliable creation-order field,
      // do NOT claim "the last-placed one". Delete the last list entry but say
      // honestly how many matched and that placement order is unknown.
      const target = matches[matches.length - 1]!
      const ok = await removeItem(target)
      results.push({
        op,
        ok,
        detail: ok
          ? matches.length > 1
            ? `已删除「${room.name}」的一件「${target.name}」（共匹配到 ${matches.length} 件，放置先后无法确定；如需删除其他件请具体说明）`
            : `已删除「${room.name}」的「${target.name}」`
          : `删除「${target.name}」失败`,
        ...(ok ? {} : { reasonCode: 'mutation_failed' as const }),
        ...(ok ? { removed: { roomName: room.name, itemName: target.name } } : {}),
        ...(ok ? { removedItemId: target.id } : {}),
      })
    } else if (op.op === 'clear_room_furniture') {
      // R4.4: delete every MOVABLE item in the room, one delete_node per item
      // (single execution — never a replayed batch). Fixed kitchen/bath
      // equipment and wall/ceiling fixtures are retained (R4.2). Per-item audit
      // with an honest partial result; no auto-rollback is claimed (R4.5).
      // P1-5: if a confirmed target set exists, delete only those ids (still
      // present and movable) — not a fresh sweep that may have changed.
      const confirmed = clearTargets?.[room.id]
      const movable = liveItems.filter(item =>
        item.roomId === room.id
        && isMovableFurniture(item)
        && (confirmed === undefined || confirmed.includes(item.id)))
      if (movable.length === 0) {
        results.push({ op, ok: true, detail: `「${room.name}」没有可清空的可移动家具` })
        continue
      }
      const removedNames: string[] = []
      const removedIds: string[] = []
      const failedNames: string[] = []
      for (const item of movable) {
        // P1-2: if a prior delete's result is unknown, stop the batch — the
        // remaining items are left, and reported as such below.
        if (ledger.halted) { failedNames.push(item.name); continue }
        if (await removeItem(item)) {
          removedNames.push(item.name)
          removedIds.push(item.id)
        } else {
          failedNames.push(item.name)
        }
      }
      const ok = failedNames.length === 0
      results.push({
        op,
        ok,
        detail: ok
          ? `已清空「${room.name}」的 ${removedNames.length} 件可移动家具（固定设备已保留）`
          : `「${room.name}」清空未完成：已删除 ${removedNames.length} 件，${failedNames.length} 件删除失败（${failedNames.join('、')}）；未自动回滚，请检查后重试`,
        ...(ok ? {} : { reasonCode: 'mutation_failed' as const }),
        ...(removedIds.length > 0 ? { removedItemIds: removedIds } : {}),
        ...(removedNames.length > 0
          ? { removed: { roomName: room.name, itemName: removedNames.join('、') } }
          : {}),
      })
    } else if (op.op === 'add_furniture') {
      const clarify = clarifyIfAmbiguous(op, op.item)
      if (clarify) { results.push(clarify); continue }
      const catalog = await searchTerm(callMcp, op.item, issues, beforeCall)
      const placed = await placeCandidate(room, catalog, placementStrategyFor(op.item))
      results.push('reason' in placed
        ? {
            op,
            ok: false,
            detail: `「${op.item}」放不进「${room.name}」：${placed.reason}`,
            reasonCode: placed.reasonCode,
            // A catalog_unavailable placeholder is a real write — expose its id
            // so the local-patch scope check treats it as in-scope.
            ...(placed.placeholderId ? { addedItemId: placed.placeholderId } : {}),
          }
        : {
            op,
            ok: true,
            detail: `已在「${room.name}」放置「${placed.candidate.name}」`,
            addedItemId: placed.item.id,
          })
    } else {
      // Clarify a vague replacement target before touching the scene.
      const clarify = clarifyIfAmbiguous(op, op.to)
      if (clarify) { results.push(clarify); continue }
      // Dry placement catches catalog/geometry failures before deletion. A
      // later place_item failure can still leave the old item removed, so the
      // result retains removedItemId and reports that partial outcome.
      const oldCatalog = await searchTerm(callMcp, op.from, issues, beforeCall)
      const matches = matchRoomItems(liveItems, room, op.from, new Set(oldCatalog.map(c => c.id)))
      if (matches.length === 0) {
        results.push({ op, ok: false, detail: `「${room.name}」里没有找到「${op.from}」`, reasonCode: 'item_not_found' })
        continue
      }
      const target = matches[matches.length - 1]!
      const strategy = placementStrategyFor(op.to)
      const newCatalog = await searchTerm(callMcp, op.to, issues, beforeCall)
      const floorCandidates = rankCandidates(newCatalog).slice(0, MAX_CANDIDATES)
      if (floorCandidates.length === 0) {
        results.push({ op, ok: false, detail: `目录中检索不到「${op.to}」，「${target.name}」保持不变`, reasonCode: 'catalog_no_match' })
        continue
      }
      // Dry placement with the old item's footprint excluded — the new item
      // may take its spot.
      const targetFp = occupied.get(target.id)
      const obstacles = [...occupied.entries()].filter(([id]) => id !== target.id).map(([, fp]) => fp)
      let spotFound = false
      for (const candidate of floorCandidates) {
        if (scanFor(strategy, room.polygon, candidate.dimensions, obstacles)) {
          spotFound = true
          break
        }
      }
      if (!spotFound) {
        results.push({ op, ok: false, detail: `「${op.to}」放不进「${room.name}」，「${target.name}」保持不变`, reasonCode: 'no_safe_position' })
        continue
      }
      const removed = await removeItem(target)
      if (!removed) {
        results.push({ op, ok: false, detail: `删除「${target.name}」失败，未执行更换`, reasonCode: 'mutation_failed' })
        continue
      }
      const placed = await placeCandidate(room, newCatalog, strategy, targetFp)
      const removedInfo = { removed: { roomName: room.name, itemName: target.name } }
      results.push('reason' in placed
        ? {
            op,
            ok: false,
            detail: `已删除「${target.name}」但「${op.to}」放置失败：${placed.reason}`,
            reasonCode: placed.reasonCode,
            ...removedInfo,
            removedItemId: target.id,
            ...(placed.placeholderId ? { addedItemId: placed.placeholderId } : {}),
          }
        : {
            op,
            ok: true,
            detail: `已将「${room.name}」的「${target.name}」换为「${placed.candidate.name}」`,
            ...removedInfo,
            removedItemId: target.id,
            addedItemId: placed.item.id,
          })
    }
  }

  return { results, executionIssues: issues, writeEffect: ledger.state }
}

// --- manual-item replay (MODIFY_REDESIGN.md §6, structural rebuild) ---------

// An item is checklist-covered when any checklist option recognizes its name
// — those come back through the furnishing pass after a rebuild. Everything
// else (decor, user-picked extras) is "manual" and must be replayed.
export function isChecklistItem(name: string): boolean {
  return findVocabularyOption(name) !== null
}

export type ManualItem = {
  catalogItemId: string
  name: string
  dimensions: [number, number, number]
  // Room name in the PRE-rebuild scene; replay matches it against the
  // rebuilt rooms by name (rename keeps snapshots in step, so names hold).
  roomName: string
}

export type ManualReplayReport = {
  replaced: string[]
  lost: Array<{ name: string; reason: string }>
  executionIssues: string[]
  writeEffect: WriteEffectState
}

// Best-effort re-placement of manual items after a structural rebuild:
// same wall-scan constraints as every other placement — an item that no
// longer fits (room shrank / removed) lands in `lost`, reported, never
// silently dropped.
export async function replayManualItems(options: {
  items: ManualItem[]
  rooms: FurnitureRoom[]
  levelId: string
  callMcp: McpCaller
  beforeCall?: () => void
}): Promise<ManualReplayReport> {
  const { items, rooms, levelId, callMcp, beforeCall } = options
  const issues: string[] = []
  const replaced: string[] = []
  const lost: Array<{ name: string; reason: string }> = []
  const ledger = new WriteEffectLedger()
  if (items.length === 0) return { replaced, lost, executionIssues: issues, writeEffect: ledger.state }

  const wallsPayload = await callWithRetry(callMcp, 'get_walls', { levelId }, issues, '读取墙体清单', beforeCall)
  const isPair = (v: unknown): v is [number, number] =>
    Array.isArray(v) && v.length === 2 && typeof v[0] === 'number' && typeof v[1] === 'number'
  const walls = (Array.isArray(wallsPayload?.walls) ? wallsPayload.walls : [])
    .filter((wall): wall is { start: [number, number]; end: [number, number]; openings: never[] } => {
      const value = wall as { start?: unknown; end?: unknown; openings?: unknown }
      return isPair(value?.start) && isPair(value?.end) && Array.isArray(value?.openings)
    })
  const keepClear = doorClearances(walls)

  const summaryPayload = await callWithRetry(callMcp, 'get_level_summary', {}, issues, '读取已放置家具', beforeCall)
  const rawItems = Array.isArray(summaryPayload?.items) ? summaryPayload.items : []
  const occupied: Footprint2D[] = []
  for (const entry of rawItems) {
    const value = entry as { position?: unknown; rotation?: unknown; asset?: { dimensions?: unknown; attachTo?: unknown } }
    if (!isNumberTriple(value.position)) continue
    if (value.asset?.attachTo === 'wall' || value.asset?.attachTo === 'ceiling') continue
    const dims = isNumberTriple(value.asset?.dimensions) ? value.asset.dimensions : [1, 1, 1] as [number, number, number]
    const rotationY = isNumberTriple(value.rotation) ? value.rotation[1] : 0
    occupied.push(footprintAt(value.position[0], value.position[2], dims[0], dims[2], rotationY))
  }

  for (const item of items) {
    const room = rooms.find(entry => entry.name === item.roomName)
    if (!room) {
      lost.push({ name: item.name, reason: `所在房间「${item.roomName}」已不存在` })
      continue
    }
    const spot = findWallPlacement({
      polygon: room.polygon,
      itemDims: item.dimensions,
      occupied,
      keepClear,
    })
    if (!spot) {
      lost.push({ name: item.name, reason: `「${item.roomName}」中没有可放置的位置` })
      continue
    }
    const payload = await callWithRetry(
      callMcp,
      'place_item',
      {
        catalogItemId: item.catalogItemId,
        targetNodeId: room.zoneId ?? levelId,
        position: spot.position,
        rotation: spot.rotationY,
      },
      issues,
      `重放「${item.name}」到「${room.name}」`,
      beforeCall,
      ledger,
    )
    const itemId = typeof payload?.itemId === 'string' ? payload.itemId : null
    if (!itemId || payload?.status === 'catalog_unavailable') {
      lost.push({ name: item.name, reason: '资产已不在目录中，无法重放' })
      continue
    }
    occupied.push(footprintAt(spot.position[0], spot.position[2], item.dimensions[0], item.dimensions[2], spot.rotationY))
    replaced.push(item.name)
  }
  return { replaced, lost, executionIssues: issues, writeEffect: ledger.state }
}
