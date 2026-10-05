import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { setupServer } from 'msw/node'
import { http, HttpResponse } from 'msw'
import * as azure from './azure.ts'
import * as github from './github.ts'
import { adfToText } from './jira.ts'
import * as preview from './preview.ts'
import { productionUp, ship } from './production.ts'

// The cloud and `gh` are the two things these steps drive; neither is called
// for real. What is left real is the decision-making around them.
vi.mock('./azure.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof azure>()),
  azureConfig: vi.fn(() => ({ registry: 'acrfactory' })),
  buildProductionImage: vi.fn(),
  deployProduction: vi.fn(() => 'https://df-production.uksouth.azurecontainerapps.io'),
}))
vi.mock('./github.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof github>()),
  createDeployment: vi.fn(),
  prBodyAndBranch: vi.fn(),
}))
vi.mock('./preview.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof preview>()),
  waitUntilAwake: vi.fn(async () => 2500),
}))

const BASE = 'https://example.atlassian.net'
const LIVE = 'https://df-production.uksouth.azurecontainerapps.io'
const SHA = 'abc1234def'

const server = setupServer()
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterAll(() => server.close())

let logs: string[] = []

beforeEach(() => {
  vi.stubEnv('JIRA_BASE', BASE)
  vi.stubEnv('JIRA_USER', 'bot@example.com')
  vi.stubEnv('JIRA_TOKEN', 'token')
  vi.stubEnv('GITHUB_REPOSITORY', 'o/r')
  vi.stubEnv('GITHUB_RUN_ID', '7')
  vi.stubEnv('FACTORY_PREVIEW_BACKEND', 'azure')
  logs = []
  const record = (...args: unknown[]): void => void logs.push(args.join(' '))
  vi.spyOn(console, 'log').mockImplementation(record)
  vi.spyOn(console, 'error').mockImplementation(record)
})

