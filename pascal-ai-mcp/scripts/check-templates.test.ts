import { describe, expect, test } from 'bun:test'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scriptPath = join(import.meta.dir, 'check-templates.ts')
const realTemplatesDir = join(import.meta.dir, '..', 'templates')

function runCheck(dir: string): { exitCode: number; output: string } {
  const result = Bun.spawnSync(['bun', scriptPath, dir, '--no-artifacts'], {
    cwd: join(import.meta.dir, '..'),
  })
  return {
    exitCode: result.exitCode,
    output: `${result.stdout.toString()}${result.stderr.toString()}`,
  }
}

describe('check-templates CLI', () => {
  test('fails on an empty template directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tpl-check-'))
    try {
      const { exitCode, output } = runCheck(dir)
      expect(exitCode).toBe(1)
      expect(output).toContain('模板目录为空')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // quality outside the enum means the template is silently ignored by the
  // seed matcher — the check must make that loud.
  test('fails on a quality value outside good/bad', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tpl-check-'))
    try {
      mkdirSync(join(dir, 'good'))
      cpSync(realTemplatesDir, dir, { recursive: true })
      const sample = join(dir, 'good', 'quality-typo.json')
      const record = JSON.parse(readFileSync(join(realTemplatesDir, 'good', 'tpl-jp-2dk-44.json'), 'utf8'))
      record.id = 'tpl-quality-typo'
      record.meta.quality = 'excellent'
      writeFileSync(sample, JSON.stringify(record))
      const { exitCode, output } = runCheck(dir)
      expect(exitCode).toBe(1)
      expect(output).toContain('meta.quality')
      expect(output).toContain('expected one of "good"|"bad"')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('fails on malformed JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tpl-check-'))
    try {
      cpSync(realTemplatesDir, dir, { recursive: true })
      writeFileSync(join(dir, 'good', 'broken.json'), '{"id":"broken"')
      const { exitCode, output } = runCheck(dir)
      expect(exitCode).toBe(1)
      expect(output).toContain('模板加载失败')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('fails when a checked-in template omits schemaVersion', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tpl-check-'))
    try {
      mkdirSync(join(dir, 'good'))
      const record = JSON.parse(readFileSync(join(realTemplatesDir, 'good', 'tpl-jp-2dk-44.json'), 'utf8'))
      delete record.schemaVersion
      writeFileSync(join(dir, 'good', 'missing-version.json'), JSON.stringify(record))
      const { exitCode, output } = runCheck(dir)
      expect(exitCode).toBe(1)
      expect(output).toContain('schemaVersion')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('passes on the real template library', () => {
    const { exitCode, output } = runCheck(realTemplatesDir)
    expect(exitCode).toBe(0)
    expect(output).toContain('体检通过')
  })
})
