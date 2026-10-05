import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  changedFiles,
  currentBranch,
  git,
  gitSucceeds,
  headSha,
  identifyAsBot,
  remoteBranchExists,
  tryCommit,
} from './git.ts'
import { installPreCommit, sh, useScratchRepo } from './git.stub.ts'
import type * as env from './env.ts'

/**
 * The git wrapper, against a real repository.
 *
 * Every helper here runs git in REPO_ROOT, so REPO_ROOT is pointed at a fresh
 * clone of a fresh bare "origin" for each test. Faking git's output instead
 * would only test that the fake agrees with itself — what matters is what git
 * actually prints, rename arrows and all.
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

const repo = useScratchRepo('factory-git-', root)

afterEach(() => {
  vi.restoreAllMocks()
  delete process.env['FACTORY_BOT_LOGIN']
})

describe('running git', () => {
  it('returns what git printed', () => {
    expect(git(['log', '--format=%s'])).toBe('initial\n')
  })

  it('throws with git’s own complaint when a command fails', () => {
    expect(() => git(['rev-parse', 'no-such-ref'])).toThrow(/git rev-parse no-such-ref failed: /)
  })

  it('swallows the failure when asked to', () => {
    expect(() => git(['rev-parse', 'no-such-ref'], true)).not.toThrow()
  })

  it('reports success and failure as a boolean, logging the failure', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(gitSucceeds(['rev-parse', 'HEAD'])).toBe(true)
    expect(error).not.toHaveBeenCalled()

    expect(gitSucceeds(['rev-parse', 'no-such-ref'])).toBe(false)
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/^git rev-parse no-such-ref: /))
  })
})

describe('committing through the hooks', () => {
  it('returns nothing when the commit lands', () => {
    writeFileSync(join(root.path, 'README.md'), 'hello again\n')
    sh(root.path, 'add', '.')

    expect(tryCommit(['--quiet', '-m', 'second'])).toBeNull()
    expect(git(['log', '-1', '--format=%s']).trim()).toBe('second')
  })

  it('returns the end of what a refusing hook said, without its colours', () => {
    const lines = Array.from({ length: 40 }, (_, i) => `echo "line ${i + 1}"`).join('\n')
    installPreCommit(
      repo,
      `#!/bin/sh\n${lines}\nprintf '\\033[0;31mCoverage gate: failed\\033[0m\\n' >&2\nexit 1\n`,
    )
    writeFileSync(join(root.path, 'README.md'), 'hello again\n')
    sh(root.path, 'add', '.')

    const said = tryCommit(['-m', 'second']) as string
    const kept = said.split('\n')

    expect(kept).toHaveLength(30)
    expect(kept.at(-1)).toBe('Coverage gate: failed')
    expect(kept[0]).toBe('line 12')
    expect(git(['log', '--format=%s']).trim()).toBe('initial')
  })
})

describe('where the checkout is', () => {
  it('names the checked-out branch', () => {
    sh(root.path, 'checkout', '--quiet', '-b', 'card/DF-1-x')
    expect(currentBranch()).toBe('card/DF-1-x')
  })

  it('gives the full sha of HEAD', () => {
    expect(headSha()).toBe(sh(root.path, 'rev-parse', 'HEAD').trim())
    expect(headSha()).toMatch(/^[0-9a-f]{40}$/)
  })

  it('knows which branches the remote has', () => {
    expect(remoteBranchExists('main')).toBe(true)
    expect(remoteBranchExists('card/DF-404-nothing')).toBe(false)
  })
})

describe('the factory’s git identity', () => {
  it('defaults to factory[bot] and a noreply address', () => {
    expect(identifyAsBot()).toBe('factory[bot]')
    expect(sh(root.path, 'config', 'user.name').trim()).toBe('factory[bot]')
    expect(sh(root.path, 'config', 'user.email').trim()).toBe(
      'factory[bot]@users.noreply.github.com',
    )
  })

  // The App's login already ends in [bot]; the address must not say it twice.
  it('takes the App’s login from the environment without doubling the suffix', () => {
    process.env['FACTORY_BOT_LOGIN'] = 'dark-factory[bot]'
    expect(identifyAsBot()).toBe('dark-factory[bot]')
    expect(sh(root.path, 'config', 'user.email').trim()).toBe(
      'dark-factory[bot]@users.noreply.github.com',
    )
  })
})

describe('the files a turn changed', () => {
  it('lists committed, modified and untracked files once each, sorted', () => {
    sh(root.path, 'checkout', '--quiet', '-b', 'card/DF-1-x')
    writeFileSync(join(root.path, 'committed.txt'), 'a\n')
    sh(root.path, 'add', 'committed.txt')
    sh(root.path, 'commit', '--quiet', '-m', 'one')
    writeFileSync(join(root.path, 'committed.txt'), 'a, then b\n')
    writeFileSync(join(root.path, 'README.md'), 'changed\n')
    writeFileSync(join(root.path, 'untracked.txt'), 'c\n')

    expect(changedFiles()).toEqual(['README.md', 'committed.txt', 'untracked.txt'])
  })

  it('counts a rename as its destination only', () => {
    sh(root.path, 'mv', 'README.md', 'READ-ME.md')
    expect(changedFiles()).toEqual(['READ-ME.md'])
  })

  it('is empty for a branch with nothing on it', () => {
    expect(changedFiles()).toEqual([])
  })

  it('diffs against the base it is given', () => {
    const base = headSha()
    writeFileSync(join(root.path, 'later.txt'), 'd\n')
    sh(root.path, 'add', 'later.txt')
    sh(root.path, 'commit', '--quiet', '-m', 'later')
    sh(root.path, 'push', '--quiet', 'origin', 'main')

    expect(changedFiles()).toEqual([])
    expect(changedFiles(base)).toEqual(['later.txt'])
  })
})
