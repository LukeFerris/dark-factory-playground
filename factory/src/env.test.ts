import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadDotEnv, optional, prUrl, required, runUrl } from './env.ts'

/** Every variable these tests touch, put back exactly as it was after each one. */
const NAMES = [
  'ENV_TEST_PLAIN',
  'ENV_TEST_DOUBLE',
  'ENV_TEST_SINGLE',
  'ENV_TEST_SPACED',
  'ENV_TEST_SET',
  'ENV_TEST_EQUALS',
  'GITHUB_SERVER_URL',
  'GITHUB_REPOSITORY',
  'GITHUB_RUN_ID',
] as const
const previous = NAMES.map((name) => process.env[name])

afterEach(() => {
  NAMES.forEach((name, i) => {
    if (previous[i] === undefined) delete process.env[name]
    else process.env[name] = previous[i]
  })
})

describe('loadDotEnv', () => {
  let root = ''
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'env-test-'))
    for (const name of NAMES) delete process.env[name]
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('reads KEY=value lines, unquoting either kind of quote', () => {
    writeFileSync(
      join(root, '.env'),
      [
        '# a comment',
        '',
        'ENV_TEST_PLAIN=plain',
        'ENV_TEST_DOUBLE="double quoted"',
        "ENV_TEST_SINGLE='single quoted'",
        '  ENV_TEST_SPACED  =  spaced  ',
        'ENV_TEST_EQUALS=a=b',
        'not a setting',
      ].join('\n'),
    )
    loadDotEnv(root)
    expect(process.env['ENV_TEST_PLAIN']).toBe('plain')
    expect(process.env['ENV_TEST_DOUBLE']).toBe('double quoted')
    expect(process.env['ENV_TEST_SINGLE']).toBe('single quoted')
    expect(process.env['ENV_TEST_SPACED']).toBe('spaced')
    expect(process.env['ENV_TEST_EQUALS']).toBe('a=b')
  })

  // In Actions the values arrive as real environment variables; a stray .env
  // must not quietly replace them.
  it('never overrides what is already in the environment', () => {
    process.env['ENV_TEST_SET'] = 'from the workflow'
    writeFileSync(join(root, '.env'), 'ENV_TEST_SET=from the file\n')
    loadDotEnv(root)
    expect(process.env['ENV_TEST_SET']).toBe('from the workflow')
  })

  it('does nothing when there is no .env', () => {
    expect(() => loadDotEnv(root)).not.toThrow()
    expect(process.env['ENV_TEST_PLAIN']).toBeUndefined()
  })
})

describe('required and optional', () => {
  it('returns a variable that is set', () => {
    process.env['ENV_TEST_PLAIN'] = 'value'
    expect(required('ENV_TEST_PLAIN')).toBe('value')
    expect(optional('ENV_TEST_PLAIN', 'fallback')).toBe('value')
  })

  it('treats empty as missing', () => {
    process.env['ENV_TEST_PLAIN'] = ''
    expect(() => required('ENV_TEST_PLAIN')).toThrow(
      'Missing required environment variable ENV_TEST_PLAIN. ' +
        'Set it in .env (local) or as a workflow secret/variable (CI).',
    )
    expect(optional('ENV_TEST_PLAIN', 'fallback')).toBe('fallback')
  })

  it('falls back to an empty string when given no fallback', () => {
    delete process.env['ENV_TEST_PLAIN']
    expect(optional('ENV_TEST_PLAIN')).toBe('')
  })
})

describe('links back to GitHub', () => {
  beforeEach(() => {
    delete process.env['GITHUB_SERVER_URL']
    process.env['GITHUB_REPOSITORY'] = 'acme/dark-factory-playground'
    process.env['GITHUB_RUN_ID'] = '123'
  })

  it('links the run that is executing, on github.com unless told otherwise', () => {
    expect(runUrl()).toBe('https://github.com/acme/dark-factory-playground/actions/runs/123')
    process.env['GITHUB_SERVER_URL'] = 'https://ghe.example'
    expect(runUrl()).toBe('https://ghe.example/acme/dark-factory-playground/actions/runs/123')
  })

  it('has no run link outside Actions', () => {
    delete process.env['GITHUB_RUN_ID']
    expect(runUrl()).toBeNull()
  })

  it('links a pull request by number in this repository', () => {
    expect(prUrl(7)).toBe('https://github.com/acme/dark-factory-playground/pull/7')
  })

  it('has no pull request link without a number or a repository', () => {
    expect(prUrl(null)).toBeNull()
    delete process.env['GITHUB_REPOSITORY']
    expect(prUrl(7)).toBeNull()
  })
})
