import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { gather } from './gather.ts'
import { renderFactoryBlock, setRunner, type PrComment } from './github.ts'
import { TASK_PATH } from './meta.ts'
import { BASE, cfg, server, useFakes } from './jira.stub.ts'

/**
 * What `gather` puts in front of the agent beyond the card's comments: the
 * card's own fields, and — on a build turn — the pull request thread and the
 * preview the reviewer is looking at.
 *
 * Its own file because `gather` caches the site's custom-field index for the
 * life of the module, and these tests need an "Acceptance criteria" field that
 * `gather.test.ts` deliberately does not have.
 */

const BOT = 'bot-account-id'

useFakes()

function adf(value: string): unknown {
  return { type: 'doc', version: 1, content: [{ type: 'text', text: value }] }
}

/** A card with every field filled in, and no comments. */
function card(myself: () => Response = () => HttpResponse.json({ accountId: BOT })): void {
  server.use(
    http.get(`${BASE}/rest/api/3/myself`, myself),
    http.get(`${BASE}/rest/api/3/field`, () =>
      HttpResponse.json([{ id: 'customfield_10042', name: 'Acceptance criteria' }]),
    ),
    http.get(`${BASE}/rest/api/3/issue/DF-1`, () =>
      HttpResponse.json({
        key: 'DF-1',
        fields: {
          summary: 'Do the thing',
          description: adf('The thing, described.'),
          customfield_10042: adf('The thing is done.'),
          parent: { fields: { summary: 'Things in general' } },
        },
      }),
    ),
    http.get(`${BASE}/rest/api/3/issue/DF-1/comment`, () => HttpResponse.json({ comments: [] })),
  )
}

/** The PR thread, and a PR body that may or may not be readable. */
function pullRequest(comments: PrComment[], body: string | null): void {
  setRunner((args) => {
    const fields = args.at(-1)
    if (fields === 'comments') {
      const raw = comments.map((c) => ({ ...c, author: { login: c.author } }))
      return { status: 0, stdout: JSON.stringify({ comments: raw }), stderr: '' }
    }
    if (fields === 'body,headRefName' && body !== null) {
      return { status: 0, stdout: JSON.stringify({ body, headRefName: 'card/DF-1-x' }), stderr: '' }
    }
    return { status: 1, stdout: '', stderr: 'gh fell over' }
  })
}

const task = (): string => readFileSync(TASK_PATH, 'utf8')

beforeEach(() => {
  process.env['JIRA_BASE'] = cfg.base
  process.env['JIRA_USER'] = cfg.user
  process.env['JIRA_TOKEN'] = cfg.token
})
afterEach(() => {
  vi.restoreAllMocks()
  delete process.env['FACTORY_BOT_LOGIN']
})

describe('the card, as the agent reads it', () => {
  it('carries the epic, the description and the acceptance criteria', async () => {
    card()
    await gather({ key: 'DF-1', stage: 'design' })

    expect(task()).toContain('# DF-1: Do the thing\n\nStage: **design**\nEpic: Things in general')
    expect(task()).toContain('## Description\n\nThe thing, described.')
    expect(task()).toContain('## Acceptance criteria\n\nThe thing is done.')
    expect(task()).toContain('This is design turn 1.')
  })

  // Not knowing which comments are ours labels them all neutrally; it does
  // not stop the turn.
  it('still runs when the factory cannot tell who it is', async () => {
    card(() => HttpResponse.json({}, { status: 500 }))
    const meta = await gather({ key: 'DF-1', stage: 'design' })
    expect(meta.turn).toBe(1)
  })
})

describe('the pull request, on a build turn', () => {
  it('shows only what was said since the factory last spoke, and counts the turn', async () => {
    card()
    pullRequest(
      [
        { author: 'human', createdAt: '2026-09-01', body: 'go' },
        { author: 'factory[bot]', createdAt: '2026-09-02', body: '<!-- factory-turn 1 -->' },
        { author: 'human', createdAt: '2026-09-03', body: '  Make it bigger.  ' },
      ],
      renderFactoryBlock({ key: 'DF-1', stage: 'build', turn: 1, preview_url: 'https://pv' }),
    )

    const meta = await gather({ key: 'DF-1', stage: 'build', pr: 19 })

    expect(meta).toMatchObject({ turn: 2, pr: 19, preview_url: 'https://pv' })
    expect(task()).toContain('## Pull request #19 — conversation since your last turn')
    expect(task()).toContain('### human — 2026-09-03\n\nMake it bigger.\n')
    expect(task()).not.toContain('### human — 2026-09-01')
    expect(task()).toContain('This is turn 2.')
  })

  it('counts the bot’s own comments as turns even without the marker', async () => {
    process.env['FACTORY_BOT_LOGIN'] = 'factory[bot]'
    card()
    pullRequest([{ author: 'factory[bot]', createdAt: '2026-09-02', body: 'done' }], '')

    const meta = await gather({ key: 'DF-1', stage: 'build', pr: 19 })

    expect(meta.turn).toBe(2)
    expect(meta.preview_url).toBeNull()
    expect(task()).toContain('_(nothing new)_')
  })

  // A turn with no preview URL is worse than one with it, but it still runs.
  it('carries on without the preview when the PR body cannot be read', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    card()
    pullRequest([], null)

    const meta = await gather({ key: 'DF-1', stage: 'build', pr: 19 })

    expect(meta.preview_url).toBeNull()
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/^::warning::could not read the preview URL off PR #19: /),
    )
  })

  it('is the first turn, with no thread to read, when there is no pull request yet', async () => {
    card()
    const meta = await gather({ key: 'DF-1', stage: 'build' })

    expect(meta).toMatchObject({ turn: 1, pr: null, preview_url: null })
    expect(task()).not.toContain('## Pull request')
  })
})
