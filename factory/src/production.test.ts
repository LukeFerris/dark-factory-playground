import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ghRunner, setRunner } from './github.ts'
import { adfToText } from './jira.ts'
import {
  SHIPPED_STATUS,
  externalProduction,
  productionSupported,
  shippedComment,
  waitForExternalProduction,
} from './production.ts'
import type { WorkflowRun } from './runs.ts'

describe('where production can exist', () => {
  const previous = process.env['FACTORY_PREVIEW_BACKEND']

  afterEach(() => {
    if (previous === undefined) delete process.env['FACTORY_PREVIEW_BACKEND']
    else process.env['FACTORY_PREVIEW_BACKEND'] = previous
  })

  /**
   * The ghcr stub pushes an image nobody serves. Shipping on the strength of
   * that would move a card to Done on the basis of a package page, so the
   * workflow skips instead and the card stays in review.
   */
  it('is azure only when the repository does not deploy it, because the stub serves nothing', () => {
    process.env['FACTORY_PREVIEW_BACKEND'] = 'azure'
    expect(productionSupported()).toBe(true)
    process.env['FACTORY_PREVIEW_BACKEND'] = 'ghcr'
    expect(productionSupported()).toBe(false)
    delete process.env['FACTORY_PREVIEW_BACKEND']
    expect(productionSupported()).toBe(false)
  })
})

describe('the shipped comment', () => {
  const url = 'https://df-production.kindsky.uksouth.azurecontainerapps.io'
  const comment = shippedComment('DF-6', url, 'https://github.com/o/r/pull/20', 'https://run')
  const flat = adfToText(comment)

  it('says the card was closed by the factory and why it was allowed to', () => {
    expect(flat).toContain('DF-6')
    expect(flat).toContain('production is serving it')
    expect(flat).toContain(SHIPPED_STATUS)
  })

  /**
   * The live URL is the point of the comment — it is the only place a person
   * reading the card learns where the thing they asked for ended up.
   */
  it('carries the production URL, unwrapped', () => {
    expect(flat).toContain(url)
    // No launcher. Production never sleeps, so there is no cold start to hide
    // behind a loading page, and a redirect would only be in the way.
    expect(flat).not.toContain('?u=')
  })

  it('links the pull request and the run that shipped it', () => {
    expect(flat).toContain('Pull request')
    expect(flat).toContain('Actions run')
  })

  it('omits the links it was not given rather than printing empty ones', () => {
    const bare = adfToText(shippedComment('DF-6', url, null, null))
    expect(bare).not.toContain('Pull request')
    expect(bare).not.toContain('Actions run')
    expect(bare).toContain(url)
  })
})

const keys = [
  'FACTORY_PRODUCTION_URL',
  'FACTORY_PRODUCTION_WORKFLOWS',
  'FACTORY_PREVIEW_BACKEND',
  'GITHUB_REPOSITORY',
]
const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]))
const SHA = 'b'.repeat(40)
const awake = (async () => new Response('ok')) as typeof fetch
const run = (name: string, over: Partial<WorkflowRun> = {}): WorkflowRun => ({
  id: 1,
  name,
  status: 'completed',
  conclusion: 'success',
  run_attempt: 1,
  html_url: `https://github.com/o/r/actions/runs/${name}`,
  ...over,
})

