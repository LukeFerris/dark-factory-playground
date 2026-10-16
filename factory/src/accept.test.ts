import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  asFactory,
  card,
  commit,
  mergeState,
  packageTurn,
  parentsOf,
  run,
  status,
  useCardRepos,
  write,
} from './accept.stub.ts'
import { RESULT_PATH, readMeta } from './meta.ts'

useCardRepos()

const reason = (): string => JSON.parse(readFileSync(RESULT_PATH, 'utf8')).reason

describe('a turn after a clean merge from main', () => {
  beforeEach(() => mergeState({ state: 'merged' }))

  it("merges main here and puts the agent's commits on it as they were made", () => {
    run(card.agent, 'merge', '-q', '--no-ff', '--no-edit', card.main)
    write(card.agent, 'app/src/greeting.ts', 'export const greeting = "hello, world"\n')
    const first = agentCommit('DF-9: Say hello to the world')
    write(card.agent, 'app/src/wave.ts', 'export const wave = true\n')
    const second = agentCommit('DF-9: Wave as well\n\nBecause hello alone is curt.\n')
    packageTurn()

    expect(acceptTurn('build', card.bundle).state).toBe('accepted')
    expect(run(ROOT, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(BRANCH)
    const base = run(ROOT, 'rev-parse', 'HEAD~2')
    expect(parentsOf(base)).toEqual([card.before, card.main])
    expect(readMeta().base_sha).toBe(base)
    expect(status()).toBe('')
    // Made again on the factory's merge: the same in all but the parent.
    const shown = (ref: string): string =>
      run(ROOT, 'log', '-1', '--format=%T%n%an <%ae>%n%ad%n%cn <%ce>%n%cd%n%B', ref)
    expect(shown('HEAD~1')).toBe(shown(first))
    expect(shown('HEAD')).toBe(shown(second))
    expect(readFileSync(join(ROOT, 'app/src/colour.ts'), 'utf8')).toContain('blue')
  })

  it('takes a turn that committed nothing on top of the merge', () => {
    run(card.agent, 'merge', '-q', '--no-ff', '--no-edit', card.main)
    packageTurn()

    expect(acceptTurn('build', card.bundle).state).toBe('accepted')
    expect(run(ROOT, 'rev-parse', 'HEAD')).toBe(readMeta().base_sha)
    expect(status()).toBe('')
  })
})

describe('a turn after a clean merge that is not what the factory made', () => {
  beforeEach(() => mergeState({ state: 'merged' }))

  it('refuses a merge that slipped something else in', () => {
    run(card.agent, 'merge', '-q', '--no-ff', '--no-commit', card.main)
    write(card.agent, '.github/workflows/ci.yml', 'on: push\n')
    commit(card.agent, 'Merge main')
    packageTurn()

    expect(acceptTurn('build', card.bundle).state).toBe('rejected')
    expect(JSON.parse(readFileSync(RESULT_PATH, 'utf8')).status).toBe('failed')
    expect(reason()).toContain('.github/workflows/ci.yml')
    expect(status()).toBe('')
  })

  it('refuses a turn that is not built on main', () => {
    write(card.agent, 'app/src/greeting.ts', 'export const greeting = "hello, world"\n')
    agentCommit('DF-9: hello')
    packageTurn()

    expect(acceptTurn('build', card.bundle)).toMatchObject({
      state: 'rejected',
      problems: [
        'The turn does not start from a merge of main into the commit it was given, or is not a line of commits on it.',
      ],
    })
  })

  it('refuses a turn that merged something itself', () => {
    run(card.agent, 'merge', '-q', '--no-ff', '--no-edit', card.main)
    run(card.agent, 'checkout', '-q', '-b', 'aside')
    write(card.agent, 'app/src/aside.ts', 'export const aside = 1\n')
    agentCommit('DF-9: aside')
    run(card.agent, 'checkout', '-q', BRANCH)
    write(card.agent, 'app/src/greeting.ts', 'export const greeting = "hello, world"\n')
    agentCommit('DF-9: hello')
    run(card.agent, ...asFactory(), 'merge', '-q', '--no-ff', '--no-edit', 'aside')
    packageTurn()

    expect(acceptTurn('build', card.bundle).state).toBe('rejected')
  })
})

describe('a turn on a branch that already had main', () => {
  beforeEach(() => mergeState({ state: 'up-to-date', behind: 0 }))

  it('takes the very commits the agent made, with new files, deletions and binary files', () => {
    const logo = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x00, 0x01])
    write(card.agent, 'app/public/logo.png', logo)
    const first = agentCommit('DF-9: a logo')
    rmSync(join(card.agent, 'app/src/colour.ts'))
    const second = agentCommit('DF-9: no colour')
    packageTurn()

    expect(acceptTurn('build', card.bundle).state).toBe('accepted')

    expect(run(ROOT, 'rev-parse', 'HEAD')).toBe(second)
    expect(run(ROOT, 'rev-parse', 'HEAD~1')).toBe(first)
    expect(readMeta().base_sha).toBe(card.before)
    expect(readFileSync(join(ROOT, 'app/public/logo.png'))).toEqual(logo)
    expect(existsSync(join(ROOT, 'app/src/colour.ts'))).toBe(false)
    expect(status()).toBe('')
  })

  it('takes a turn that committed nothing, which leaves no bundle', () => {
    packageTurn()

    expect(existsSync(card.bundle)).toBe(false)
    expect(acceptTurn('build', card.bundle).state).toBe('accepted')
    expect(run(ROOT, 'rev-parse', 'HEAD')).toBe(card.before)
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
    expect(acceptTurn('build', join(card.scratch, 'missing.bundle')).state).toBe('rejected')
    expect(JSON.parse(readFileSync(RESULT_PATH, 'utf8')).status).toBe('failed')
  })
})

describe('a turn on a branch that already had main, refused', () => {
  beforeEach(() => mergeState({ state: 'up-to-date', behind: 0 }))

  it('refuses a turn that left work uncommitted', () => {
    write(card.agent, 'app/src/a.ts', 'a\n')
    agentCommit('DF-9: a')
    write(card.agent, 'app/src/b.ts', 'b\n')
    packageTurn()

    expect(acceptTurn('build', card.bundle)).toMatchObject({
      state: 'rejected',
      problems: [
        "The agent left work it had not committed: app/src/b.ts. A turn's work is what it commits.",
      ],
    })
    expect(run(ROOT, 'rev-parse', 'HEAD')).toBe(card.before)
  })

  it('refuses a commit made as somebody else', () => {
    write(card.agent, 'app/src/a.ts', 'a\n')
    agentCommit('DF-9: a', 'a-person')
    packageTurn()

    expect(acceptTurn('build', card.bundle).state).toBe('rejected')
    expect(reason()).toContain('The turn has commits not made as the factory')
  })

  it('refuses a turn that rewrote the history it was given', () => {
    write(card.agent, 'app/src/greeting.ts', 'export const greeting = "howdy"\n')
    run(card.agent, ...asFactory(), 'commit', '-q', '-a', '--amend', '-m', 'DF-9: design, again')
    packageTurn()

    expect(acceptTurn('build', card.bundle).state).toBe('rejected')
  })

  it('refuses when the agent job left nothing', () => {
    expect(acceptTurn('build', join(card.scratch, 'missing.bundle'))).toMatchObject({
      state: 'rejected',
      problems: ['The agent job left no turn to take.'],
    })
  })
})
