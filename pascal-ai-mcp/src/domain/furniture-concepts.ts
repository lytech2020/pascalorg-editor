// ---------------------------------------------------------------------------
// Modify-path furniture concept registry (MODIFY_REDESIGN §5, R3).
//
// The op translator emits a short furniture word in the user's language. That
// word must resolve to exactly ONE concept before the executor runs, because a
// concept fixes three things the executor needs deterministically:
//   • the catalog search terms (English-first, the built-in catalog's language),
//   • the trilingual matcher that finds the concept among already-placed items,
//   • the PLACEMENT STRATEGY — a 餐桌/茶几 belongs in the room centre, a 书桌/床
//     against a wall. Sending every item through the wall scan (the old
//     behaviour) makes centre-type furniture "not fit" even in an empty room.
//
// A genuinely vague word (「桌子」/table) maps to several concepts; the executor
// must ask which one, never silently pick 书桌 (P2-2). This registry owns that
// distinction so the catalog query, the placed-item matcher, and the user-
// facing label all derive from one source (R3.1).
// ---------------------------------------------------------------------------

export type PlacementStrategy = 'wall_aligned' | 'room_center'

export type FurnitureConcept = {
  // Stable key used in audit/telemetry and tests.
  key: string
  // User-facing display name (zh; re-rendered at the reply boundary).
  label: string
  // search_assets queries, English-first (the catalog is English-only today).
  searchTerms: string[]
  // Recognizes the concept in a user term or an already-placed item's name
  // (中/日/英). Reused from the generation checklist where one already exists.
  match: RegExp
  placement: PlacementStrategy
}

// Concepts the modify path can place or match. Wall-aligned unless a concept is
// genuinely centre-of-room furniture. Kept intentionally small — every concept
// here must be one the catalog can actually satisfy.
export const FURNITURE_CONCEPTS: readonly FurnitureConcept[] = [
  {
    key: 'bed',
    label: '床',
    searchTerms: ['bed', 'double bed', '双人床', '床'],
    match: /\bbed\b|ベッド|(?<![头铺沙发]|床头)床(?!头|垫|品)/iu,
    placement: 'wall_aligned',
  },
  {
    key: 'wardrobe',
    label: '衣柜',
    searchTerms: ['wardrobe', 'closet', '衣柜'],
    match: /衣柜|衣橱|wardrobe|closet|タンス|箪笥|ワードローブ|クローゼット/i,
    placement: 'wall_aligned',
  },
  {
    key: 'sofa',
    label: '沙发',
    searchTerms: ['sofa', 'couch', '沙发'],
    match: /沙发|sofa|couch|ソファ/i,
    placement: 'wall_aligned',
  },
  {
    key: 'desk',
    label: '书桌',
    searchTerms: ['desk', 'writing desk', 'office desk', '书桌', '办公桌'],
    match: /书桌|办公桌|写字台|study[-_ ]?desk|writing[-_ ]?desk|office[-_ ]?desk|\bdesk\b|デスク|勉強机/i,
    placement: 'wall_aligned',
  },
  {
    key: 'coffee_table',
    label: '茶几',
    searchTerms: ['coffee table', '茶几'],
    match: /茶几|coffee[-_ ]?table|ローテーブル|センターテーブル/i,
    placement: 'room_center',
  },
  {
    key: 'dining_table',
    label: '餐桌',
    searchTerms: ['dining table', '餐桌'],
    match: /餐桌|饭桌|餐台|dining[-_ ]?table|ダイニングテーブル|食卓/i,
    placement: 'room_center',
  },
  {
    key: 'wardrobe_chair_office',
    label: '办公椅',
    searchTerms: ['office chair', '办公椅'],
    match: /办公椅|转椅|office[-_ ]?chair|desk[-_ ]?chair|オフィスチェア/i,
    placement: 'wall_aligned',
  },
]

// Vague words whose plain reading spans several concepts. The bare word must
// trigger a clarification, never a silent substitution (P2-2 field repro:
// 客厅「桌子」 must not become 书桌/餐桌/茶几 on its own). The candidate list is
// what the user is offered. Order = the order the concepts are presented.
type AmbiguousTerm = { match: RegExp; conceptKeys: string[] }

const AMBIGUOUS_TERMS: readonly AmbiguousTerm[] = [
  // 桌子 / a bare "table": desk vs dining table vs coffee table.
  {
    match: /^(桌子|桌|台子|テーブル|table)$/i,
    conceptKeys: ['dining_table', 'coffee_table', 'desk'],
  },
]

export type ConceptResolution =
  | { kind: 'concept'; concept: FurnitureConcept }
  | { kind: 'ambiguous'; term: string; candidates: FurnitureConcept[] }
  | { kind: 'unknown'; term: string }

function conceptByKey(key: string): FurnitureConcept | undefined {
  return FURNITURE_CONCEPTS.find(concept => concept.key === key)
}

// Resolve a user furniture term to a single concept, an ambiguity (with the
// concepts to offer), or unknown. Ambiguity is checked FIRST so a vague word
// that also happens to match one concept's regex (「桌子」 loosely matching a
// desk term) is still surfaced for clarification rather than silently bound.
export function resolveFurnitureConcept(term: string): ConceptResolution {
  const trimmed = term.trim()
  if (!trimmed) return { kind: 'unknown', term }
  for (const ambiguous of AMBIGUOUS_TERMS) {
    if (ambiguous.match.test(trimmed)) {
      const candidates = ambiguous.conceptKeys
        .map(conceptByKey)
        .filter((concept): concept is FurnitureConcept => concept !== undefined)
      if (candidates.length > 1) return { kind: 'ambiguous', term: trimmed, candidates }
    }
  }
  const lower = trimmed.toLowerCase()
  const direct = FURNITURE_CONCEPTS.find(concept =>
    concept.match.test(trimmed) || concept.searchTerms.some(s => s.toLowerCase() === lower))
  if (direct) return { kind: 'concept', concept: direct }
  return { kind: 'unknown', term: trimmed }
}

// Placement strategy for an already-resolved or best-effort term. Falls back to
// wall_aligned for terms outside the registry — the safe default for the
// broadest range of furniture.
export function placementStrategyFor(term: string): PlacementStrategy {
  const resolution = resolveFurnitureConcept(term)
  return resolution.kind === 'concept' ? resolution.concept.placement : 'wall_aligned'
}
