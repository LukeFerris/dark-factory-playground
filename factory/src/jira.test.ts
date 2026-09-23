import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { setupServer } from 'msw/node'
import { http, HttpResponse } from 'msw'
import * as jira from './jira.ts'

const BASE = 'https://example.atlassian.net'
const cfg: jira.JiraConfig = { base: BASE, user: 'me@example.com', token: 'token' }

const server = setupServer()
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

describe('transitionTo', () => {
  it('picks the transition whose DESTINATION status matches, not its own name', async () => {
    let posted: unknown = null
    server.use(
      http.get(`${BASE}/rest/api/3/issue/DF-1/transitions`, () =>
        HttpResponse.json({
          transitions: [
            { id: '11', name: 'Start progress', to: { name: 'Design in progress' } },
            { id: '21', name: 'Send for review', to: { name: 'Design review' } },
          ],
        }),
      ),
      http.post(`${BASE}/rest/api/3/issue/DF-1/transitions`, async ({ request }) => {
        posted = await request.json()
        return new HttpResponse(null, { status: 204 })
      }),
    )

    await jira.transitionTo(cfg, 'DF-1', 'Design review')
    expect(posted).toEqual({ transition: { id: '21' } })
  })

  it('matches the status name case-insensitively', async () => {
    let posted: unknown = null
    server.use(
      http.get(`${BASE}/rest/api/3/issue/DF-1/transitions`, () =>
        HttpResponse.json({ transitions: [{ id: '31', name: 'x', to: { name: 'Design Review' } }] }),
      ),
      http.post(`${BASE}/rest/api/3/issue/DF-1/transitions`, async ({ request }) => {
        posted = await request.json()
        return new HttpResponse(null, { status: 204 })
      }),
    )

    await jira.transitionTo(cfg, 'DF-1', 'design review')
    expect(posted).toEqual({ transition: { id: '31' } })
  })

  it('throws JiraTransitionError when the status is not reachable', async () => {
    server.use(
      http.get(`${BASE}/rest/api/3/issue/DF-1/transitions`, () =>
        HttpResponse.json({ transitions: [{ id: '11', name: 'x', to: { name: 'Done' } }] }),
      ),
    )

    await expect(jira.transitionTo(cfg, 'DF-1', 'Design review')).rejects.toBeInstanceOf(
      jira.JiraTransitionError,
    )
  })
})

describe('search', () => {
  it('follows nextPageToken until the last page', async () => {
    let call = 0
    server.use(
      http.post(`${BASE}/rest/api/3/search/jql`, () => {
        call += 1
        return call === 1
          ? HttpResponse.json({
              issues: [{ key: 'DF-1', fields: {} }],
              nextPageToken: 'page2',
              isLast: false,
            })
          : HttpResponse.json({ issues: [{ key: 'DF-2', fields: {} }], isLast: true })
      }),
    )

    const issues = await jira.search(cfg, 'project = DF')
    expect(issues.map((i) => i.key)).toEqual(['DF-1', 'DF-2'])
  })
})

describe('auth failures', () => {
  it('raises JiraAuthError on 401 so the CLI can exit 2', async () => {
    server.use(
      http.post(`${BASE}/rest/api/3/search/jql`, () => new HttpResponse(null, { status: 401 })),
    )
    await expect(jira.search(cfg, 'project = DF')).rejects.toBeInstanceOf(jira.JiraAuthError)
  })
})

/**
 * The design loop turns on one question: has a person replied since the agent
 * last spoke? Everything below pins the answer to account ids, because display
 * names are not identity — for most of this repository's life the factory
 * commented under the same name as the human it works for, and under that
 * arrangement no blocked card could ever come back.
 */
describe('isAnswered', () => {
  const US = '712020:factory'
  const THEM = '557058:human'
  const comment = (authorId: string, body: string): jira.JiraComment => ({
    author: authorId === US ? 'Brakkr [bot]' : 'Luke',
    authorId,
    created: '2026-09-23T10:00:00.000+0000',
    body,
  })

  it('is false when the newest comment is the factory\'s own question', () => {
    expect(jira.isAnswered(comment(US, 'Questions: …'), US)).toBe(false)
  })

  it('is true when someone has replied since', () => {
    expect(jira.isAnswered(comment(THEM, 'use the second option'), US)).toBe(true)
  })

  // A card nobody has commented on is not an answered card; it is a card with
  // no question. Getting this wrong would pull every blocked card straight back
  // into Designing on the first poll.
  it('is false when the card has no comments at all', () => {
    expect(jira.isAnswered(null, US)).toBe(false)
  })

  // Same person, same display name, different account — the pre-bot
  // arrangement. The check must look at the id, or the factory reads its own
  // question as the reply to itself.
  it('does not mistake a matching display name for the same account', () => {
    const impostor: jira.JiraComment = { ...comment(THEM, 'answered'), author: 'Brakkr [bot]' }
    expect(jira.isAnswered(impostor, US)).toBe(true)
  })
})

