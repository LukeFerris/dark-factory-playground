import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { setupServer } from 'msw/node'
import { http, HttpResponse } from 'msw'
import type * as jira from './jira.ts'
import type { Meta } from './meta.ts'
import {
  ASSIGNEE_PROPERTY,
  LINK_IDS,
  claimCard,
  dropLink,
  releaseCard,
  syncLinks,
  turnLinks,
} from './progress.ts'

const BASE = 'https://example.atlassian.net'
const cfg: jira.JiraConfig = { base: BASE, user: 'bot@example.com', token: 'token' }
const FACTORY = '712020:factory'
const HUMAN = '557058:human'

const server = setupServer()
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

function meta(patch: Partial<Meta> = {}): Meta {
  return {
    key: 'DF-7',
    stage: 'build',
    turn: 1,
    branch: 'card/DF-7-a-thing',
    base_sha: 'abc1234',
    pr: null,
    preview_url: null,
    ...patch,
  }
}

interface Card {
  /** Who holds the card, '' for nobody. */
  assignee: string
  /** The saved "who had it before" property, or undefined if never written. */
  saved?: { previous: string } | undefined
}

interface Seen {
  card: Card
  assigned: Array<string | null>
  saves: Array<{ previous: string }>
  links: Array<{ globalId: string; title: string; url: string }>
  dropped: string[]
}

/** The three endpoints the assignee dance touches, plus the link ones. */
function stub(card: Card): Seen {
  const seen: Seen = { card, assigned: [], saves: [], links: [], dropped: [] }

  server.use(
    http.get(`${BASE}/rest/api/3/myself`, () => HttpResponse.json({ accountId: FACTORY })),

    http.get(`${BASE}/rest/api/3/issue/:key`, () =>
      HttpResponse.json({
        key: 'DF-7',
        fields: { assignee: seen.card.assignee === '' ? null : { accountId: seen.card.assignee } },
      }),
    ),

    http.put(`${BASE}/rest/api/3/issue/:key/assignee`, async ({ request }) => {
      const body = (await request.json()) as { accountId: string | null }
      seen.assigned.push(body.accountId)
      seen.card.assignee = body.accountId ?? ''
      return new HttpResponse(null, { status: 204 })
    }),

    http.get(`${BASE}/rest/api/3/issue/:key/properties/:property`, () =>
      seen.card.saved === undefined
        ? new HttpResponse(null, { status: 404 })
        : HttpResponse.json({ key: ASSIGNEE_PROPERTY, value: seen.card.saved }),
    ),

    http.put(`${BASE}/rest/api/3/issue/:key/properties/:property`, async ({ request }) => {
      const value = (await request.json()) as { previous: string }
      seen.saves.push(value)
      seen.card.saved = value
      return new HttpResponse(null, { status: 200 })
    }),

    http.post(`${BASE}/rest/api/3/issue/:key/remotelink`, async ({ request }) => {
      const body = (await request.json()) as {
        globalId: string
        object: { url: string; title: string }
      }
      seen.links.push({ globalId: body.globalId, ...body.object })
      return HttpResponse.json({ id: 1 }, { status: 201 })
    }),

    http.delete(`${BASE}/rest/api/3/issue/:key/remotelink`, ({ request }) => {
      seen.dropped.push(new URL(request.url).searchParams.get('globalId') ?? '')
      return new HttpResponse(null, { status: 204 })
    }),
  )

  return seen
}

/**
 * Where to look is a fact about the card that changes, not an event. Posted as
 * comments those URLs accumulate one copy per turn and the reader has to work
 * out which one still resolves; as links keyed by globalId there is one row per
 * thing, replaced in place.
 */
