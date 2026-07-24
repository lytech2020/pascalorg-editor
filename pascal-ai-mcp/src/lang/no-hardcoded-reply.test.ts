// ---------------------------------------------------------------------------
// Guardrail: user-facing replies must be rendered through t()/issueText(),
// never written as literal CJK strings. Internal Chinese (prompts,
// diagnostics, sceneResult) is fine BY DESIGN — this only scans lines that
// assign the user-visible `reply`. If this test fails, move the string into
// MESSAGES in src/lang/i18n.ts and render it with t(session.language, ...).
// ---------------------------------------------------------------------------

import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { t } from './i18n'

const CJK = /[぀-ヿ一-鿿]/
const REPLY_ASSIGNMENT = /\breply\s*[:=](?!=)/

test('agent.ts reply assignments contain no hardcoded CJK literals', () => {
  const source = readFileSync(new URL('../agent.ts', import.meta.url), 'utf8')
  const offenders: string[] = []
  source.split('\n').forEach((line, index) => {
    const trimmed = line.trim()
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) return
    if (REPLY_ASSIGNMENT.test(line) && CJK.test(line)) {
      offenders.push(`agent.ts:${index + 1}: ${trimmed}`)
    }
  })
  expect(offenders).toEqual([])
})

test('safe local rejection explains the risk without exposing an internal reason code', () => {
  const reply = t('zh', 'modifyStrictLocalUnavailable', {
    reason: 'strict_local_no_safe_plan',
  })

  expect(reply).toContain('当前场景没有被修改')
  expect(reply).toContain('建议在编辑器中手动调整')
  expect(reply).not.toContain('strict_local_no_safe_plan')
})
