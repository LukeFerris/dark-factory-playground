import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { branchName, prepareBranch, slugify } from './branch.ts'
import { readMeta, writeMeta } from './meta.ts'
import { sh, useScratchRepo } from './git.stub.ts'
import type * as env from './env.ts'

/**
 * Naming the card's branch, and checking it out.
 *
 * `prepareBranch` is run against a real clone of a real bare "origin", with
 * REPO_ROOT pointed at the clone: whether it continues an existing branch or
 * cuts a new one is decided by what the remote actually has.
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

useScratchRepo('factory-branch-', root)

beforeEach(() => {
  writeMeta({
    key: 'DF-12',
    stage: 'design',
    turn: 1,
    branch: '',
    base_sha: '',
    pr: null,
    preview_url: null,
  })
})

describe('slugify', () => {
  it('lower-cases and hyphenates, with no hyphens left at either end', () => {
    expect(slugify('DF-12 Let the user type their name')).toBe('df-12-let-the-user-type-their-name')
    expect(slugify('  "Quoted!" — and dashed  ')).toBe('quoted-and-dashed')
  })

  // Cut at the limit, then tidied, so a word boundary at the cut does not
  // leave the branch name ending in a hyphen.
  it('truncates to the limit without a trailing hyphen', () => {
    expect(slugify('abc def ghi', 8)).toBe('abc-def')
    expect(slugify('abc def ghi', 8).length).toBeLessThanOrEqual(8)
  })

  it('leaves a slug that already fits alone', () => {
    expect(slugify('short', 5)).toBe('short')
  })
})

describe('branchName', () => {
  it('is one branch per card, under card/, keyed by the Jira key', () => {
    expect(branchName('DF-12', 'Let the user type their name')).toBe(
      'card/DF-12-let-the-user-type-their-name',
    )
  })
})

describe('prepareBranch', () => {
  it('cuts a fresh branch from origin/main on the first turn, and records it as the base', () => {
    const main = sh(root.path, 'rev-parse', 'origin/main').trim()

    const branch = prepareBranch('DF-12', 'Let the user type their name')

    expect(branch).toBe('card/DF-12-let-the-user-type-their-name')
    expect(sh(root.path, 'branch', '--show-current').trim()).toBe(branch)
    expect(sh(root.path, 'rev-parse', 'HEAD').trim()).toBe(main)
    expect(readMeta()).toMatchObject({ branch, base_sha: main })
  })

  // Every turn after the first continues the same branch, and with it the same
  // pull request — including whatever the design turn already committed.
  it('continues the remote branch when there is one', () => {
    const branch = 'card/DF-12-let-the-user-type-their-name'
    sh(root.path, 'checkout', '--quiet', '-b', branch)
    writeFileSync(join(root.path, 'design.md'), 'the design\n')
    sh(root.path, 'add', 'design.md')
    sh(root.path, 'commit', '--quiet', '-m', 'design')
    sh(root.path, 'push', '--quiet', 'origin', branch)
    const tip = sh(root.path, 'rev-parse', 'HEAD').trim()
    // Start from main with no local copy of the branch, as a fresh runner would.
    sh(root.path, 'checkout', '--quiet', 'main')
    sh(root.path, 'branch', '--quiet', '-D', branch)

    expect(prepareBranch('DF-12', 'Let the user type their name')).toBe(branch)
    expect(sh(root.path, 'rev-parse', 'HEAD').trim()).toBe(tip)
    expect(readMeta().base_sha).toBe(tip)
  })
})
