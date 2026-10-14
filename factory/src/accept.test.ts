import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The factory works on whatever FACTORY_REPO_ROOT names, read once at import,
// so it has to name the scratch repository before anything is imported.
const ROOT = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const root = mkdtempSync(join(tmpdir(), 'accept-card-'))
  process.env['FACTORY_REPO_ROOT'] = root
  return root
})

import { TURN_REF, acceptTurn } from './accept.ts'
import { MERGE_RESULT_PATH, attemptMerge, writeMergeState, type MergeState } from './merge.ts'
import { RESULT_PATH, readMeta, writeMeta } from './meta.ts'

/**
 * Real repositories, because what is under test is what git makes of an
 * agent's history. Each test has a card repository (the publishing job's
 * checkout, at ROOT) and an agent clone of it (the agent job's), and hands the
 * one to the other as a bundle, as the workflow does.
 */

const IDENTITY = [
  '-c',
  'user.name=t',
  '-c',
  'user.email=t@example.com',
  '-c',
  'commit.gpgsign=false',
]
const run = (cwd: string, ...args: string[]): string =>
  execFileSync('git', [...IDENTITY, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
const write = (dir: string, path: string, body: string | Buffer): void => {
  mkdirSync(join(dir, path, '..'), { recursive: true })
  writeFileSync(join(dir, path), body)
}
// Tools that watch git, such as git-ai, can still be writing into a repository
// just after a commit, so deleting one retries until they have finished.
const remove = (dir: string): void =>
  rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
const commit = (dir: string, message: string): string => {
  run(dir, 'add', '-A')
  run(dir, 'commit', '-q', '--allow-empty', '-m', message)
  return run(dir, 'rev-parse', 'HEAD')
}

let scratch: string
let agent: string
let bundle: string
let before: string
let main: string
const BRANCH = 'card/DF-9-say-hello'

beforeEach(() => {
  remove(ROOT)
  mkdirSync(ROOT)
  scratch = mkdtempSync(join(tmpdir(), 'accept-agent-'))
  agent = join(scratch, 'agent')
  bundle = join(scratch, 'turn.bundle')

  run(ROOT, 'init', '-q', '-b', 'main')
  write(ROOT, 'app/src/greeting.ts', 'export const greeting = "hi"\n')
  write(ROOT, 'app/src/colour.ts', 'export const colour = "red"\n')
  commit(ROOT, 'start')
  run(ROOT, 'checkout', '-q', '-b', BRANCH)
  write(ROOT, 'app/src/greeting.ts', 'export const greeting = "hello"\n')
  before = commit(ROOT, 'DF-9: design')
  run(ROOT, 'checkout', '-q', 'main')
  write(ROOT, 'app/src/colour.ts', 'export const colour = "blue"\n')
  main = commit(ROOT, 'DF-7: paint it blue')
  run(ROOT, 'checkout', '-q', BRANCH)
  run(scratch, 'clone', '-q', ROOT, agent)
  run(agent, 'checkout', '-q', BRANCH)

  writeMeta({
    key: 'DF-9',
    stage: 'build',
    turn: 2,
    branch: BRANCH,
    base_sha: before,
    pr: 9,
    preview_url: null,
  })
})

afterEach(() => {
  remove(scratch)
  rmSync(RESULT_PATH, { force: true })
  rmSync(MERGE_RESULT_PATH, { force: true })
})

const mergeState = (over: Partial<MergeState>): void =>
  writeMergeState({
    branch: BRANCH,
    state: 'merged',
    behind: 1,
    conflicts: [],
    denied: [],
    before,
    main,
    incoming: [],
    ...over,
  })

/** What the agent job does after its agent has finished: one commit, bundled. */
function bundleTurn(): void {
  commit(agent, 'turn')
  run(agent, 'branch', '-f', TURN_REF)
  run(agent, 'bundle', 'create', '-q', bundle, TURN_REF, `^${before}`)
}

const status = (): string => run(ROOT, 'status', '--porcelain')

describe('a turn after a clean merge from main', () => {
  beforeEach(() => mergeState({ state: 'merged' }))

  it('merges main here and leaves the work uncommitted on top', () => {
    run(agent, 'merge', '-q', '--no-ff', '--no-edit', main)
    write(agent, 'app/src/greeting.ts', 'export const greeting = "hello, world"\n')
    bundleTurn()

    const outcome = acceptTurn('build', bundle)

    expect(outcome.state).toBe('accepted')
    expect(run(ROOT, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(BRANCH)
    expect(run(ROOT, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ').slice(1)).toEqual([
      before,
      main,
    ])
    expect(readMeta().base_sha).toBe(run(ROOT, 'rev-parse', 'HEAD'))
    expect(status()).toBe('M app/src/greeting.ts')
    expect(readFileSync(join(ROOT, 'app/src/colour.ts'), 'utf8')).toContain('blue')
  })

  it('refuses a merge that slipped something else in', () => {
    run(agent, 'merge', '-q', '--no-ff', '--no-commit', main)
    write(agent, '.github/workflows/ci.yml', 'on: push\n')
    commit(agent, 'Merge main')
    bundleTurn()

    const outcome = acceptTurn('build', bundle)

    expect(outcome.state).toBe('rejected')
    const result = JSON.parse(readFileSync(RESULT_PATH, 'utf8'))
    expect(result.status).toBe('failed')
    expect(result.reason).toContain('.github/workflows/ci.yml')
    expect(status()).toBe('')
  })

  it('refuses a turn that is not built on main', () => {
    write(agent, 'app/src/greeting.ts', 'export const greeting = "hello, world"\n')
    bundleTurn()

    expect(acceptTurn('build', bundle)).toMatchObject({
      state: 'rejected',
      problems: ['The turn does not start from a merge of main into the commit it was given.'],
    })
  })
})

describe('a turn on a branch that already had main', () => {
  beforeEach(() => mergeState({ state: 'up-to-date', behind: 0 }))

  it('takes new files, deletions and binary files', () => {
    write(
      agent,
      'app/public/logo.png',
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x00, 0x01]),
    )
    rmSync(join(agent, 'app/src/colour.ts'))
    bundleTurn()

    expect(acceptTurn('build', bundle).state).toBe('accepted')

    expect(run(ROOT, 'rev-parse', 'HEAD')).toBe(before)
    expect(readFileSync(join(ROOT, 'app/public/logo.png'))).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x00, 0x01]),
    )
    expect(existsSync(join(ROOT, 'app/src/colour.ts'))).toBe(false)
  })

  it('refuses a turn of more than one commit', () => {
    write(agent, 'app/src/a.ts', 'a\n')
    commit(agent, 'one')
    write(agent, 'app/src/b.ts', 'b\n')
    bundleTurn()

    expect(acceptTurn('build', bundle).state).toBe('rejected')
  })

  it('refuses when the agent job left nothing', () => {
    expect(acceptTurn('build', join(scratch, 'missing.bundle'))).toMatchObject({
      state: 'rejected',
      problems: ['The agent job left no turn to take.'],
    })
  })

  it('keeps what the agent said it did on the failed result', () => {
    write(ROOT, '.agent/out/result.json', '')
    writeFileSync(
      RESULT_PATH,
      JSON.stringify({
        status: 'ready_for_review',
        summary: 'Said hello',
        acceptance_criteria: [],
      }),
    )
    expect(acceptTurn('build', join(scratch, 'missing.bundle')).state).toBe('rejected')
    expect(JSON.parse(readFileSync(RESULT_PATH, 'utf8')).status).toBe('failed')
  })
})

