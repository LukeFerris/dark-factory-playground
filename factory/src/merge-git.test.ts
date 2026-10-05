import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MERGE_STATE_PATH,
  MERGE_TASK_PATH,
  abortMerge,
  attemptMerge,
  finishMerge,
  readMergeState,
  recordMerge,
  type MergeResult,
} from './merge.ts'
import { readMeta, writeMeta } from './meta.ts'
import { commitIn, installPreCommit, sh as gitIn, useScratchRepo, writeIn } from './git.stub.ts'
import type * as env from './env.ts'

/**
 * The half of the merge that drives git, against a real repository.
 *
 * REPO_ROOT is pointed at a clone of a bare "origin", and main is moved on
 * underneath a card branch in each of the ways that matter: not at all, cleanly,
 * into a file an agent may resolve, and into the factory's own machinery.
 */

const root = vi.hoisted(() => ({ path: '' }))
vi.mock('./env.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof env>()
  return {
    ...actual,
    get REPO_ROOT() {
      return root.path
    },
  }
})

const BRANCH = 'card/DF-5-add-a-greeting'

/** Git, in the clone. */
const sh = (...args: string[]): string => gitIn(root.path, ...args)
const write = (path: string, body: string): void => writeIn(root.path, path, body)
const commit = (path: string, body: string, message: string): void =>
  commitIn(root.path, { path, body, message })

/** Moves origin/main on by one commit, leaving the card branch checked out. */
function mainCommits(path: string, body: string, message: string): void {
  sh('checkout', '--quiet', 'main')
  commit(path, body, message)
  sh('push', '--quiet', 'origin', 'main')
  sh('checkout', '--quiet', BRANCH)
}

/** A bare origin with main, and a clone that each test puts on a card branch cut from it. */
const repo = useScratchRepo('factory-merge-', root, [
  { path: 'app/src/index.css', body: 'body { color: black; }\n', message: 'initial' },
  { path: 'factory/src/rules.ts', body: 'export const rules = 1\n', message: 'machinery' },
])

beforeEach(() => {
  sh('checkout', '--quiet', '-b', BRANCH)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  rmSync(MERGE_STATE_PATH, { force: true })
  rmSync(MERGE_TASK_PATH, { force: true })
  vi.restoreAllMocks()
})

/** Both sides rewrite the same line of the stylesheet. */
function conflictInStylesheet(): void {
  commit('app/src/index.css', 'body { color: pink; }\n', 'DF-5: pink')
  mainCommits('app/src/index.css', 'body { color: blue; }\n', 'DF-7: paint it blue')
}

const resolved: MergeResult = {
  status: 'resolved',
  summary: 'Took main’s blue.',
  notes: [],
  questions: [],
}

describe('attempting the merge', () => {
  it('does nothing to a branch that already has main', () => {
    const before = sh('rev-parse', 'HEAD').trim()
    const state = attemptMerge(BRANCH)

    expect(state).toMatchObject({ branch: BRANCH, state: 'up-to-date', behind: 0, before })
    expect(state.main).toBe(before)
    expect(sh('rev-parse', 'HEAD').trim()).toBe(before)
  })

  it('merges and commits when main changed something else', () => {
    commit('app/src/App.tsx', 'export {}\n', 'DF-5: greeting')
    mainCommits('docs/notes.md', 'notes\n', 'DF-7: notes')

    const state = attemptMerge(BRANCH)

    expect(state.state).toBe('merged')
    expect(state.behind).toBe(1)
    expect(state.incoming).toHaveLength(1)
    expect(state.incoming[0]).toContain('DF-7: notes')
    // A merge commit, with the branch and main as its parents.
    expect(sh('rev-list', '--parents', '-n', '1', 'HEAD').trim().split(' ')).toHaveLength(3)
  })

  it('leaves a conflict in the index for an agent to resolve', () => {
    conflictInStylesheet()

    const state = attemptMerge(BRANCH)

    expect(state.state).toBe('conflicted')
    expect(state.conflicts).toEqual(['app/src/index.css'])
    expect(state.denied).toEqual([])
    expect(readFileSync(join(root.path, 'app/src/index.css'), 'utf8')).toContain('<<<<<<<')
  })

  it('refuses, and backs out, when the conflict is in the factory itself', () => {
    commit('factory/src/rules.ts', 'export const rules = 2\n', 'DF-5: loosen the rules')
    mainCommits('factory/src/rules.ts', 'export const rules = 3\n', 'tighten the rules')

    const state = attemptMerge(BRANCH)

    expect(state.state).toBe('refused')
    expect(state.denied).toEqual(['factory/src/rules.ts'])
    expect(existsSync(join(root.path, '.git/MERGE_HEAD'))).toBe(false)
  })

  // A merge git will not even start leaves nothing for an agent to do.
  it('throws when git fails without leaving a conflict', () => {
    mainCommits('app/src/index.css', 'body { color: blue; }\n', 'DF-7: paint it blue')
    write('app/src/index.css', 'uncommitted\n')

    expect(() => attemptMerge(BRANCH)).toThrow(
      `git merge origin/main into ${BRANCH} failed without leaving a conflict to resolve.`,
    )
  })

  it('can be put back exactly as it was found', () => {
    conflictInStylesheet()
    const state = attemptMerge(BRANCH)

    abortMerge()

    expect(sh('rev-parse', 'HEAD').trim()).toBe(state.before)
    expect(sh('status', '--porcelain').trim()).toBe('')
  })
})

