import { http, HttpResponse } from 'msw'
import { setRunner, type Runner } from './github.ts'
import { TRIAGE_PROPERTY, triagePass } from './triage.ts'
import type { Classifier, TriageDecision } from './triage-classifier.ts'
import { BASE, asJiraComment, cardOf, cfg, keyOf, server } from './jira.stub.ts'

/**
 * The fake board the triage tests run against.
 *
 * Not a test file itself, so the tests that use it are what cover it. The
 * server, and `useFakes` to run it, are `jira.stub.ts`'s.
 */

export const FACTORY = '712020:factory'
export const HUMAN = '557058:human'

/** Every Jira call triage can make, plus a record of what it actually made. */
export interface Board {
  /** key -> the card's status, comments (oldest first) and existing mark. */
  cards: Record<
    string,
    {
      status: string
      /** `mentions` are account ids @mentioned at the start of the comment. */
      comments: Array<{ id: string; authorId: string; body: string; mentions?: string[] }>
      mark?: string
    }
  >
}

type BoardComment = Board['cards'][string]['comments'][number]

export interface Seen {
  searches: number
  myself: number
  comments: string[]
  transitions: Array<{ key: string; to: string }>
  marks: Array<{ key: string; value: Record<string, unknown> }>
  /** Assignments, in order. `null` is an unassignment. */
  assignments: Array<{ key: string; accountId: string | null }>
  /** Who each claimed card goes back to when the turn ends. */
  handBacks: Array<{ key: string; previous: string }>
  dispatches: string[][]
}

/** A comment on the board, as Jira sends it. */
function sent(c: BoardComment): Record<string, unknown> {
  return asJiraComment({
    id: c.id,
    authorId: c.authorId,
    author: c.authorId === FACTORY ? 'Brakkr [bot]' : 'Luke',
    created: '2026-09-23T10:00:00.000+0000',
    bodyWithoutMentions: c.body,
    mentions: c.mentions ?? [],
  })
}

/** The search that finds the cards, and who the factory is. */
function boardRoutes(board: Board, seen: Seen) {
  return [
    http.post(`${BASE}/rest/api/3/search/jql`, () => {
      seen.searches += 1
      return HttpResponse.json({
        issues: Object.entries(board.cards).map(([key, card]) => ({
          key,
          fields: { status: { name: card.status }, summary: `${key} does a thing` },
          ...(card.mark === undefined
            ? {}
            : { properties: { [TRIAGE_PROPERTY]: { commentId: card.mark } } }),
        })),
        isLast: true,
      })
    }),

    http.get(`${BASE}/rest/api/3/myself`, () => {
      seen.myself += 1
      return HttpResponse.json({ accountId: FACTORY })
    }),
  ]
}

/** The card's thread, read and written. */
function commentRoutes(board: Board, seen: Seen) {
  return [
    // Honours orderBy and maxResults, like Jira does, so `latestComment`
    // cannot quietly read the wrong end of a truncated page.
    http.get(`${BASE}/rest/api/3/issue/:key/comment`, ({ params, request }) => {
      const query = new URL(request.url).searchParams
      const thread = [...cardOf(board.cards, params).comments]
      if (query.get('orderBy') === '-created') thread.reverse()
      const limit = Number(query.get('maxResults') ?? thread.length)
      return HttpResponse.json({ comments: thread.slice(0, limit).map(sent) })
    }),

    http.post(`${BASE}/rest/api/3/issue/:key/comment`, ({ params }) => {
      seen.comments.push(keyOf(params))
      return HttpResponse.json({ id: '99' }, { status: 201 })
    }),
  ]
}

/** Moves, and the claim that follows one. */
function moveRoutes(seen: Seen) {
  return [
    http.get(`${BASE}/rest/api/3/issue/:key/transitions`, () =>
      HttpResponse.json({
        transitions: [
          { id: '11', name: 'x', to: { name: 'Designing' } },
          { id: '12', name: 'y', to: { name: 'Building' } },
        ],
      }),
    ),

    http.post(`${BASE}/rest/api/3/issue/:key/transitions`, async ({ params, request }) => {
      const body = (await request.json()) as { transition: { id: string } }
      seen.transitions.push({
        key: keyOf(params),
        to: body.transition.id === '11' ? 'Designing' : 'Building',
      })
      return new HttpResponse(null, { status: 204 })
    }),

    // Claiming the card reads the current assignee, which goes through
    // getIssue. The card is unassigned until `act` takes it.
    http.get(`${BASE}/rest/api/3/issue/:key`, ({ params }) =>
      HttpResponse.json({ key: keyOf(params), fields: { assignee: null, summary: 'a card' } }),
    ),

    http.put(`${BASE}/rest/api/3/issue/:key/assignee`, async ({ params, request }) => {
      const body = (await request.json()) as { accountId: string | null }
      seen.assignments.push({ key: keyOf(params), accountId: body.accountId })
      return new HttpResponse(null, { status: 204 })
    }),
  ]
}

/**
 * Two different properties are written through this one endpoint — the triage
 * high-water mark and the record of who held the card before the factory took
 * it. Keeping them in one list would make every assertion about marks depend on
 * whether a claim happened.
 */
function propertyRoutes(seen: Seen) {
  return [
    http.put(`${BASE}/rest/api/3/issue/:key/properties/:property`, async ({ params, request }) => {
      const value = (await request.json()) as Record<string, unknown>
      if (params['property'] === TRIAGE_PROPERTY) {
        seen.marks.push({ key: keyOf(params), value })
      } else {
        seen.handBacks.push({ key: keyOf(params), previous: value['previous'] as string })
      }
      return new HttpResponse(null, { status: 200 })
    }),
  ]
}

export function stub(board: Board): Seen {
  const seen: Seen = {
    searches: 0,
    myself: 0,
    comments: [],
    transitions: [],
    marks: [],
    assignments: [],
    handBacks: [],
    dispatches: [],
  }

  const runner: Runner = (args) => {
    seen.dispatches.push(args)
    return { status: 0, stdout: '', stderr: '' }
  }
  setRunner(runner)

  server.use(
    ...boardRoutes(board, seen),
    ...commentRoutes(board, seen),
    ...moveRoutes(seen),
    ...propertyRoutes(seen),
  )
  return seen
}

/** A classifier that always answers the same way, and counts how often it is asked. */
export function always(decision: TriageDecision): Classifier & { calls: number } {
  const fn = Object.assign(
    async (): Promise<TriageDecision> => {
      fn.calls += 1
      return decision
    },
    { calls: 0 },
  )
  return fn
}

export const DESIGN: TriageDecision = {
  action: 'design',
  reason: 'Answers the question about the tab order.',
}
export const BUILD: TriageDecision = {
  action: 'build',
  reason: 'Reports the button does nothing on Safari.',
}
export const NONE: TriageDecision = { action: 'none', reason: 'Acknowledgement, nothing to do.' }

/** Runs a pass against whichever board `stub` last installed. */
export const run = (classify: Classifier) => triagePass({ cfg, projectKey: 'DF', classify })
