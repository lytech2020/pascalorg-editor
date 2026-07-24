import { describe, expect, test } from 'bun:test'
import { promptRegistryEntries, renderPrompt } from './registry'

const EXPECTED_PROMPT_SNAPSHOT = {
  'extract:v1': '8e732a5be7f5a0f2c7a31c5bb21e2de6517e700d891d9a532a0a56715dedcf8d',
  'scene-intent:v1': 'e349db1c0bfca34dea8c82a6f155e1ad7c10128c117c0953772dbaeb5c0f42c4',
  'plan:intent:v1': 'cc188ca849609bf8909bdd5270e93e82da3b9033f16385aab03608c5720c0018',
  'plan:geometry:v1': '7471d105e31eb2e62cc9a06ca0cd86cd48dcc8dd2715ad78e8d2f6385a4575e5',
  'modify-ops:v1': '6eca0e58a4c68946240ceb8376dc55ee0bd4bf36ca7e6caa9ab3937aa8ebfae2',
  'modification-guard:v1': '3a9e5b1cc312d69c31029f002142c914ae7a72b6adeb89141a837b202529546f',
  'inspect:v1': 'a7f310a3f36a74adab147840e968695452128820c551e0ce9c37ffaa4b08438c',
  'scene-agent:v1': 'c0ce5b9bcbef561974bd7c0e5f354dfc7ed7aa71e728016e6d79b08a7fcfa250',
  'repair:v1': 'e8cab116d0ff2d8892715fdec9901c42f6bdf4bbdf74514aba355782d5bc45b6',
}

describe('prompt registry', () => {
  test('locks content hashes to explicit versions', () => {
    expect(Object.fromEntries(
      promptRegistryEntries().map(entry => [entry.promptVersion, entry.promptHash]),
    )).toEqual(EXPECTED_PROMPT_SNAPSHOT)
  })

  test('keeps dynamic user and scene values out of version identity', () => {
    const first = renderPrompt('inspect', { history: 'first history\n', question: 'first question' })
    const second = renderPrompt('inspect', { history: 'other history\n', question: 'other question' })
    expect(first.parts.user).not.toBe(second.parts.user)
    expect(first.promptVersion).toBe(second.promptVersion)
    expect(first.promptHash).toBe(second.promptHash)
  })

  test('fails before a model call when a required variable is absent or unknown', () => {
    expect(() => renderPrompt('extract', {
      briefJson: '{}',
      message: '60㎡',
    } as never)).toThrow('missing string variable "inputType"')
    expect(() => renderPrompt('modification-guard', {
      unexpected: 'value',
    } as never)).toThrow('unknown variable "unexpected"')
  })

  test('renders optional sections without changing the stable template', () => {
    const withoutHistory = renderPrompt('scene-intent', {
      history: '',
      latest: 'rename it',
    })
    const withHistory = renderPrompt('scene-intent', {
      history: 'User: the bedroom',
      latest: 'rename it',
    })
    expect(withoutHistory.parts.user).toBe('rename it')
    expect(withHistory.parts.user).toContain('Recent conversation:\nUser: the bedroom')
    expect(withHistory.parts.user).toContain('Latest message to classify: rename it')
    expect(withHistory.promptHash).toBe(withoutHistory.promptHash)
  })

  test('treats template-like syntax in dynamic user content as literal text', () => {
    const templateLikeInput = '{{bedroom}} and {{#weather}}sunny{{/weather}}'
    expect(renderPrompt('extract', {
      briefJson: '{}',
      message: templateLikeInput,
      inputType: 'text',
    }).parts.user).toContain(`最新文字：${templateLikeInput}`)
    expect(renderPrompt('scene-intent', {
      history: '',
      latest: templateLikeInput,
    }).parts.user).toBe(templateLikeInput)
    expect(renderPrompt('modify-ops', {
      roomList: '卧室1',
      request: templateLikeInput,
      errors: '',
    }).parts.user).toContain(`用户请求：${templateLikeInput}`)
    expect(renderPrompt('inspect', {
      history: '',
      question: templateLikeInput,
    }).parts.user).toBe(templateLikeInput)
  })
})
