import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ghRunner, renderFactoryBlock, setRunner, type FactoryBlock } from './github.ts'
import { cardKeyFromBranch, kickoff, kickoffComment, waitUntilAwake } from './preview.ts'

/**
 * The kickoff comment wraps preview links in the launcher when one is
 * configured, so a developer who happens to have AZURE_PREVIEW_LAUNCHER
 * exported would otherwise see these fail for no reason of their own.
 */
const withoutLauncher = (): void => {
  const previous = process.env['AZURE_PREVIEW_LAUNCHER']
  beforeEach(() => {
    delete process.env['AZURE_PREVIEW_LAUNCHER']
  })
  afterEach(() => {
    if (previous !== undefined) process.env['AZURE_PREVIEW_LAUNCHER'] = previous
  })
}

describe('cardKeyFromBranch', () => {
  it('reads the key out of a card branch', () => {
    expect(cardKeyFromBranch('card/DF-12-let-the-user-type-their-name')).toBe('DF-12')
  })

  /** The key contains a hyphen itself, so a lazy split on `-` loses the number. */
  it('keeps the number that is part of the key', () => {
    expect(cardKeyFromBranch('card/DF-4-greet-the-visitor')).toBe('DF-4')
  })

  it('returns null for a branch the factory did not cut', () => {
    expect(cardKeyFromBranch('fix/the-thing')).toBeNull()
    expect(cardKeyFromBranch('main')).toBeNull()
    expect(cardKeyFromBranch('card/DF-4')).toBeNull()
  })
})

describe('the kickoff comment', () => {
  withoutLauncher()

  it('names the card and says every turn needs a comment', () => {
    const body = kickoffComment('DF-4', null)
    expect(body).toContain('### DF-4 — build started')
    expect(body).toContain('auto-continue is off')
  })

  it('links the preview when there is one, and says nothing when there is not', () => {
    expect(kickoffComment('DF-4', 'https://df-preview-pr-16.example/')).toContain(
      '**Preview:** https://df-preview-pr-16.example/',
    )
    expect(kickoffComment('DF-4', null)).not.toContain('Preview:')
  })

  /**
   * The link a person clicks goes through the loading page; the raw URL stays
   * in the factory block for the agent. A reviewer who is told "preview" and
   * given a page that spins for twenty seconds deserves the sentence saying
   * why, so the explanation appears only when the wrapping actually happened.
   */
  describe('when a launcher is configured', () => {
    const launcher = 'https://stfactory1234.z33.web.core.windows.net'
    const preview = 'https://df-preview-pr-16.uksouth.azurecontainerapps.io'
    const previous = process.env['AZURE_PREVIEW_LAUNCHER']

    beforeEach(() => {
      process.env['AZURE_PREVIEW_LAUNCHER'] = launcher
    })
    afterEach(() => {
      if (previous === undefined) delete process.env['AZURE_PREVIEW_LAUNCHER']
      else process.env['AZURE_PREVIEW_LAUNCHER'] = previous
    })

    it('links the launcher rather than the app, and explains the wait', () => {
      const body = kickoffComment('DF-4', preview)
      expect(body).toContain(`**Preview:** ${launcher}/?u=${encodeURIComponent(preview)}`)
      expect(body).toContain('Previews sleep when nobody is looking at them')
    })

    it('says nothing about loading pages when there is no preview at all', () => {
      const body = kickoffComment('DF-4', null)
      expect(body).not.toContain('Preview')
      expect(body).not.toContain('loading page')
    })
  })
})

/**
 * Warming does two things, and the second is the one that was missing: it
 * moves the 22-second cold start into a job nobody is watching, and it is the
 * first check in this pipeline that the URL it is about to publish serves
 * anything at all.
 */
