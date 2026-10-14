import { rmSync, writeFileSync } from 'node:fs'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { setupServer } from 'msw/node'
import { http, HttpResponse } from 'msw'
import * as jira from './jira.ts'
import { STATUS_NAMES, configPath, resetStatusIds } from './statuses.ts'

const BASE = 'https://example.atlassian.net'
const cfg: jira.JiraConfig = { base: BASE, user: 'me@example.com', token: 'token' }

const server = setupServer()
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

describe('transitionTo with pinned status ids', () => {
  // A team-managed column renamed on the board renames its status. With the
  // ids pinned, the move still finds it, and a status that has taken the old
  // name does not catch the card.
  it('goes by status id when enki.json pins one', async () => {
    const ids = Object.fromEntries(STATUS_NAMES.map((name, i) => [name, String(10050 + i)]))
    writeFileSync(configPath(), JSON.stringify({ jira: { statuses: ids } }))
    resetStatusIds()
    let posted: unknown = null
    server.use(
      http.get(`${BASE}/rest/api/3/issue/DF-1/transitions`, () =>
        HttpResponse.json({
          transitions: [
            { id: '41', name: 'x', to: { id: '20000', name: 'Design review' } },
            { id: '51', name: 'y', to: { id: '10053', name: 'Ready to look at' } },
          ],
        }),
      ),
      http.post(`${BASE}/rest/api/3/issue/DF-1/transitions`, async ({ request }) => {
        posted = await request.json()
        return new HttpResponse(null, { status: 204 })
      }),
    )

    try {
      await jira.transitionTo(cfg, 'DF-1', 'Design review')
    } finally {
      rmSync(configPath(), { force: true })
      resetStatusIds()
    }
    expect(posted).toEqual({ transition: { id: '51' } })
  })
})
