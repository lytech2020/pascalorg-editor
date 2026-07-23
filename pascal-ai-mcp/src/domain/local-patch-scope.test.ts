import { describe, expect, test } from 'bun:test'
import { validateLocalPatchScope } from './local-patch-scope'

const before = {
  'zone-1': { type: 'zone', name: '卧室', children: ['item-1'], polygon: [[0, 0], [2, 0], [2, 2], [0, 2]] },
  'wall-1': { type: 'wall', start: [0, 0], end: [2, 0] },
  'item-1': { type: 'item', name: '床', parentId: 'zone-1' },
}

describe('local patch scope', () => {
  test('allows a target rename and no other zone fields', () => {
    expect(validateLocalPatchScope(before, {
      ...before,
      'zone-1': { ...before['zone-1'], name: '儿童房' },
    }, [{ nodeId: 'zone-1', fields: ['name'] }])).toEqual([])
  })

  test('allows target item replacement plus the parent children list', () => {
    const { ['item-1']: _removed, ...remaining } = before
    expect(validateLocalPatchScope(before, {
      ...remaining,
      'zone-1': { ...before['zone-1'], children: ['item-2'] },
      'item-2': { type: 'item', name: '书桌', parentId: 'zone-1' },
    }, [
      { nodeId: 'item-1', fields: 'all' },
      { nodeId: 'item-2', fields: 'all' },
      { nodeId: 'zone-1', fields: ['children'] },
    ])).toEqual([])
  })

  test('rejects unrelated structure, opening and furniture changes', () => {
    const findings = validateLocalPatchScope(before, {
      ...before,
      'wall-1': { ...before['wall-1'], end: [3, 0] },
      'door-1': { type: 'door', parentId: 'wall-1' },
      'item-1': { ...before['item-1'], position: [1, 0, 1] },
    }, [{ nodeId: 'zone-1', fields: ['name'] }])
    expect(findings).toEqual([
      { code: 'unexpected_node_added', nodeId: 'door-1', fields: ['parentId', 'type'] },
      { code: 'unexpected_node_modified', nodeId: 'item-1', fields: ['position'] },
      { code: 'unexpected_node_modified', nodeId: 'wall-1', fields: ['end'] },
    ])
  })
})