afterEach(() => {
  server.resetHandlers()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

describe('putting the merge commit into production', () => {
  it('refuses on the ghcr stub, which serves nothing', async () => {
    vi.stubEnv('FACTORY_PREVIEW_BACKEND', 'ghcr')
    await expect(productionUp(SHA)).rejects.toThrow(/needs FACTORY_PREVIEW_BACKEND=azure/)
    expect(azure.buildProductionImage).not.toHaveBeenCalled()
  })

  it('refuses anything that is not a commit SHA', async () => {
    await expect(productionUp('main')).rejects.toThrow(/Expected a git commit SHA/)
  })

  // A dry run checks the wiring, not the subscription, so it must not need
  // any Azure variables at all.
  it('touches nothing on a dry run', async () => {
    const url = await productionUp(SHA, true)
    expect(url).toBe('https://<df-production>.azurecontainerapps.io')
    expect(azure.azureConfig).not.toHaveBeenCalled()
    expect(logs).toContain(
      `production-up --dry-run: would build main-${SHA} and deploy it to df-production`,
    )
  })

  it('builds, deploys, waits for an answer and records a production deployment', async () => {
    const url = await productionUp(SHA)

    expect(url).toBe(LIVE)
    expect(azure.buildProductionImage).toHaveBeenCalledWith({ registry: 'acrfactory' }, SHA)
    expect(azure.deployProduction).toHaveBeenCalledWith({ registry: 'acrfactory' }, SHA, 'df')
    expect(preview.waitUntilAwake).toHaveBeenCalledWith(LIVE)
    expect(github.createDeployment).toHaveBeenCalledWith(SHA, 'production', LIVE, {
      transient: false,
      production: true,
    })
    expect(logs).toContain(`production-up: ${LIVE} answered after 2.5s.`)
  })

  it('does not record a deployment that never answered', async () => {
    vi.mocked(preview.waitUntilAwake).mockRejectedValueOnce(new Error('never woke'))
    await expect(productionUp(SHA)).rejects.toThrow('never woke')
    expect(github.createDeployment).not.toHaveBeenCalled()
  })
})

interface Jira {
  comments: string[]
  links: Array<{ globalId: string; title: string; url: string }>
  dropped: string[]
  moved: string[]
}

/** The card endpoints `ship` writes to, recording each write. */
function card(key: string, commentStatus = 201): Jira {
  const seen: Jira = { comments: [], links: [], dropped: [], moved: [] }
  const issue = `${BASE}/rest/api/3/issue/${key}`
  server.use(
    http.post(`${issue}/comment`, async ({ request }) => {
      if (commentStatus !== 201) return new HttpResponse('no', { status: commentStatus })
      seen.comments.push(adfToText(((await request.json()) as { body: unknown }).body))
      return HttpResponse.json({ id: '1' }, { status: 201 })
    }),
    http.post(`${issue}/remotelink`, async ({ request }) => {
      const body = (await request.json()) as {
        globalId: string
        object: { title: string; url: string }
      }
      seen.links.push({ globalId: body.globalId, ...body.object })
      return HttpResponse.json({ id: 1 }, { status: 201 })
    }),
    http.delete(`${issue}/remotelink`, ({ request }) => {
      seen.dropped.push(new URL(request.url).searchParams.get('globalId') ?? '')
      return new HttpResponse(null, { status: 204 })
    }),
    http.get(`${issue}/transitions`, () =>
      HttpResponse.json({ transitions: [{ id: '41', name: 'Ship', to: { name: 'Done' } }] }),
    ),
    http.post(`${issue}/transitions`, async ({ request }) => {
      seen.moved.push(((await request.json()) as { transition: { id: string } }).transition.id)
      return new HttpResponse(null, { status: 204 })
    }),
  )
  return seen
}

function pr(body: string, headRefName: string): void {
  vi.mocked(github.prBodyAndBranch).mockReturnValue({ body, headRefName })
}

describe('closing the card once production answers', () => {
  it('finds the card from the factory block, comments, relinks and moves it to Done', async () => {
    pr(github.renderFactoryBlock({ key: 'DF-6', stage: 'build', turn: 2 }), 'some-branch')
    const seen = card('DF-6')

    expect(await ship({ pr: 20, url: LIVE })).toBe('DF-6')

    expect(seen.comments[0]).toContain('DF-6 — shipped')
    expect(seen.links).toEqual([
      {
        globalId: 'factory-pull-request',
        title: 'Pull request #20',
        url: 'https://github.com/o/r/pull/20',
      },
      { globalId: 'factory-live', title: 'Live', url: LIVE },
    ])
    expect(seen.dropped).toEqual(['factory-preview'])
    expect(seen.moved).toEqual(['41'])
    expect(logs).toContain(`ship: DF-6 -> Done (${LIVE})`)
  })

  it('falls back to the card/<KEY>- branch when the body has no block', async () => {
    pr('No block here.', 'card/DF-8-a-thing')
    card('DF-8')
    expect(await ship({ pr: 21, url: LIVE })).toBe('DF-8')
  })

  it('refuses a pull request that names no card', async () => {
    pr('No block here.', 'feature/whatever')
    await expect(ship({ pr: 22, url: LIVE })).rejects.toThrow(
      'PR #22 has no factory block in its body and its branch (feature/whatever) is not a ' +
        'card/<KEY>-<slug> branch, so there is no card to close.',
    )
  })

  // The transition is what matters; a comment Jira would not take is a
  // warning, not a reason to leave the card in review.
  it('still moves the card when the comment is refused', async () => {
    pr('', 'card/DF-6-x')
    const seen = card('DF-6', 500)

    await ship({ pr: 20, url: LIVE })

    expect(logs.some((l) => l.startsWith('::warning::could not comment on DF-6:'))).toBe(true)
    expect(seen.moved).toEqual(['41'])
  })

  it('prints the comment and writes nothing on a dry run', async () => {
    pr('', 'card/DF-6-x')
    const seen = card('DF-6')

    expect(await ship({ pr: 20, url: LIVE, dryRun: true })).toBe('DF-6')

    expect(seen).toEqual({ comments: [], links: [], dropped: [], moved: [] })
    expect(logs).toContain('ship --dry-run: would move DF-6 to Done and comment:')
  })
})