describe('the links a turn offers', () => {
  it('offers nothing on a design turn that has no branch yet', () => {
    expect(turnLinks(meta({ stage: 'design', pr: null, preview_url: null }))).toEqual([])
  })

  it('links the pull request once there is one', () => {
    const previous = process.env['GITHUB_REPOSITORY']
    process.env['GITHUB_REPOSITORY'] = 'o/r'
    try {
      const [link] = turnLinks(meta({ pr: 20 }))
      expect(link).toEqual({
        globalId: LINK_IDS.pr,
        title: 'Pull request #20',
        url: 'https://github.com/o/r/pull/20',
      })
    } finally {
      if (previous === undefined) delete process.env['GITHUB_REPOSITORY']
      else process.env['GITHUB_REPOSITORY'] = previous
    }
  })

  /**
   * The same split `report` keeps: links a human clicks go through the
   * launcher, because a preview scales to zero and the card may be opened
   * tomorrow. The agent's copy in meta stays raw.
   */
  it('puts the preview behind the launcher, because a card is read later', () => {
    const previous = process.env['AZURE_PREVIEW_LAUNCHER']
    process.env['AZURE_PREVIEW_LAUNCHER'] = 'https://launch.example'
    try {
      const links = turnLinks(meta({ preview_url: 'https://df-preview-pr-20.azurecontainerapps.io' }))
      const preview = links.find((l) => l.globalId === LINK_IDS.preview)
      expect(preview?.title).toBe('Preview')
      expect(preview?.url.startsWith('https://launch.example')).toBe(true)
    } finally {
      if (previous === undefined) delete process.env['AZURE_PREVIEW_LAUNCHER']
      else process.env['AZURE_PREVIEW_LAUNCHER'] = previous
    }
  })

  /**
   * The identity of a remote link is issue + globalId. If these drifted between
   * turns, every build turn would add a row instead of replacing one — which is
   * the exact problem the links were introduced to solve.
   */
  it('keys each link by a fixed id, so a turn replaces its own row', async () => {
    const seen = stub({ assignee: '' })
    const links = [
      { globalId: LINK_IDS.preview, title: 'Preview', url: 'https://one.example' },
      { globalId: LINK_IDS.preview, title: 'Preview', url: 'https://two.example' },
    ]

    await syncLinks(cfg, 'DF-7', links)

    expect(seen.links.map((l) => l.globalId)).toEqual([LINK_IDS.preview, LINK_IDS.preview])
    expect(seen.links.map((l) => l.url)).toEqual(['https://one.example', 'https://two.example'])
  })

  /** Decoration must not be able to fail the turn it decorates. */
  it('steps over a link Jira refuses and still writes the next one', async () => {
    const seen = stub({ assignee: '' })
    server.use(
      http.post(`${BASE}/rest/api/3/issue/:key/remotelink`, async ({ request }) => {
        const body = (await request.json()) as { globalId: string; object: Record<string, string> }
        if (body.globalId === LINK_IDS.pr) return new HttpResponse('nope', { status: 500 })
        seen.links.push({ globalId: body.globalId, ...(body.object as { title: string; url: string }) })
        return HttpResponse.json({ id: 1 }, { status: 201 })
      }),
    )

    await expect(
      syncLinks(cfg, 'DF-7', [
        { globalId: LINK_IDS.pr, title: 'Pull request #1', url: 'https://pr.example' },
        { globalId: LINK_IDS.live, title: 'Live', url: 'https://live.example' },
      ]),
    ).resolves.toBeUndefined()

    expect(seen.links.map((l) => l.globalId)).toEqual([LINK_IDS.live])
  })

  /**
   * Live Jira answers 415 Unsupported Media Type to a DELETE with no
   * `Content-Type`, despite the request having no body and the documentation
   * not mentioning it. Found by calling it. Without the header the preview link
   * on a shipped card is never removed, and nothing fails loudly enough to
   * notice — it is a warning in a log nobody reads.
   */
  it('declares a content type on the delete, which Jira requires', async () => {
    let contentType: string | null = 'absent'
    server.use(
      http.delete(`${BASE}/rest/api/3/issue/:key/remotelink`, ({ request }) => {
        contentType = request.headers.get('content-type')
        return new HttpResponse(null, { status: 204 })
      }),
    )

    await dropLink(cfg, 'DF-7', LINK_IDS.preview)
    expect(contentType).toBe('application/json')
  })

  it('removes a link without complaining about a card that never had it', async () => {
    const seen = stub({ assignee: '' })
    server.use(
      http.delete(`${BASE}/rest/api/3/issue/:key/remotelink`, () =>
        new HttpResponse(null, { status: 404 }),
      ),
    )

    await expect(dropLink(cfg, 'DF-7', LINK_IDS.preview)).resolves.toBeUndefined()
    expect(seen.dropped).toEqual([])
  })
})

/**
 * An avatar on the board is the one progress signal readable from the view
 * where nobody opens the card, and assignment notifies nobody — so it costs a
 * watcher nothing. What it must never do is quietly keep a card somebody else
 * put their name on.
 */
describe('holding the card while a turn runs', () => {
  it('takes the card and remembers who had it', async () => {
    const seen = stub({ assignee: HUMAN })

    await claimCard(cfg, 'DF-7')

    expect(seen.assigned).toEqual([FACTORY])
    expect(seen.saves).toEqual([{ previous: HUMAN }])
  })

  it('remembers an empty string when the card was unassigned', async () => {
    const seen = stub({ assignee: '' })

    await claimCard(cfg, 'DF-7')

    expect(seen.saves).toEqual([{ previous: '' }])
  })

  /**
   * A re-run of `announce` finds the factory already holding the card. Saving
   * again would record the factory as the previous holder, and `release` would
   * then hand the card back to the bot — permanently, and for every turn after.
   */
  it('does not overwrite the saved holder when it already has the card', async () => {
    const seen = stub({ assignee: FACTORY, saved: { previous: HUMAN } })

    await claimCard(cfg, 'DF-7')

    expect(seen.saves).toEqual([])
    expect(seen.assigned).toEqual([])
    expect(seen.card.saved).toEqual({ previous: HUMAN })
  })

  it('hands the card back at the end of the turn', async () => {
    const seen = stub({ assignee: FACTORY, saved: { previous: HUMAN } })

    await releaseCard(cfg, 'DF-7')

    expect(seen.assigned).toEqual([HUMAN])
  })

  it('leaves the card unassigned when that is how it found it', async () => {
    const seen = stub({ assignee: FACTORY, saved: { previous: '' } })

    await releaseCard(cfg, 'DF-7')

    expect(seen.assigned).toEqual([null])
  })

  /**
   * Taking a card mid-turn is how a person says "I am dealing with this". The
   * end of the turn must not undo it — and it arrives asynchronously, so this
   * is a real race rather than a hypothetical one.
   */
  it('does not take the card back off a human who claimed it mid-turn', async () => {
    const seen = stub({ assignee: HUMAN, saved: { previous: '' } })

    await releaseCard(cfg, 'DF-7')

    expect(seen.assigned).toEqual([])
  })

  it('warns and carries on when Jira will not allow the assignment', async () => {
    stub({ assignee: '' })
    server.use(
      http.put(`${BASE}/rest/api/3/issue/:key/assignee`, () =>
        new HttpResponse('no permission', { status: 400 }),
      ),
    )

    await expect(claimCard(cfg, 'DF-7')).resolves.toBeUndefined()
  })
})
