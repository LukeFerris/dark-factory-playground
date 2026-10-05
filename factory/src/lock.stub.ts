import { http, HttpResponse } from 'msw'
import type * as jira from './jira.ts'
import { setRunner, type Runner } from './github.ts'
import { TRIAGE_PROPERTY } from './triage.ts'
import { BASE, asJiraComment, cardOf, keyOf, server, textOf } from './jira.stub.ts'

/**
 * The fake board and Actions tab the lock tests run against.
 *
 * Not a test file itself, so the tests that use it are what cover it. The
 * server, and `useFakes` to run it, are `jira.stub.ts`'s.
 */

export const FACTORY = 'acct-factory'
export const LUKE = 'acct-luke'
export const ANA = 'acct-ana'

export function comment(over: Partial<jira.JiraComment>): jira.JiraComment {
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

export function move(created: string, from: string, to: string): jira.ChangeEntry {
  return {
    authorId: FACTORY,
    created,
    items: [{ field: 'status', to: null, toString: to, fromString: from }],
  }
}

export interface Card {
  status: string
  assignee?: string | null
  comments?: jira.JiraComment[]
  mark?: string
  history?: jira.ChangeEntry[]
  previous?: string
}

export interface Seen {
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

export interface FakeRun {
  id: number
  key: string
  workflow: string
  status: string
  /** How many `run view`s it takes to finish cancelling. Infinity for never. */
  cancelsAfter?: number
  /** What the run does as it finishes, such as report. */
  onFinish?: () => void
}

/** One `gh` command the fake Actions tab answers: when it applies, and its stdout. */
interface GhRoute {
  matches: (args: string[]) => boolean
  reply: (args: string[]) => string
}

function listRuns(runs: FakeRun[], args: string[]): string {
  const workflow = args[args.indexOf('--workflow') + 1]
  const listed = runs
    .filter((r) => r.workflow === workflow)
    .map((r) => ({
      databaseId: r.id,
      displayTitle: `${r.key} ${workflow === 'design.yml' ? 'design turn' : 'build turn'}`,
      status: r.status,
      url: `https://github.com/acme/dark-factory-playground/actions/runs/${r.id}`,
    }))
  return JSON.stringify(listed)
}

/** A look at a run. A cancelled run finishes after `cancelsAfter` of these. */
function viewRun(runs: FakeRun[], views: Map<number, number>, args: string[]): string {
  const run = runs.find((r) => String(r.id) === args[2]) as FakeRun
  const looked = (views.get(run.id) ?? 0) + 1
  views.set(run.id, looked)
  if (looked >= (run.cancelsAfter ?? 1) && run.status !== 'completed') {
    run.status = 'completed'
    run.onFinish?.()
  }
  return JSON.stringify({ status: run.status })
}

function forceCancel(runs: FakeRun[], args: string[]): string {
  const id = Number((args[3] as string).split('/').at(-2))
  const run = runs.find((r) => r.id === id) as FakeRun
  run.status = 'completed'
  return ''
}

function ghRoutes(runs: FakeRun[]): GhRoute[] {
  const views = new Map<number, number>()
  const isRun = (verb: string) => (args: string[]) => args[0] === 'run' && args[1] === verb
  return [
    { matches: isRun('list'), reply: (args) => listRuns(runs, args) },
    { matches: isRun('cancel'), reply: () => '' },
    { matches: isRun('view'), reply: (args) => viewRun(runs, views, args) },
    {
      matches: (args) => args[0] === 'api' && args[3]?.endsWith('/force-cancel') === true,
      reply: (args) => forceCancel(runs, args),
    },
  ]
}

/** The Actions tab: records every `gh` call and answers the ones it knows. */
function fakeGh(runs: FakeRun[], seen: Seen): Runner {
  const routes = ghRoutes(runs)
  return (args) => {
    seen.gh.push(args)
    const route = routes.find((r) => r.matches(args))
    if (route === undefined) throw new Error(`unexpected gh call: ${args.join(' ')}`)
    return { status: 0, stdout: route.reply(args), stderr: '' }
  }
}

/** What a stub's handlers share: the board itself, and the record of writes. */
interface Board {
  cards: Record<string, Card>
  seen: Seen
}

/** Who the factory is, and which cards are in a locked status. */
function boardRoutes(board: Board) {
  return [
    http.get(`${BASE}/rest/api/3/myself`, () => HttpResponse.json({ accountId: FACTORY })),

    http.post(`${BASE}/rest/api/3/search/jql`, () =>
      HttpResponse.json({
        issues: Object.entries(board.cards)
          .filter(([, c]) => c.status === 'Designing' || c.status === 'Building')
          .map(([key, c]) => ({ key, fields: { status: { name: c.status } } })),
        isLast: true,
      }),
    ),
  ]
}

/** The card's thread, and its history. */
function conversationRoutes(board: Board) {
  return [
    http.get(`${BASE}/rest/api/3/issue/:key/comment`, ({ params }) =>
      HttpResponse.json({
        comments: [...(cardOf(board.cards, params).comments ?? [])].reverse().map(asJiraComment),
      }),
    ),

    http.post(`${BASE}/rest/api/3/issue/:key/comment`, async ({ params, request }) => {
      const body = (await request.json()) as { body: unknown }
      board.seen.writes.push(`comment ${keyOf(params)}`)
      board.seen.comments.push({ key: keyOf(params), text: textOf(body.body, '') })
      return HttpResponse.json({ id: '99' }, { status: 201 })
    }),

    http.get(`${BASE}/rest/api/3/issue/:key/changelog`, ({ params }) =>
      HttpResponse.json({
        values: (cardOf(board.cards, params).history ?? []).map((e) => ({
          author: { accountId: e.authorId },
          created: e.created,
          items: e.items,
        })),
        isLast: true,
      }),
    ),
  ]
}

/** Moves, which really move the card, so a second read sees the first write. */
function transitionRoutes(board: Board) {
  return [
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
      cardOf(board.cards, params).status = to
      board.seen.writes.push(`move ${keyOf(params)} ${to}`)
      return new HttpResponse(null, { status: 204 })
    }),
  ]
}

