import { describe, expect, it } from 'vitest'
import { checkScope, matchesGlob } from './validate.ts'

describe('matchesGlob', () => {
  it('matches ** across path segments', () => {
    expect(matchesGlob('app/src/components/Hello.tsx', 'app/src/**')).toBe(true)
    expect(matchesGlob('app/src/Hello.tsx', 'app/src/**')).toBe(true)
    expect(matchesGlob('app/public/logo.svg', 'app/src/**')).toBe(false)
  })

  it('does not let a single * cross a path separator', () => {
    expect(matchesGlob('docs/design/DF-1/build-log.md', 'docs/design/*/build-log.md')).toBe(true)
    expect(matchesGlob('docs/design/DF-1/sub/build-log.md', 'docs/design/*/build-log.md')).toBe(false)
  })

  it('matches exact paths', () => {
    expect(matchesGlob('package-lock.json', 'package-lock.json')).toBe(true)
    expect(matchesGlob('app/package-lock.json', 'package-lock.json')).toBe(false)
  })

  it('matches tsconfig*.json but not a nested one', () => {
    expect(matchesGlob('tsconfig.base.json', 'tsconfig*.json')).toBe(true)
    expect(matchesGlob('app/tsconfig.json', 'tsconfig*.json')).toBe(false)
  })
})

describe('checkScope — design stage', () => {
  it('accepts design documents and ADRs', () => {
    expect(checkScope('design', ['docs/design/DF-1/design.md', 'docs/adr/0002-x.md'])).toEqual([])
  })

  it('rejects application code', () => {
    const violations = checkScope('design', ['app/src/App.tsx'])
    expect(violations).toEqual([{ path: 'app/src/App.tsx', reason: 'not-allowed' }])
  })
})

describe('checkScope — build stage', () => {
  it('accepts app source, the lockfile and the build log', () => {
    expect(
      checkScope('build', [
        'app/src/components/Hello.tsx',
        'app/package.json',
        'package-lock.json',
        'docs/design/DF-1/build-log.md',
      ]),
    ).toEqual([])
  })

  it('rejects the factory machinery even though the stage has a broad allow list', () => {
    const violations = checkScope('build', [
      '.github/workflows/build-turn.yml',
      '.agent/build.md',
      'factory/src/validate.ts',
      'bootstrap/github.sh',
    ])
    expect(violations.map((v) => v.reason)).toEqual(['denied', 'denied', 'denied', 'denied'])
  })

  it('rejects the tooling config files a build turn must not loosen', () => {
    const violations = checkScope('build', [
      'app/eslint.config.js',
      'app/tsconfig.json',
      'app/vite.config.ts',
      'package.json',
      'tsconfig.base.json',
    ])
    expect(violations).toHaveLength(5)
    expect(violations.every((v) => v.reason === 'denied')).toBe(true)
  })

  it('rejects a path that is simply not on the list', () => {
    expect(checkScope('build', ['README.md'])).toEqual([
      { path: 'README.md', reason: 'not-allowed' },
    ])
  })
})
