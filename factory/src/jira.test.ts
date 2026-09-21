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
