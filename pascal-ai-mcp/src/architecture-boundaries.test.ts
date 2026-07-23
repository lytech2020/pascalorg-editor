import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, extname, join, relative, resolve } from 'node:path'

const SRC = join(import.meta.dir)

describe('application/domain dependency boundaries', () => {
  test('domain contains no infrastructure imports', () => {
    assertNoForbiddenDependencies('domain', [
      'application', 'ports', 'persistence', 'adapters', 'server', 'mcp', 'openai-compatible',
      '@langchain', 'bun:sqlite',
    ])
  })

  test('application depends on contracts and pure modules, not concrete adapters', () => {
    assertNoForbiddenDependencies('application', [
      'persistence', 'adapters', 'server', 'mcp', 'openai-compatible', '@langchain', 'bun:sqlite', './config',
    ])
  })

  test('ports do not point back into infrastructure', () => {
    assertNoForbiddenDependencies('ports', [
      'persistence', 'adapters', 'server', 'mcp', 'openai-compatible', '@langchain', 'bun:sqlite', './config',
    ])
  })

  test('prompt definitions do not depend on model, persistence or workflow adapters', () => {
    assertNoForbiddenDependencies('prompts', [
      'application', 'ports', 'persistence', 'adapters', 'server', 'mcp',
      'openai-compatible', '@langchain', 'bun:sqlite', './config',
    ])
  })
})

function assertNoForbiddenDependencies(directory: string, forbidden: string[]): void {
  const failures: string[] = []
  for (const entrypoint of typescriptFiles(join(SRC, directory))) {
    inspectDependencies(entrypoint, forbidden, failures, [], new Set())
  }
  expect([...new Set(failures)].sort()).toEqual([])
}

function inspectDependencies(
  file: string,
  forbidden: string[],
  failures: string[],
  trail: string[],
  visited: Set<string>,
): void {
  if (visited.has(file)) return
  visited.add(file)
  for (const specifier of importSpecifiers(readFileSync(file, 'utf8'))) {
    const nextTrail = [...trail, relative(SRC, file)]
    if (forbidden.some(token => specifier.includes(token))) {
      failures.push(`${nextTrail.join(' -> ')} -> ${specifier}`)
      continue
    }
    const dependency = resolveSourceImport(file, specifier)
    if (dependency) inspectDependencies(dependency, forbidden, failures, nextTrail, visited)
  }
}

function importSpecifiers(source: string): string[] {
  return [...source.matchAll(/(?:from\s+|import\s*\()['"]([^'"]+)['"]/g)].map(match => match[1]!)
}

function resolveSourceImport(importer: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined
  const candidate = resolve(dirname(importer), specifier)
  const possibilities = extname(candidate)
    ? [candidate]
    : [`${candidate}.ts`, join(candidate, 'index.ts')]
  return possibilities.find(path => path.startsWith(SRC) && Bun.file(path).size > 0)
}

function typescriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return typescriptFiles(path)
    return entry.isFile() && path.endsWith('.ts') && !path.endsWith('.test.ts') ? [path] : []
  })
}
