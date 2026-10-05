import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { setupServer } from 'msw/node'
import { http, HttpResponse } from 'msw'
import type * as jira from './jira.ts'
import { ghRunner, setRunner, type Runner } from './github.ts'
import { TRIAGE_PROPERTY } from './triage.ts'
import {
  ORPHAN_GRACE_MS,
  holdFrom,
  isStopCommand,
  releaseOrphans,
  returnStatus,
  stop,
  takeCard,
} from './lock.ts'

const BASE = 'https://example.atlassian.net'
const cfg: jira.JiraConfig = { base: BASE, user: 'bot@example.com', token: 'token' }
const FACTORY = 'acct-factory'
const LUKE = 'acct-luke'
const ANA = 'acct-ana'

const server = setupServer()
const previousRepo = process.env['GITHUB_REPOSITORY']

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' })
  process.env['GITHUB_REPOSITORY'] = 'acme/dark-factory-playground'
})
afterEach(() => {
  server.resetHandlers()
  setRunner(ghRunner)
})
afterAll(() => {
  server.close()
  if (previousRepo === undefined) delete process.env['GITHUB_REPOSITORY']
  else process.env['GITHUB_REPOSITORY'] = previousRepo
})

function comment(over: Partial<jira.JiraComment>): jira.JiraComment {
  return {
    id: '1',
    authorId: LUKE,
    author: 'Luke',
    created: '2026-10-05T10:00:00.000+0000',
    body: '',
    bodyWithoutMentions: '',
    mentions: [],
    ...over,
  }
}

function move(created: string, from: string, to: string): jira.ChangeEntry {
  return {
    authorId: FACTORY,
    created,
    items: [{ field: 'status', to: null, toString: to, fromString: from }],
  }
}

describe('what counts as "stop"', () => {
  // The mention is what makes it a command to the factory; the first word is
  // what makes it this command.
  it('is a mention of the factory with "stop" as the first word', () => {
    for (const text of [' stop', ' Stop.', ', stop please', ' STOP', '  —stop']) {
      expect(
        isStopCommand(comment({ mentions: [FACTORY], bodyWithoutMentions: text }), FACTORY),
      ).toBe(true)
    }
  })

  // A false positive throws a running turn away, so anything short of the
  // plain command is not one.
  it('is not "stop" further into the sentence, a longer word, or no mention', () => {
    const cases = [
      comment({ mentions: [FACTORY], bodyWithoutMentions: " don't stop at the header" }),
      comment({ mentions: [FACTORY], bodyWithoutMentions: ' stopping point is fine' }),
      comment({ mentions: [ANA], bodyWithoutMentions: ' stop' }),
      comment({ mentions: [], bodyWithoutMentions: 'stop' }),
    ]
    for (const c of cases) expect(isStopCommand(c, FACTORY)).toBe(false)
  })
})

describe('where a card goes when it is let go', () => {
  it('reads the newest move into a locked status, and where it came from', () => {
    const hold = holdFrom([
      move('2026-10-05T09:00:00.000+0000', 'Ready for design', 'Designing'),
      move('2026-10-05T09:30:00.000+0000', 'Designing', 'Design review'),
      move('2026-10-05T10:00:00.000+0000', 'In review', 'Building'),
    ])
    expect(hold).toEqual({ since: '2026-10-05T10:00:00.000+0000', from: 'In review' })
  })

  it('goes back where it came from', () => {
    expect(returnStatus('Building', { since: 'x', from: 'In review' })).toBe('In review')
    expect(returnStatus('Designing', { since: 'x', from: 'Blocked on architect' })).toBe(
      'Blocked on architect',
    )
  })

  // A history that says nothing, or says it came from the other locked status,
  // gives no place to go back to that is not locked itself.
  it('falls back to the Ready column for the stage', () => {
    expect(returnStatus('Designing', { since: '', from: '' })).toBe('Ready for design')
    expect(returnStatus('Building', { since: 'x', from: 'Designing' })).toBe('Ready for build')
  })
})

interface Card {
  status: string
  assignee?: string | null
  comments?: jira.JiraComment[]
  mark?: string
  history?: jira.ChangeEntry[]
  previous?: string
}