describe('getComments', () => {
  it('carries the author account id, not just the display name', async () => {
    server.use(
      http.get(`${BASE}/rest/api/3/issue/DF-3/comment`, () =>
        HttpResponse.json({
          comments: [
            {
              author: { displayName: 'Brakkr [bot]', accountId: '712020:factory' },
              created: '2026-09-23T10:00:00.000+0000',
              body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hi' }] }] },
            },
          ],
        }),
      ),
    )

    const [only] = await jira.getComments(cfg, 'DF-3')
    expect(only?.authorId).toBe('712020:factory')
    expect(only?.body).toContain('hi')
  })
})

describe('latestComment', () => {
  // A card with more comments than one page would otherwise hand back its
  // hundredth comment as its newest, and the answered check would compare
  // against a stale author with no sign anything was wrong.
  it('asks Jira for the newest comment rather than paging to the end', async () => {
    let query: URLSearchParams | null = null
    server.use(
      http.get(`${BASE}/rest/api/3/issue/DF-3/comment`, ({ request }) => {
        query = new URL(request.url).searchParams
        return HttpResponse.json({
          comments: [
            {
              author: { displayName: 'Luke', accountId: '557058:human' },
              created: '2026-09-23T11:00:00.000+0000',
              body: { type: 'doc', content: [] },
            },
          ],
        })
      }),
    )

    const newest = await jira.latestComment(cfg, 'DF-3')
    expect(newest?.authorId).toBe('557058:human')
    expect(query!.get('orderBy')).toBe('-created')
    expect(query!.get('maxResults')).toBe('1')
  })

  it('returns null for a card with no comments', async () => {
    server.use(
      http.get(`${BASE}/rest/api/3/issue/DF-3/comment`, () => HttpResponse.json({ comments: [] })),
    )
    expect(await jira.latestComment(cfg, 'DF-3')).toBeNull()
  })
})

describe('findAnswered', () => {
  const FACTORY = '712020:factory'

  function stub(cards: Record<string, string[]>): void {
    server.use(
      http.get(`${BASE}/rest/api/3/myself`, () => HttpResponse.json({ accountId: FACTORY })),
      http.post(`${BASE}/rest/api/3/search/jql`, () =>
        HttpResponse.json({
          issues: Object.keys(cards).map((key) => ({ key, fields: {} })),
          isLast: true,
        }),
      ),
      // Behaves like Jira: honours orderBy and maxResults. Without that the
      // stub would answer every query with the oldest comment first and hide
      // exactly the bug this endpoint choice exists to avoid.
      http.get(`${BASE}/rest/api/3/issue/:key/comment`, ({ params, request }) => {
        const query = new URL(request.url).searchParams
        const authors = [...(cards[params['key'] as string] ?? [])]
        if (query.get('orderBy') === '-created') authors.reverse()
        const limit = Number(query.get('maxResults') ?? authors.length)
        return HttpResponse.json({
          comments: authors.slice(0, limit).map((authorId) => ({
            author: { displayName: 'someone', accountId: authorId },
            created: '2026-09-23T10:00:00.000+0000',
            body: { type: 'doc', content: [] },
          })),
        })
      }),
    )
  }

  it('returns only the cards whose last comment is not the factory\'s', async () => {
    stub({
      'DF-3': [FACTORY, '557058:human'],
      'DF-4': [FACTORY],
      'DF-5': ['557058:human', FACTORY, '557058:human'],
    })

    expect(await jira.findAnswered(cfg, 'DF', 'Blocked on architect')).toEqual(['DF-3', 'DF-5'])
  })

  // The poller runs this every thirty seconds. An empty column must cost one
  // search and nothing else — no /myself, no per-card comment fetch.
  it('makes no further requests when the column is empty', async () => {
    let searches = 0
    server.use(
      http.post(`${BASE}/rest/api/3/search/jql`, () => {
        searches += 1
        return HttpResponse.json({ issues: [], isLast: true })
      }),
    )

    expect(await jira.findAnswered(cfg, 'DF', 'Blocked on architect')).toEqual([])
    expect(searches).toBe(1)
  })
})

describe('myAccountId', () => {
  // Silence is the dangerous failure here: an empty id compares equal to the
  // empty authorId of a malformed comment, which would read as "we wrote it".
  it('throws rather than returning an empty id', async () => {
    server.use(http.get(`${BASE}/rest/api/3/myself`, () => HttpResponse.json({})))
    await expect(jira.myAccountId(cfg)).rejects.toThrow(/accountId/)
  })
})

describe('adfToText', () => {
  it('flattens paragraphs and bullet lists to readable text', () => {
    const body = {
      type: 'doc',
      version: 1,
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'First line.' }] },
        {
          type: 'bulletList',
          content: [
            { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }] },
            { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'two' }] }] },
          ],
        },
      ],
    }
    expect(jira.adfToText(body)).toContain('First line.')
    expect(jira.adfToText(body)).toContain('- one')
    expect(jira.adfToText(body)).toContain('- two')
  })

  it('returns an empty string for a missing body rather than throwing', () => {
    expect(jira.adfToText(undefined)).toBe('')
    expect(jira.adfToText(null)).toBe('')
  })
})
