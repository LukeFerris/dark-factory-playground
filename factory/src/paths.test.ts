import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CORE_DENIED, DEFAULT_PATHS, allowedPaths, deniedPaths, readPaths, resetPaths } from './paths.ts'
import { kickoffComment } from './preview.ts'
import { lockfileArgs } from './publish.ts'
import { configPath } from './statuses.ts'
import { checkScope } from './validate.ts'

function configure(config: unknown): void {
  writeFileSync(configPath(), JSON.stringify(config))
  resetPaths()
}

afterEach(() => {
  rmSync(configPath(), { force: true })
  resetPaths()
})

/** A repository with the app at the root and a database beside it. */
const ROOT_APP = {
  design: ['docs/design/**', 'docs/adr/**'],
  build: ['src/**', 'e2e/**', 'package.json', 'package-lock.json', 'supabase/migrations/**'],
  denied: ['vite.config.ts', 'playwright.config.ts'],
}

describe('with no paths in enki.json', () => {
  it('uses this repository’s lists', () => {
    expect(readPaths()).toBe(DEFAULT_PATHS)
    configure({ jira: {} })
    expect(allowedPaths('build')).toContain('app/src/**')
    expect(deniedPaths()).toEqual([...CORE_DENIED, ...DEFAULT_PATHS.denied])
  })
})

describe('with paths in enki.json', () => {
  it('replaces the allow lists outright', () => {
    configure({ paths: ROOT_APP })
    expect(allowedPaths('build')).toEqual(ROOT_APP.build)
    expect(allowedPaths('design')).toEqual(ROOT_APP.design)
  })

  it('judges a turn by them', () => {
    configure({ paths: ROOT_APP })
    expect(checkScope('build', ['src/App.tsx', 'supabase/migrations/20261013_x.sql', 'package.json'])).toEqual([])
    expect(checkScope('build', ['app/src/App.tsx'])).toEqual([{ path: 'app/src/App.tsx', reason: 'not-allowed' }])
    expect(checkScope('build', ['vite.config.ts'])).toEqual([{ path: 'vite.config.ts', reason: 'denied' }])
  })

  it('keeps the factory’s own deny list, whatever the allow list says', () => {
    configure({ paths: { ...ROOT_APP, build: ['**'], denied: [] } })
    const violations = checkScope('build', [
      '.github/workflows/x.yml',
      '.agent/build.md',
      'factory/src/validate.ts',
      'bootstrap/github.sh',
      'enki.json',
      'src/App.tsx',
    ])
    expect(violations.map((v) => v.reason)).toEqual(['denied', 'denied', 'denied', 'denied', 'denied'])
  })

  it('lists them in the kickoff comment', () => {
    configure({ paths: ROOT_APP })
    const body = kickoffComment('WKB-1', null)
    expect(body).toContain('`src/**`')
    expect(body).toContain('`supabase/migrations/**`')
    expect(body).not.toContain('app/src')
  })
})

describe('a paths block it refuses', () => {
  it('refuses one without a build list', () => {
    configure({ paths: { design: ['docs/**'] } })
    expect(() => readPaths()).toThrow(/paths\.build/)
  })

  it('refuses an empty allow list', () => {
    configure({ paths: { ...ROOT_APP, design: [] } })
    expect(() => readPaths()).toThrow(/paths\.design/)
  })

  it('refuses an absolute path', () => {
    configure({ paths: { ...ROOT_APP, build: ['/src/**'] } })
    expect(() => readPaths()).toThrow(/relative to the repo root/)
  })

  // A misspelt `denied` would otherwise be dropped and the deny list with it.
  it('refuses a key it does not know', () => {
    configure({ paths: { ...ROOT_APP, deny: ['x'] } })
    expect(() => readPaths()).toThrow(/deny/)
  })
})

describe('lockfileArgs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lockfile-'))

  it('resolves every workspace when there are workspaces', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ workspaces: ['app', 'factory'] }))
    expect(lockfileArgs(dir)).toEqual(['install', '--package-lock-only', '--workspaces', '--include-workspace-root'])
  })

  it('resolves the root package alone when there are none', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'app' }))
    expect(lockfileArgs(dir)).toEqual(['install', '--package-lock-only'])
  })
})
