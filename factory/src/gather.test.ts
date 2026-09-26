import { readFileSync } from 'node:fs'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { setupServer } from 'msw/node'
import { http, HttpResponse } from 'msw'
import { gather } from './gather.ts'
import { TASK_PATH } from './meta.ts'

const BASE = 'https://example.atlassian.net'
const BOT = 'bot-account-id'

const server = setupServer()
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

beforeEach(() => {
  process.env['JIRA_BASE'] = BASE
  process.env['JIRA_USER'] = 'bot@example.com'
  process.env['JIRA_TOKEN'] = 'token'
})

interface Said {
  who: string
  id: string
  body: string
}

/** Stands up the four endpoints `gather` reads, with a given conversation. */
function card(said: Said[]): void {
  server.use(
    http.get(`${BASE}/rest/api/3/myself`, () => HttpResponse.json({ accountId: BOT })),
    http.get(`${BASE}/rest/api/3/field`, () => HttpResponse.json([])),
    http.get(`${BASE}/rest/api/3/issue/DF-1`, () =>
      HttpResponse.json({ key: 'DF-1', fields: { summary: 'Do the thing' } }),
    ),
    http.get(`${BASE}/rest/api/3/issue/DF-1/comment`, () =>
      HttpResponse.json({
        comments: said.map((s) => ({
          id: s.id,
          author: { displayName: s.who === BOT ? 'Factory' : 'A human', accountId: s.who },
          created: '2026-09-26T10:00:00.000+0000',
          body: { type: 'doc', version: 1, content: [{ type: 'text', text: s.body }] },
        })),
      }),
    ),
  )
}

/**
 * A design card's round number is counted from the factory's own comments on
 * it — nothing stores a counter, so a card cannot disagree with itself about
 * how many turns it has had. That makes the count load-bearing, and it made
 * adding a second factory comment per turn a silent way to break it.
 */
describe('which of the factory’s own comments count as a turn', () => {
  it('counts a finished turn and ignores the ping that started it', async () => {
    card([
      { who: 'human-1', id: '1', body: 'Please centre the content.' },
      { who: BOT, id: '2', body: 'design turn 1 started' },
      { who: BOT, id: '3', body: 'design turn paused — needs an answer' },
      { who: 'human-1', id: '4', body: 'Yes, centre it horizontally only.' },
    ])

    const meta = await gather({ key: 'DF-1', stage: 'design' })

    // One finished design turn, so this is the second — not the third.
    expect(meta.turn).toBe(2)
    expect(readFileSync(TASK_PATH, 'utf8')).toContain('This is design turn 2.')
  })

  /**
   * The ping is addressed to whoever is watching the card. Putting "nothing is
   * expected of you while this runs" in front of the agent that is running is
   * worse than noise — it reads as an instruction.
   */
  it('keeps the start ping out of the agent’s task file', async () => {
    card([
      { who: BOT, id: '1', body: 'build turn 2 started' },
      { who: BOT, id: '2', body: 'build turn finished — ready for review' },
      { who: 'human-1', id: '3', body: 'Looks good, one change please.' },
    ])

    await gather({ key: 'DF-1', stage: 'design' })
    const task = readFileSync(TASK_PATH, 'utf8')

    expect(task).not.toContain('turn 2 started')
    expect(task).toContain('ready for review')
    expect(task).toContain('one change please')
  })

  /** A human who happens to write about starting is not the factory. */
  it('only discounts the factory’s own pings', async () => {
    card([
      { who: 'human-1', id: '1', body: 'design turn 1 started' },
      { who: BOT, id: '2', body: 'design turn paused — needs an answer' },
    ])

    const meta = await gather({ key: 'DF-1', stage: 'design' })
    expect(meta.turn).toBe(2)
    expect(readFileSync(TASK_PATH, 'utf8')).toContain('design turn 1 started')
  })
})