interface Seen {
  /** Every write, in order, so the order of assign and move can be checked. */
  writes: string[]
  comments: Array<{ key: string; text: string }>
  marks: Array<{ key: string; value: Record<string, unknown> }>
  gh: string[][]
}

const STATUSES = [
  'Backlog',
  'Ready for design',
  'Designing',
  'Design review',
  'Blocked on architect',
  'Ready for build',
  'Building',
  'In review',
  'Blocked on engineer',
  'Done',
]

function textOf(node: unknown): string {
  if (node === null || typeof node !== 'object') return ''
  const n = node as Record<string, unknown>
  const own = typeof n['text'] === 'string' ? (n['text'] as string) : ''
  const kids = Array.isArray(n['content']) ? (n['content'] as unknown[]) : []
  return own + kids.map(textOf).join('')
}

interface FakeRun {
  id: number
  key: string
  workflow: string
  status: string
  /** How many `run view`s it takes to finish cancelling. Infinity for never. */
  cancelsAfter?: number
  /** What the run does as it finishes, such as report. */
  onFinish?: () => void
}

/**
 * A board and an Actions tab.
 *
 * Moves really move the card, so a second read sees the first write. A
 * cancelled run finishes after `cancelsAfter` looks, and a run that never
 * finishes is only stopped by a force-cancel.
 */
function stub(cards: Record<string, Card>, runs: FakeRun[] = []): Seen {
  const seen: Seen = { writes: [], comments: [], marks: [], gh: [] }
  const views = new Map<number, number>()

  const runner: Runner = (args) => {
    seen.gh.push(args)
    const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' })
    if (args[0] === 'run' && args[1] === 'list') {
      const workflow = args[args.indexOf('--workflow') + 1]
      const listed = runs
        .filter((r) => r.workflow === workflow)
        .map((r) => ({
          databaseId: r.id,
          displayTitle: `${r.key} ${workflow === 'design.yml' ? 'design turn' : 'build turn'}`,
          status: r.status,
          url: `https://github.com/acme/dark-factory-playground/actions/runs/${r.id}`,
        }))
      return ok(JSON.stringify(listed))
    }
    if (args[0] === 'run' && args[1] === 'cancel') return ok()
    if (args[0] === 'run' && args[1] === 'view') {
      const run = runs.find((r) => String(r.id) === args[2]) as FakeRun
      const looked = (views.get(run.id) ?? 0) + 1
      views.set(run.id, looked)
      if (looked >= (run.cancelsAfter ?? 1) && run.status !== 'completed') {
        run.status = 'completed'
        run.onFinish?.()
      }
      return ok(JSON.stringify({ status: run.status }))
    }
    if (args[0] === 'api' && args[3]?.endsWith('/force-cancel') === true) {
      const id = Number(args[3].split('/').at(-2))
      const run = runs.find((r) => r.id === id) as FakeRun
      run.status = 'completed'
      return ok()
    }
    throw new Error(`unexpected gh call: ${args.join(' ')}`)
  }
  setRunner(runner)

  const card = (params: Record<string, unknown>): Card => cards[params['key'] as string] as Card

  server.use(
    http.get(`${BASE}/rest/api/3/myself`, () => HttpResponse.json({ accountId: FACTORY })),

    http.post(`${BASE}/rest/api/3/search/jql`, () =>
      HttpResponse.json({
        issues: Object.entries(cards)
          .filter(([, c]) => c.status === 'Designing' || c.status === 'Building')
          .map(([key, c]) => ({ key, fields: { status: { name: c.status } } })),
        isLast: true,
      }),
    ),

    http.get(`${BASE}/rest/api/3/issue/:key/comment`, ({ params }) =>
      HttpResponse.json({
        comments: [...(card(params).comments ?? [])].reverse().map((c) => ({
          id: c.id,
          author: { displayName: c.author, accountId: c.authorId },
          created: c.created,
          body: {
            type: 'doc',
            content: [
              {
                type: 'paragraph',
                content: [
                  ...c.mentions.map((id) => ({ type: 'mention', attrs: { id, text: '@Enki' } })),
                  { type: 'text', text: c.bodyWithoutMentions },
                ],
              },
            ],
          },
        })),
      }),
    ),

    http.post(`${BASE}/rest/api/3/issue/:key/comment`, async ({ params, request }) => {
      const body = (await request.json()) as { body: unknown }
      seen.writes.push(`comment ${params['key'] as string}`)
      seen.comments.push({ key: params['key'] as string, text: textOf(body.body) })
      return HttpResponse.json({ id: '99' }, { status: 201 })
    }),

    http.get(`${BASE}/rest/api/3/issue/:key/changelog`, ({ params }) =>
      HttpResponse.json({
        values: (card(params).history ?? []).map((e) => ({
          author: { accountId: e.authorId },
          created: e.created,
          items: e.items,
        })),
        isLast: true,
      }),
    ),

    http.get(`${BASE}/rest/api/3/issue/:key/transitions`, () =>
      HttpResponse.json({
        transitions: STATUSES.map((name, i) => ({
          id: String(i),
          name: `to ${name}`,
          to: { name },
        })),
      }),
    ),

    http.post(`${BASE}/rest/api/3/issue/:key/transitions`, async ({ params, request }) => {
      const body = (await request.json()) as { transition: { id: string } }
      const to = STATUSES[Number(body.transition.id)] as string
      card(params).status = to
      seen.writes.push(`move ${params['key'] as string} ${to}`)
      return new HttpResponse(null, { status: 204 })
    }),

    http.get(`${BASE}/rest/api/3/issue/:key`, ({ params }) => {
      const c = card(params)
      return HttpResponse.json({
        key: params['key'] as string,
        fields: {
          status: { name: c.status },
          assignee:
            c.assignee === undefined || c.assignee === null ? null : { accountId: c.assignee },
        },
      })
    }),

    http.put(`${BASE}/rest/api/3/issue/:key/assignee`, async ({ params, request }) => {
      const body = (await request.json()) as { accountId: string | null }
      card(params).assignee = body.accountId
      seen.writes.push(`assign ${params['key'] as string} ${body.accountId ?? 'nobody'}`)
      return new HttpResponse(null, { status: 204 })
    }),

    http.get(`${BASE}/rest/api/3/issue/:key/properties/:property`, ({ params }) => {
      const c = card(params)
      if (params['property'] === TRIAGE_PROPERTY) {
        return c.mark === undefined
          ? new HttpResponse(null, { status: 404 })
          : HttpResponse.json({ key: params['property'], value: { commentId: c.mark } })
      }
      return c.previous === undefined
        ? new HttpResponse(null, { status: 404 })
        : HttpResponse.json({ key: params['property'], value: { previous: c.previous } })
    }),

    http.put(`${BASE}/rest/api/3/issue/:key/properties/:property`, async ({ params, request }) => {
      const value = (await request.json()) as Record<string, unknown>
      if (params['property'] === TRIAGE_PROPERTY) {
        card(params).mark = value['commentId'] as string
        seen.marks.push({ key: params['key'] as string, value })
      } else {
        card(params).previous = value['previous'] as string
      }
      seen.writes.push(`property ${params['key'] as string} ${params['property'] as string}`)
      return new HttpResponse(null, { status: 200 })
    }),
  )

  return seen
}