describe('waitUntilAwake', () => {
  const url = 'https://df-preview-pr-16.uksouth.azurecontainerapps.io'
  const fast = { gapMs: 1, budgetMs: 200, knockTimeoutMs: 50 }

  it('returns as soon as the app answers', async () => {
    let knocks = 0
    const elapsed = await waitUntilAwake(url, {
      ...fast,
      fetchImpl: async () => {
        knocks++
        return new Response('hello', { status: 200 })
      },
    })
    expect(knocks).toBe(1)
    expect(elapsed).toBeGreaterThanOrEqual(0)
  })

  /**
   * A container that answers 404 is a container that is up. Whether the app is
   * right is the agent's problem, and it cannot start on that until the site
   * is serving.
   */
  it('treats any non-5xx answer as awake', async () => {
    await expect(
      waitUntilAwake(url, { ...fast, fetchImpl: async () => new Response('', { status: 404 }) }),
    ).resolves.toBeGreaterThanOrEqual(0)
  })

  it('keeps knocking through connection failures', async () => {
    let knocks = 0
    await waitUntilAwake(url, {
      ...fast,
      fetchImpl: async () => {
        knocks++
        if (knocks < 3) throw new Error('getaddrinfo ENOTFOUND')
        return new Response('', { status: 200 })
      },
    })
    expect(knocks).toBe(3)
  })

  it('gives up on a budget, and says the build was not the problem', async () => {
    await expect(
      waitUntilAwake(url, {
        ...fast,
        fetchImpl: async () => new Response('', { status: 502 }),
      }),
    ).rejects.toThrow(/answered HTTP 502[\s\S]*container failing to serve/)
  })
})

/**
 * The regression these guard is that `kickoff` used to open with `readMeta()`.
 * meta.json is written by `factory gather` on the agent's runner, where
 * `.agent/` is gitignored, and `kickoff` runs on a different runner with a
 * fresh checkout. It was never there, so the comment was never posted.
 * Everything now comes off the pull request — which is also what keeps
 * `build-setup.yml`'s manual retry working, since that has no turn at all.
 */
describe('kickoff', () => {
  withoutLauncher()
  const previous = process.env['GITHUB_REPOSITORY']

  const block: FactoryBlock = {
    key: 'DF-4',
    stage: 'build',
    turn: 1,
    preview_url: 'https://df-preview-pr-16.example/',
  }

  beforeEach(() => {
    process.env['GITHUB_REPOSITORY'] = 'acme/dark-factory-playground'
  })

  afterEach(() => {
    if (previous === undefined) delete process.env['GITHUB_REPOSITORY']
    else process.env['GITHUB_REPOSITORY'] = previous
    setRunner(ghRunner)
  })

  /** Answers `pr view` with one PR and records everything else. */
  function stub(pr: { body: string; headRefName: string }) {
    const calls: Array<{ args: string[]; input?: string }> = []
    setRunner((args, input) => {
      calls.push(input === undefined ? { args } : { args, input })
      if (args[0] === 'pr' && args[1] === 'view') {
        return { status: 0, stdout: JSON.stringify(pr), stderr: '' }
      }
      return { status: 0, stdout: '', stderr: '' }
    })
    return calls
  }

  it('takes the key and the preview URL from the factory block', () => {
    const calls = stub({
      body: `Prose.\n\n${renderFactoryBlock(block)}`,
      headRefName: 'card/DF-4-greet-the-visitor',
    })

    kickoff(16)

    const comment = calls.find((c) => c.args[1] === 'comment')
    expect(comment?.args).toContain('16')
    expect(comment?.input).toContain('### DF-4 — build started')
    expect(comment?.input).toContain('**Preview:** https://df-preview-pr-16.example/')
  })

  it('falls back to the branch name when the body has no block', () => {
    const calls = stub({ body: 'Someone rewrote this.', headRefName: 'card/DF-4-greet-the-visitor' })

    kickoff(16)

    const comment = calls.find((c) => c.args[1] === 'comment')
    expect(comment?.input).toContain('### DF-4 — build started')
    expect(comment?.input).not.toContain('Preview:')
  })

  it('comments on the PR it was given, not one it looked up by branch', () => {
    const calls = stub({
      body: renderFactoryBlock(block),
      headRefName: 'card/DF-4-greet-the-visitor',
    })

    kickoff(16)

    expect(calls.filter((c) => c.args[0] === 'pr' && c.args[1] === 'list')).toHaveLength(0)
    expect(calls.find((c) => c.args[1] === 'comment')?.args[2]).toBe('16')
  })

  it('refuses rather than guessing when the PR belongs to no card', () => {
    stub({ body: 'Nothing factory-shaped here.', headRefName: 'fix/the-thing' })
    expect(() => kickoff(16)).toThrow(/is not a card/)
  })

  it('prints the comment and posts nothing on a dry run', () => {
    const calls = stub({
      body: renderFactoryBlock(block),
      headRefName: 'card/DF-4-greet-the-visitor',
    })

    kickoff(16, true)

    expect(calls.some((c) => c.args[1] === 'comment')).toBe(false)
  })
})
