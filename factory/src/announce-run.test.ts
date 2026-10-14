import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { setupServer } from 'msw/node'
import { http, HttpResponse } from 'msw'
import { announce } from './announce.ts'
import { adfToText } from './jira.ts'
import { writeMeta, type Meta } from './meta.ts'

const BASE = 'https://example.atlassian.net'
const ISSUE = `${BASE}/rest/api/3/issue/DF-7`
const FACTORY = '712020:factory'
const HUMAN = '557058:human'

const server = setupServer()
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterAll(() => server.close())

let logs: string[] = []

beforeEach(() => {
  vi.stubEnv('JIRA_BASE', BASE)
  vi.stubEnv('JIRA_USER', 'bot@example.com')
  vi.stubEnv('JIRA_TOKEN', 'token')
  vi.stubEnv('GITHUB_REPOSITORY', 'o/r')
  vi.stubEnv('GITHUB_RUN_ID', '5')
  logs = []
  const record = (...args: unknown[]): void => void logs.push(args.join(' '))
  vi.spyOn(console, 'log').mockImplementation(record)
  vi.spyOn(console, 'error').mockImplementation(record)
})

afterEach(() => {
  server.resetHandlers()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

function turn(patch: Partial<Meta> = {}): void {
  writeMeta({
    key: 'DF-7',
    stage: 'build',
    turn: 2,
    branch: 'card/DF-7-a-thing',
    base_sha: 'abc1234',
    pr: 20,
    preview_url: null,
    ...patch,
  })
}

interface Seen {
  comments: string[]
  /** The raw comment bodies, for what `adfToText` flattens away. */
  raw: string[]
  assigned: Array<string | null>
  saves: unknown[]
  links: string[]
}

/** A card held by a human, with every endpoint the opening of a turn writes to. */
function card(commentStatus = 201): Seen {
  const seen: Seen = { comments: [], raw: [], assigned: [], saves: [], links: [] }
  server.use(
    http.get(`${BASE}/rest/api/3/myself`, () => HttpResponse.json({ accountId: FACTORY })),
    http.get(ISSUE, () =>
      HttpResponse.json({ key: 'DF-7', fields: { assignee: { accountId: HUMAN } } }),
    ),
    http.put(`${ISSUE}/properties/:property`, async ({ request }) => {
      seen.saves.push(await request.json())
      return new HttpResponse(null, { status: 200 })
    }),
    http.put(`${ISSUE}/assignee`, async ({ request }) => {
      seen.assigned.push(((await request.json()) as { accountId: string | null }).accountId)
      return new HttpResponse(null, { status: 204 })
    }),
    http.post(`${ISSUE}/comment`, async ({ request }) => {
      if (commentStatus !== 201) return new HttpResponse('no', { status: commentStatus })
      const body = ((await request.json()) as { body: unknown }).body
      seen.comments.push(adfToText(body))
      seen.raw.push(JSON.stringify(body))
      return HttpResponse.json({ id: '1' }, { status: 201 })
    }),
    http.post(`${ISSUE}/remotelink`, async ({ request }) => {
      seen.links.push(((await request.json()) as { globalId: string }).globalId)
      return HttpResponse.json({ id: 1 }, { status: 201 })
    }),
  )
  return seen
}

describe('opening a turn on the card', () => {
  it('comments, takes the card from whoever had it, and links the PR', async () => {
    turn()
    const seen = card()

    await announce()

    expect(seen.comments[0]).toContain('build turn 2 started')
    // The stop instruction mentions the factory's real account.
    expect(seen.raw[0]).toContain(`"type":"mention","attrs":{"id":"${FACTORY}"}`)
    expect(seen.saves).toEqual([{ previous: HUMAN }])
    expect(seen.assigned).toEqual([FACTORY])
    expect(seen.links).toEqual(['factory-pull-request'])
    expect(logs).toContain('announce: told DF-7 that build turn 2 has started.')
  })

  // The turn is already running. A notification is not worth failing it for.
  it('warns and still takes the card when the comment is refused', async () => {
    turn()
    const seen = card(500)

    await expect(announce()).resolves.toBeUndefined()

    expect(
      logs.some((l) =>
        l.startsWith('::warning::could not announce the start of the turn on DF-7:'),
      ),
    ).toBe(true)
    expect(seen.assigned).toEqual([FACTORY])
    expect(seen.links).toEqual(['factory-pull-request'])
  })

  it('prints the comment and writes nothing on a dry run', async () => {
    turn({ stage: 'design', turn: 1, pr: null })
    const seen = card()

    await announce({ dryRun: true })

    expect(seen).toEqual({ comments: [], raw: [], assigned: [], saves: [], links: [] })
    expect(logs).toContain('announce --dry-run: would comment on DF-7:')
    expect(logs.some((l) => l.includes('design turn 1 started'))).toBe(true)
    expect(logs).toContain('announce --dry-run: would take DF-7 and link 0 thing(s).')
  })
})