describe('finishing a merge the agent resolved', () => {
  it('commits it when the agent cleared the markers and touched nothing else', () => {
    conflictInStylesheet()
    const state = attemptMerge(BRANCH)
    write('app/src/index.css', 'body { color: blue; }\n')

    const outcome = finishMerge(state, resolved)

    expect(outcome).toEqual({ ok: true, problems: [], sha: sh('rev-parse', 'HEAD').trim() })
    expect(sh('rev-list', '--parents', '-n', '1', 'HEAD').trim().split(' ')).toHaveLength(3)
  })

  it('turns a commit the pre-commit gates refused into a problem, leaving the merge to abort', () => {
    conflictInStylesheet()
    const state = attemptMerge(BRANCH)
    write('app/src/index.css', 'body { color: blue; }\n')
    installPreCommit(repo, '#!/bin/sh\necho "Coverage gate: failed" >&2\nexit 1\n')

    const outcome = finishMerge(state, resolved)

    expect(outcome).toEqual({
      ok: false,
      sha: null,
      problems: ['The pre-commit gates refused the merge commit:\nCoverage gate: failed'],
    })
    abortMerge()
    expect(sh('log', '-1', '--format=%s').trim()).toBe('DF-5: pink')
  })

  it('refuses a file that still has markers in it', () => {
    conflictInStylesheet()
    const state = attemptMerge(BRANCH)

    const outcome = finishMerge(state, resolved)

    expect(outcome.ok).toBe(false)
    expect(outcome.sha).toBeNull()
    expect(outcome.problems).toEqual(['app/src/index.css still has conflict markers in it.'])
  })

  it('refuses an edit outside the conflict', () => {
    conflictInStylesheet()
    const state = attemptMerge(BRANCH)
    write('app/src/index.css', 'body { color: blue; }\n')
    write('factory/src/rules.ts', 'export const rules = 99\n')

    const outcome = finishMerge(state, resolved)

    expect(outcome.ok).toBe(false)
    expect(outcome.problems).toEqual([
      'factory/src/rules.ts was changed while resolving the merge, and it was not one of the conflicts.',
    ])
  })

  // One side deleted the file; deleting it is a resolution, not a stray edit.
  it('accepts a deleted file as the resolution', () => {
    sh('rm', '--quiet', 'app/src/index.css')
    sh('commit', '--quiet', '-m', 'DF-5: drop the stylesheet')
    mainCommits('app/src/index.css', 'body { color: blue; }\n', 'DF-7: paint it blue')
    const state = attemptMerge(BRANCH)
    expect(state.conflicts).toEqual(['app/src/index.css'])
    rmSync(join(root.path, 'app/src/index.css'))

    const outcome = finishMerge(state, resolved)

    expect(outcome.ok).toBe(true)
    expect(existsSync(join(root.path, 'app/src/index.css'))).toBe(false)
  })
})

describe('recording what the attempt found', () => {
  const meta = (): void =>
    writeMeta({
      key: 'DF-5',
      stage: 'build',
      turn: 2,
      branch: BRANCH,
      base_sha: 'stale',
      pr: 19,
      preview_url: null,
    })

  it('moves the turn’s base on to the merge commit when it merged', () => {
    meta()
    mainCommits('docs/notes.md', 'notes\n', 'DF-7: notes')
    const state = recordMerge(attemptMerge(BRANCH), 'DF-5', 'Add a greeting')

    expect(readMeta().base_sha).toBe(sh('rev-parse', 'HEAD').trim())
    expect(readMergeState()).toEqual(state)
    expect(console.log).toHaveBeenCalledWith(`merge: ${BRANCH} took 1 commit(s) from main`)
  })

  it('writes the brief, and leaves the base alone, when it conflicted', () => {
    meta()
    conflictInStylesheet()
    recordMerge(attemptMerge(BRANCH), 'DF-5', 'Add a greeting')

    expect(readMeta().base_sha).toBe('stale')
    expect(readFileSync(MERGE_TASK_PATH, 'utf8')).toContain('`app/src/index.css`')
    expect(console.log).toHaveBeenCalledWith(
      `merge: ${BRANCH} conflicts in app/src/index.css — handing it to an agent`,
    )
  })

  it('cannot be read back before it was written', () => {
    expect(() => readMergeState()).toThrow('Run `factory merge-begin` first.')
  })
})