// For both describes below: the environment each test sets is put back.
beforeEach(() => {
  process.env['GITHUB_REPOSITORY'] = 'o/r'
})
afterEach(() => {
  setRunner(ghRunner)
  for (const k of keys) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

/** Answers each workflow's run list from `runs`, by file name. */
function workflows(runs: Record<string, WorkflowRun[]>): string[] {
  const asked: string[] = []
  setRunner((args) => {
    const file = /workflows\/([^/]+)\/runs/.exec(args[1] ?? '')?.[1] ?? ''
    asked.push(file)
    expect(args[1]).toContain(`head_sha=${SHA}&event=push`)
    return { status: 0, stdout: JSON.stringify(runs[file] ?? []), stderr: '' }
  })
  return asked
}

describe('a production the repository deploys itself', () => {
  it('is a production, whatever the preview backend', () => {
    process.env['FACTORY_PREVIEW_BACKEND'] = 'swa'
    process.env['FACTORY_PRODUCTION_URL'] = 'https://workbench.example.com/'
    process.env['FACTORY_PRODUCTION_WORKFLOWS'] = 'swa.yml, migrate.yml?'
    expect(productionSupported()).toBe(true)
    expect(externalProduction()).toEqual({
      url: 'https://workbench.example.com',
      workflows: [
        { file: 'swa.yml', ifRan: false },
        { file: 'migrate.yml', ifRan: true },
      ],
    })
    delete process.env['FACTORY_PRODUCTION_URL']
    expect(productionSupported()).toBe(false)
  })

  // Otherwise the only workflow could be one that did not run, and nothing at
  // all would stand between a merge and Done.
  it('refuses a list where every workflow is optional', () => {
    process.env['FACTORY_PRODUCTION_URL'] = 'https://workbench.example.com'
    process.env['FACTORY_PRODUCTION_WORKFLOWS'] = 'migrate.yml?'
    expect(() => externalProduction()).toThrow(/at least one workflow that always deploys/)
  })

  it('refuses a URL that is not https', () => {
    process.env['FACTORY_PRODUCTION_URL'] = 'http://workbench.example.com'
    process.env['FACTORY_PRODUCTION_WORKFLOWS'] = 'swa.yml'
    expect(() => externalProduction()).toThrow(/https/)
  })
})

describe('waiting for a production the repository deploys', () => {
  it('waits for the deployments on the merge commit, then for the site', async () => {
    const asked = workflows({ 'swa.yml': [run('swa')], 'migrate.yml': [run('migrate')] })
    const url = await waitForExternalProduction(
      SHA,
      {
        url: 'https://workbench.example.com',
        workflows: [
          { file: 'migrate.yml', ifRan: true },
          { file: 'swa.yml', ifRan: false },
        ],
      },
      { gapMs: 0, runBudgetMs: 50, fetchImpl: awake },
    )
    expect(url).toBe('https://workbench.example.com')
    // The one that must run is waited for first, so the optional one has had
    // every chance to start before it is judged not to have.
    expect(asked[0]).toBe('swa.yml')
    expect(asked).toContain('migrate.yml')
  })

  it('skips an optional workflow that did not run', async () => {
    const asked = workflows({ 'swa.yml': [run('swa')] })
    await waitForExternalProduction(
      SHA,
      {
        url: 'https://workbench.example.com',
        workflows: [
          { file: 'swa.yml', ifRan: false },
          { file: 'migrate.yml', ifRan: true },
        ],
      },
      { gapMs: 0, runBudgetMs: 50, fetchImpl: awake },
    )
    expect(asked.filter((f) => f === 'migrate.yml')).toHaveLength(1)
  })
})

describe('not shipping a production the repository deploys', () => {
  it('does not ship when a deployment failed', async () => {
    workflows({
      'swa.yml': [run('swa')],
      'migrate.yml': [run('migrate', { conclusion: 'failure' })],
    })
    await expect(
      waitForExternalProduction(
        SHA,
        {
          url: 'https://workbench.example.com',
          workflows: [
            { file: 'swa.yml', ifRan: false },
            { file: 'migrate.yml', ifRan: true },
          ],
        },
        { gapMs: 0, runBudgetMs: 50, fetchImpl: awake },
      ),
    ).rejects.toThrow(/migrate finished "failure"/)
  })

  it('does not ship when the required deployment never ran', async () => {
    workflows({})
    await expect(
      waitForExternalProduction(
        SHA,
        { url: 'https://workbench.example.com', workflows: [{ file: 'swa.yml', ifRan: false }] },
        { gapMs: 0, runBudgetMs: 50, fetchImpl: awake },
      ),
    ).rejects.toThrow(/No run of swa.yml appeared/)
  })
})
