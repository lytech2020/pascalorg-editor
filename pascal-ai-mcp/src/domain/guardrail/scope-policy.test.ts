import { describe, expect, test } from 'bun:test'
import { classifyScopeRequest } from './scope-policy'

describe('scope guardrail policy (T3.7)', () => {
  test('blocks only explicit weather questions in Chinese, Japanese and English', () => {
    for (const message of ['今天天气怎么样？', '今日の天気は？', "What's the weather today?"]) {
      expect(classifyScopeRequest({ message, hasImage: false })).toEqual({
        decision: 'block', reasonCode: 'explicit_weather',
      })
    }
  })

  test('allows architectural language and always treats an image as context', () => {
    for (const message of ['帮我做两室一厅户型', '2LDKの間取り', 'add a bedroom']) {
      expect(classifyScopeRequest({ message, hasImage: false }).decision).toBe('allow')
    }
    expect(classifyScopeRequest({ message: '看看这个', hasImage: true })).toEqual({
      decision: 'allow', reasonCode: 'image_context',
    })
  })

  test('fails open for uncertain short or mixed requests', () => {
    for (const message of ['帮我看看', '这个怎么改', 'weather side facing light']) {
      expect(classifyScopeRequest({ message, hasImage: false })).toEqual({
        decision: 'defer', reasonCode: 'uncertain',
      })
    }
  })
})
