import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { checkScope, contractProblems, matchesGlob } from './validate.ts'
import { META_PATH, turnBase, writeFileEnsuringDir } from './meta.ts'
import type { Result } from './schema.ts'

function result(over: Partial<Result> = {}): Result {
  return {
    status: 'ready_for_review',
    summary: 'Did the thing.',
    context: '',
    acceptance_criteria: [
      { criterion: 'The heading greets the name you typed.', steps: ['Type "Ada". It reads "Hello, Ada".'] },
    ],
    artifacts: [],
    questions: [],
    assumptions: [],
    reason: '',
    ...over,
  }
}

describe('contractProblems', () => {
  it('passes a finished turn that says what is true and how to check it', () => {
    expect(contractProblems(result())).toEqual([])
  })

  it('rejects a finished turn with no acceptance criteria', () => {
    const problems = contractProblems(result({ acceptance_criteria: [] }))
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('acceptance_criteria is empty')
  })

  it('rejects a criterion nobody can check, naming it', () => {
    const problems = contractProblems(
      result({
        acceptance_criteria: [
          { criterion: 'The greeting updates as you type.', steps: ['Type "Ada".'] },
          { criterion: 'It is accessible.', steps: [] },
        ],
      }),
    )
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('It is accessible.')
    expect(problems[0]).toContain('no steps')
  })

  it('does not ask a blocked or failed turn for criteria it cannot have', () => {
    const blocked = result({
      status: 'blocked',
      acceptance_criteria: [],
      questions: [{ question: 'Debounce?', context: '', options: [] }],
    })
    expect(contractProblems(blocked)).toEqual([])

    const failed = result({ status: 'failed', acceptance_criteria: [], reason: 'ran out of scope' })
    expect(contractProblems(failed)).toEqual([])
  })

  it('still catches the older rules', () => {
    expect(contractProblems(result({ status: 'question', questions: [] }))[0]).toContain(
      'no questions were given',
    )
    expect(contractProblems(result({ status: 'failed', reason: '  ' }))[0]).toContain(
      'no reason was given',
    )
  })
})

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

  // The design and the build now share one branch, so the design document is
  // sitting in the build turn's tree. It stays read-only to that turn: it is
  // outside the build allow list, and it only escapes being flagged because
  // `validate` measures the diff from the commit the turn started at rather
  // than from main. Both halves of that have to hold.
  it('still refuses to let a build turn write the design it shares a branch with', () => {
    expect(checkScope('build', ['docs/design/DF-1/design.md'])).toEqual([
      { path: 'docs/design/DF-1/design.md', reason: 'not-allowed' },
    ])
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

/**
 * What a turn's diff is measured from.
 *
 * This is the whole reason a build turn can share a branch with the design
 * that preceded it: measured from main, the build turn's diff would contain
 * the design document and `checkScope` would reject a file the agent never
 * touched.
 */
describe('turnBase', () => {
  const saved = existsSync(META_PATH) ? readFileSync(META_PATH, 'utf8') : null

  afterEach(() => {
    if (saved === null) rmSync(META_PATH, { force: true })
    else writeFileEnsuringDir(META_PATH, saved)
  })

  function meta(base_sha: string): void {
    writeFileEnsuringDir(META_PATH, JSON.stringify({ key: 'DF-1', base_sha }))
  }

  it('returns the base recorded at checkout', () => {
    meta('0123456789abcdef0123456789abcdef01234567')
    expect(turnBase()).toBe('0123456789abcdef0123456789abcdef01234567')
  })

  // Both fall back to the stricter check rather than to no check at all.
  it('falls back to main when there is no meta to read', () => {
    rmSync(META_PATH, { force: true })
    expect(turnBase()).toBe('origin/main')
  })

  it('falls back to main when nothing was recorded', () => {
    meta('   ')
    expect(turnBase()).toBe('origin/main')
  })
})