describe('a turn after a conflicted merge', () => {
  beforeEach(() => {
    // Both sides change the colour, so the merge conflicts in colour.ts.
    run(ROOT, 'checkout', '-q', BRANCH)
    write(ROOT, 'app/src/colour.ts', 'export const colour = "green"\n')
    before = commit(ROOT, 'DF-9: go green')
    remove(agent)
    run(scratch, 'clone', '-q', ROOT, agent)
    run(agent, 'checkout', '-q', BRANCH)
    writeMeta({
      key: 'DF-9',
      stage: 'build',
      turn: 2,
      branch: BRANCH,
      base_sha: before,
      pr: 9,
      preview_url: null,
    })
    mergeState({ state: 'conflicted', conflicts: ['app/src/colour.ts'] })
  })

  const resolve = (body: string, status: 'resolved' | 'unresolved' = 'resolved'): void => {
    try {
      run(agent, 'merge', '-q', '--no-ff', '--no-edit', main)
    } catch {
      // The conflict, as expected.
    }
    write(agent, 'app/src/colour.ts', body)
    run(agent, 'add', '-A')
    run(agent, 'commit', '-q', '--no-edit')
    writeFileSync(MERGE_RESULT_PATH, JSON.stringify({ status, summary: 'Took teal.' }))
  }

  it('takes the resolution and commits the merge as the factory', () => {
    resolve('export const colour = "teal"\n')
    write(agent, 'app/src/greeting.ts', 'export const greeting = "hello, teal"\n')
    bundleTurn()

    expect(acceptTurn('build', bundle).state).toBe('accepted')
    expect(run(ROOT, 'show', 'HEAD:app/src/colour.ts')).toBe('export const colour = "teal"')
    expect(run(ROOT, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ').slice(1)).toEqual([
      before,
      main,
    ])
    expect(status()).toBe('M app/src/greeting.ts')
  })

  it('puts a resolution with markers in it back on the card as a question', () => {
    resolve(
      '<<<<<<< HEAD\nexport const colour = "green"\n=======\nexport const colour = "blue"\n>>>>>>> main\n',
    )
    bundleTurn()

    expect(acceptTurn('build', bundle).state).toBe('merge-unresolved')
    expect(JSON.parse(readFileSync(RESULT_PATH, 'utf8')).status).toBe('question')
    expect(run(ROOT, 'rev-parse', 'HEAD')).toBe(before)
    expect(status()).toBe('')
  })

  it('asks the question the resolving agent could not answer, without needing a turn', () => {
    writeFileSync(
      MERGE_RESULT_PATH,
      JSON.stringify({ status: 'unresolved', summary: 'Green or blue?' }),
    )

    expect(acceptTurn('build', join(scratch, 'missing.bundle')).state).toBe('merge-unresolved')
    expect(JSON.parse(readFileSync(RESULT_PATH, 'utf8')).status).toBe('question')
  })
})

// Refresh's two jobs each merge main, and have to merge the same main: the one
// the fan-out was planned against, not whatever origin/main is by then.
describe('merging a given commit of main', () => {
  it('merges that commit and no later one', () => {
    run(ROOT, 'checkout', '-q', 'main')
    write(ROOT, 'app/src/later.ts', 'export const later = true\n')
    commit(ROOT, 'DF-8: later')
    run(ROOT, 'checkout', '-q', BRANCH)

    const state = attemptMerge(BRANCH, main)

    expect(state).toMatchObject({ state: 'merged', behind: 1, before, main })
    expect(run(ROOT, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ').slice(1)).toEqual([
      before,
      main,
    ])
    expect(existsSync(join(ROOT, 'app/src/later.ts'))).toBe(false)
  })
})