const noWait = async (): Promise<void> => {}

const stopFromLuke = comment({
  id: '40',
  authorId: LUKE,
  mentions: [FACTORY],
  bodyWithoutMentions: ' stop',
})

function building(over: Partial<Card> = {}): Card {
  return {
    status: 'Building',
    assignee: FACTORY,
    comments: [
      comment({ id: '30', authorId: FACTORY, bodyWithoutMentions: 'build turn 2 started' }),
      stopFromLuke,
    ],
    history: [move('2026-10-05T09:58:00.000+0000', 'In review', 'Building')],
    ...over,
  }
}

describe('stopping a turn', () => {
  it('cancels the run, waits for it, and gives the card back to whoever said stop', async () => {
    const cards = { 'DF-4': building() }
    const runs: FakeRun[] = [
      { id: 7, key: 'DF-4', workflow: 'build-turn.yml', status: 'in_progress', cancelsAfter: 2 },
    ]
    const seen = stub(cards, runs)

    expect(await stop({ cfg, key: 'DF-4', sleep: noWait })).toBe('stopped')

    expect(seen.gh.filter((a) => a[1] === 'cancel').map((a) => a[2])).toEqual(['7'])
    expect(seen.gh.filter((a) => a[1] === 'view')).toHaveLength(2)
    expect(cards['DF-4'].status).toBe('In review')
    expect(cards['DF-4'].assignee).toBe(LUKE)
    expect(seen.comments[0]?.text).toContain('Stopped, as asked.')
    expect(seen.comments[0]?.text).toContain('back in In review')
  })

  // Moving first would leave the card in a Ready column still assigned to the
  // factory for a moment — which is exactly how a card is sent in.
  it('assigns before it moves, and marks the comment before either', async () => {
    const seen = stub(
      { 'DF-4': building({ history: [move('t', 'Ready for build', 'Building')] }) },
      [{ id: 7, key: 'DF-4', workflow: 'build-start.yml', status: 'in_progress' }],
    )

    await stop({ cfg, key: 'DF-4', sleep: noWait })

    expect(seen.writes).toEqual([
      `property DF-4 ${TRIAGE_PROPERTY}`,
      `assign DF-4 ${LUKE}`,
      'move DF-4 Ready for build',
      'comment DF-4',
    ])
    expect(seen.marks[0]?.value).toMatchObject({ commentId: '40', action: 'stop' })
  })

  it('force-cancels a run that will not stop', async () => {
    const runs: FakeRun[] = [
      {
        id: 9,
        key: 'DF-4',
        workflow: 'build-turn.yml',
        status: 'in_progress',
        cancelsAfter: Infinity,
      },
    ]
    const seen = stub({ 'DF-4': building() }, runs)

    await stop({ cfg, key: 'DF-4', sleep: noWait, waitMs: 10, pollMs: 5 })

    expect(
      seen.gh.some(
        (a) => a[0] === 'api' && a[3]?.endsWith('/actions/runs/9/force-cancel') === true,
      ),
    ).toBe(true)
    expect(seen.writes).toContain('move DF-4 In review')
  })

  it('only cancels runs for this card', async () => {
    const seen = stub({ 'DF-4': building() }, [
      { id: 7, key: 'DF-4', workflow: 'build-turn.yml', status: 'in_progress' },
      { id: 8, key: 'DF-40', workflow: 'build-turn.yml', status: 'in_progress' },
      { id: 5, key: 'DF-4', workflow: 'design.yml', status: 'completed' },
    ])

    await stop({ cfg, key: 'DF-4', sleep: noWait })

    expect(seen.gh.filter((a) => a[1] === 'cancel').map((a) => a[2])).toEqual(['7'])
  })

  // The run reported in the time it took to cancel it. Its result stands.
  it('leaves the card alone if the turn moved it out first', async () => {
    const cards = { 'DF-4': building() }
    const runs: FakeRun[] = [
      {
        id: 7,
        key: 'DF-4',
        workflow: 'build-turn.yml',
        status: 'in_progress',
        onFinish: () => {
          cards['DF-4'].status = 'In review'
        },
      },
    ]
    const seen = stub(cards, runs)

    expect(await stop({ cfg, key: 'DF-4', sleep: noWait })).toBe('stopped')

    expect(seen.writes.filter((w) => w.startsWith('move') || w.startsWith('assign'))).toEqual([])
    expect(seen.comments[0]?.text).toContain('already finished')
  })

  it('does nothing on a card that is not locked', async () => {
    const seen = stub({ 'DF-4': building({ status: 'In review' }) })
    expect(await stop({ cfg, key: 'DF-4', sleep: noWait })).toBe('not-locked')
    expect(seen.writes).toEqual([])
  })

  it('does nothing when the mention was not a stop', async () => {
    const other = comment({
      id: '41',
      mentions: [FACTORY],
      bodyWithoutMentions: ' also make it blue',
    })
    const seen = stub({ 'DF-4': building({ comments: [stopFromLuke, other] }) })
    expect(await stop({ cfg, key: 'DF-4', sleep: noWait })).toBe('not-a-stop')
    expect(seen.writes).toEqual([])
  })

  // A stop from before the factory last spoke was for an earlier turn.
  it('does nothing about a stop the factory has spoken since', async () => {
    const after = comment({
      id: '50',
      authorId: FACTORY,
      bodyWithoutMentions: 'build turn 3 started',
    })
    const seen = stub({ 'DF-4': building({ comments: [stopFromLuke, after] }) })
    expect(await stop({ cfg, key: 'DF-4', sleep: noWait })).toBe('not-a-stop')
    expect(seen.writes).toEqual([])
  })

  // Jira can fire the flow twice for one comment, and the second stop would
  // otherwise find the card unlocked... or, worse, a new turn to cancel.
  it('does nothing about a stop it has already acted on', async () => {
    const seen = stub({ 'DF-4': building({ mark: '40' }) })
    expect(await stop({ cfg, key: 'DF-4', sleep: noWait })).toBe('already-handled')
    expect(seen.writes).toEqual([])
  })

  it('writes nothing on a dry run', async () => {
    const seen = stub({ 'DF-4': building() }, [
      { id: 7, key: 'DF-4', workflow: 'build-turn.yml', status: 'in_progress' },
    ])
    await stop({ cfg, key: 'DF-4', dryRun: true, sleep: noWait })
    expect(seen.writes).toEqual([])
    expect(seen.gh.filter((a) => a[1] !== 'list')).toEqual([])
  })
})