/** The card itself, and who it is assigned to. */
function issueRoutes(board: Board) {
  return [
    http.get(`${BASE}/rest/api/3/issue/:key`, ({ params }) => {
      const c = cardOf(board.cards, params)
      const assignee =
        c.assignee === undefined || c.assignee === null ? null : { accountId: c.assignee }
      return HttpResponse.json({
        key: keyOf(params),
        fields: { status: { name: c.status }, assignee },
      })
    }),

    http.put(`${BASE}/rest/api/3/issue/:key/assignee`, async ({ params, request }) => {
      const body = (await request.json()) as { accountId: string | null }
      cardOf(board.cards, params).assignee = body.accountId
      board.seen.writes.push(`assign ${keyOf(params)} ${body.accountId ?? 'nobody'}`)
      return new HttpResponse(null, { status: 204 })
    }),
  ]
}

/** A stored property, as Jira answers a read of it: 404 for one never written. */
function propertyReply(property: unknown, value: Record<string, string> | null): Response {
  return value === null
    ? new HttpResponse(null, { status: 404 })
    : HttpResponse.json({ key: property, value })
}

/** The two hidden properties: triage's mark, and who held the card before. */
function propertyRoutes(board: Board) {
  return [
    http.get(`${BASE}/rest/api/3/issue/:key/properties/:property`, ({ params }) => {
      const c = cardOf(board.cards, params)
      if (params['property'] === TRIAGE_PROPERTY) {
        return propertyReply(
          params['property'],
          c.mark === undefined ? null : { commentId: c.mark },
        )
      }
      return propertyReply(
        params['property'],
        c.previous === undefined ? null : { previous: c.previous },
      )
    }),

    http.put(`${BASE}/rest/api/3/issue/:key/properties/:property`, async ({ params, request }) => {
      const value = (await request.json()) as Record<string, unknown>
      if (params['property'] === TRIAGE_PROPERTY) {
        cardOf(board.cards, params).mark = value['commentId'] as string
        board.seen.marks.push({ key: keyOf(params), value })
      } else {
        cardOf(board.cards, params).previous = value['previous'] as string
      }
      board.seen.writes.push(`property ${keyOf(params)} ${params['property'] as string}`)
      return new HttpResponse(null, { status: 200 })
    }),
  ]
}

/**
 * A board and an Actions tab.
 *
 * Moves really move the card, so a second read sees the first write. A
 * cancelled run finishes after `cancelsAfter` looks, and a run that never
 * finishes is only stopped by a force-cancel.
 */
export function stub(cards: Record<string, Card>, runs: FakeRun[] = []): Seen {
  const seen: Seen = { writes: [], comments: [], marks: [], gh: [] }
  setRunner(fakeGh(runs, seen))

  const board: Board = { cards, seen }
  server.use(
    ...boardRoutes(board),
    ...conversationRoutes(board),
    ...transitionRoutes(board),
    ...issueRoutes(board),
    ...propertyRoutes(board),
  )
  return seen
}
