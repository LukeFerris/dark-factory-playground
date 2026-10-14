import { readFileSync, rmSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { changedFiles } from './git.ts'
import { RESULT_PATH, writeFileEnsuringDir } from './meta.ts'
import type { Result } from './schema.ts'
import { validate } from './validate.ts'

/**
 * `validate` end to end: a result file on disk, a diff, and the verdict.
 *
 * The diff comes from git, which is the one thing stubbed here — what is under
 * test is what happens to the result file afterwards, because that file is
 * what the `report` step puts on the card whether the turn passed or not.
 */

vi.mock('./git.ts', () => ({ changedFiles: vi.fn(() => []) }))
const diff = vi.mocked(changedFiles)

function result(over: Partial<Result> = {}): Result {
  return {
    status: 'ready_for_review',
    summary: 'Did the thing.',
    context: 'Because.',
    acceptance_criteria: [{ criterion: 'It greets you.', steps: ['Type "Ada".'] }],
    out_of_scope: ['Farewells.'],
    answers: [{ question: 'Formal?', answer: 'No — kept it casual.' }],
    artifacts: ['app/src/App.tsx'],
    questions: [],
    assumptions: ['Assumed English.'],
    reason: '',
    ...over,
  }
}

function writeResult(body: unknown): void {
  writeFileEnsuringDir(RESULT_PATH, typeof body === 'string' ? body : JSON.stringify(body))
}

function onDisk(): Result {
  return JSON.parse(readFileSync(RESULT_PATH, 'utf8')) as Result
}

beforeEach(() => diff.mockReturnValue(['app/src/App.tsx']))
afterEach(() => rmSync(RESULT_PATH, { force: true }))

describe('a turn that passes', () => {
  it('is ok, and its result file is left exactly as the agent wrote it', () => {
    writeResult(result())
    const before = readFileSync(RESULT_PATH, 'utf8')

    const outcome = validate('build')

    expect(outcome).toEqual({ ok: true, result: result(), violations: [], problems: [] })
    expect(readFileSync(RESULT_PATH, 'utf8')).toBe(before)
  })

  it('measures the diff from the base it is given', () => {
    writeResult(result())
    validate('build', 'abc123')
    expect(diff).toHaveBeenCalledWith('abc123')
  })
})

describe('a turn whose result file is unusable', () => {
  it('says the file is missing, and writes one for the report to read', () => {
    const outcome = validate('design')

    expect(outcome.ok).toBe(false)
    expect(outcome.problems[0]).toBe('The agent did not write .agent/out/result.json.')
    expect(onDisk()).toMatchObject({
      status: 'failed',
      summary: 'The design turn was rejected by validation.',
      acceptance_criteria: [],
      answers: [],
    })
  })

  it('says the file is not JSON', () => {
    writeResult('{ nope')
    expect(validate('build').problems[0]).toMatch(/^result\.json is not valid JSON: /)
  })

  it('names the field that misses the contract', () => {
    writeResult({ status: 'done', summary: 'x' })
    expect(validate('build').problems[0]).toMatch(
      /^result\.json does not match the contract: status: /,
    )
  })

  it('names the root when the whole thing is the wrong shape', () => {
    writeResult([])
    expect(validate('build').problems[0]).toContain('(root): ')
  })
})

describe('a turn that breaks the rules', () => {
  it('reports a contract rule the schema cannot express', () => {
    writeResult(result({ acceptance_criteria: [] }))
    expect(validate('build').problems).toEqual([
      expect.stringContaining('acceptance_criteria is empty'),
    ])
  })

  it('names each path it may not write, and why', () => {
    writeResult(result())
    diff.mockReturnValue(['factory/src/validate.ts', 'README.md'])

    const outcome = validate('build')

    expect(outcome.violations).toHaveLength(2)
    expect(outcome.problems).toEqual([
      'factory/src/validate.ts is never writable by an agent.',
      'README.md is outside the paths a build turn may write.',
    ])
  })

  // What the agent did manage to say still reaches the card, and so does
  // anybody's answer it acknowledged.
  it('keeps what the agent wrote, and gives every problem as the reason', () => {
    writeResult(result())
    diff.mockReturnValue(['README.md'])

    const outcome = validate('build')

    expect(onDisk()).toEqual({
      ...result(),
      status: 'failed',
      summary: 'The build turn was rejected by validation.',
      reason: 'README.md is outside the paths a build turn may write.',
    })
    expect(outcome.result).toEqual(onDisk())
  })
})
