import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

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

import { acceptTurn } from './accept.ts'
import {
  BRANCH,
  agentCommit,
  card,
  cloneForTheAgent,
  commit,
  mergeState,
  packageTurn,
  parentsOf,
  run,
  status,
  useCardRepos,
  write,
} from './accept.stub.ts'
import { MERGE_RESULT_PATH, attemptMerge } from './merge.ts'
import { RESULT_PATH, writeFileEnsuringDir } from './meta.ts'

useCardRepos()

describe('a turn after a conflicted merge', () => {
  beforeEach(() => {
    // Both sides change the colour, so the merge conflicts in colour.ts.
    write(ROOT, 'app/src/colour.ts', 'export const colour = "green"\n')
    card.before = commit(ROOT, 'DF-9: go green')
    cloneForTheAgent()
    mergeState({ state: 'conflicted', conflicts: ['app/src/colour.ts'] })
  })

  const resolve = (body: string, status: 'resolved' | 'unresolved' = 'resolved'): void => {
    try {
      run(card.agent, 'merge', '-q', '--no-ff', '--no-edit', card.main)
    } catch {
      // The conflict, as expected.
    }
    write(card.agent, 'app/src/colour.ts', body)
    run(card.agent, 'add', '-A')
    run(card.agent, 'commit', '-q', '--no-edit')
    writeFileEnsuringDir(MERGE_RESULT_PATH, JSON.stringify({ status, summary: 'Took teal.' }))
  }

  it('takes the resolution and commits the merge as the factory', () => {
    resolve('export const colour = "teal"\n')
    write(card.agent, 'app/src/greeting.ts', 'export const greeting = "hello, teal"\n')
    agentCommit('DF-9: hello, teal')
    packageTurn()

    expect(acceptTurn('build', card.bundle).state).toBe('accepted')
    expect(run(ROOT, 'show', 'HEAD:app/src/colour.ts')).toBe('export const colour = "teal"')
    expect(parentsOf('HEAD~1')).toEqual([card.before, card.main])
    expect(run(ROOT, 'log', '-1', '--format=%s', 'HEAD')).toBe('DF-9: hello, teal')
    expect(status()).toBe('')
  })

  it('puts a resolution with markers in it back on the card as a question', () => {
    resolve(
      '<<<<<<< HEAD\nexport const colour = "green"\n=======\nexport const colour = "blue"\n>>>>>>> main\n',
    )
    packageTurn()

    expect(acceptTurn('build', card.bundle).state).toBe('merge-unresolved')
    expect(JSON.parse(readFileSync(RESULT_PATH, 'utf8')).status).toBe('question')
    expect(run(ROOT, 'rev-parse', 'HEAD')).toBe(card.before)
    expect(status()).toBe('')
  })

  it('asks the question the resolving agent could not answer, without needing a turn', () => {
    writeFileEnsuringDir(
      MERGE_RESULT_PATH,
      JSON.stringify({ status: 'unresolved', summary: 'Green or blue?' }),
    )

    expect(acceptTurn('build', join(card.scratch, 'missing.bundle')).state).toBe('merge-unresolved')
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

    const state = attemptMerge(BRANCH, card.main)

    expect(state).toMatchObject({
      state: 'merged',
      behind: 1,
      before: card.before,
      main: card.main,
    })
    expect(parentsOf('HEAD')).toEqual([card.before, card.main])
    expect(existsSync(join(ROOT, 'app/src/later.ts'))).toBe(false)
  })
})