describe('letting go of abandoned cards', () => {
  const now = Date.parse('2026-10-05T12:00:00.000Z')
  const longAgo = new Date(now - ORPHAN_GRACE_MS - 60_000).toISOString()
  const justNow = new Date(now - 60_000).toISOString()

  it('lets go of a locked card with no run, back to whoever sent it in', async () => {
    const cards = {
      'DF-4': {
        status: 'Designing',
        assignee: FACTORY,
        previous: ANA,
        history: [move(longAgo, 'Ready for design', 'Designing')],
      },
    }
    const seen = stub(cards)

    expect(await releaseOrphans({ cfg, projectKey: 'DF', now })).toEqual(['DF-4'])

    expect(seen.writes).toEqual([
      `assign DF-4 ${ANA}`,
      'move DF-4 Ready for design',
      'comment DF-4',
    ])
    expect(seen.comments[0]?.text).toContain('Let go of this card.')
  })

  it('leaves a card that a run is working on, even a queued one', async () => {
    const seen = stub(
      {
        'DF-4': { status: 'Building', history: [move(longAgo, 'Ready for build', 'Building')] },
        'DF-5': { status: 'Designing', history: [move(longAgo, 'Ready for design', 'Designing')] },
      },
      [
        { id: 1, key: 'DF-4', workflow: 'build-start.yml', status: 'in_progress' },
        { id: 2, key: 'DF-5', workflow: 'design.yml', status: 'queued' },
      ],
    )
    expect(await releaseOrphans({ cfg, projectKey: 'DF', now })).toEqual([])
    expect(seen.writes).toEqual([])
  })

  // The poller moves a card, then dispatches; the run takes a moment to be
  // listed. That gap is not an orphan.
  it('leaves a card that was only just moved in', async () => {
    const seen = stub({
      'DF-4': { status: 'Building', history: [move(justNow, 'In review', 'Building')] },
    })
    expect(await releaseOrphans({ cfg, projectKey: 'DF', now })).toEqual([])
    expect(seen.writes).toEqual([])
  })

  it('writes nothing on a dry run', async () => {
    const seen = stub({
      'DF-4': { status: 'Building', history: [move(longAgo, 'In review', 'Building')] },
    })
    expect(await releaseOrphans({ cfg, projectKey: 'DF', now, dryRun: true })).toEqual([])
    expect(seen.writes).toEqual([])
  })
})

describe('taking a card for a turn sent from the pull request', () => {
  it('moves it from review into Building and takes it from the reviewer', async () => {
    const card: Card = { status: 'In review', assignee: LUKE }
    const seen = stub({ 'DF-4': card })

    await takeCard(cfg, 'DF-4', 'Building')

    expect(card.status).toBe('Building')
    expect(card.assignee).toBe(FACTORY)
    expect(card.previous).toBe(LUKE)
    expect(seen.writes[0]).toBe('move DF-4 Building')
  })

  // Triage or refresh moved it already, or another turn holds it and this one
  // is queued behind it. Either way there is nowhere to move it.
  it('does not move a card that is already locked', async () => {
    const seen = stub({ 'DF-4': { status: 'Building', assignee: FACTORY } })
    await takeCard(cfg, 'DF-4', 'Building')
    expect(seen.writes.filter((w) => w.startsWith('move'))).toEqual([])
  })
})
