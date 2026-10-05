import { describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { setRunner } from './github.ts'
import { triagePass } from './triage.ts'
import type { Classifier } from './triage-classifier.ts'
import {
  BUILD,
  DESIGN,
  FACTORY,
  HUMAN,
  NONE,
  always,
  run,
  stub,
  type Board,
} from './triage.stub.ts'
import { BASE, cfg, server, useFakes } from './jira.stub.ts'

useFakes()

function oneNewComment(status: string): Board {
  return {
    cards: {
      'DF-3': {
        status,
        comments: [
          { id: '1', authorId: FACTORY, body: 'Which tab order did you want?' },
          { id: '2', authorId: HUMAN, body: 'the second one' },
        ],
      },
    },
  }
}

describe('acting on a decision', () => {
  it('moves the card, says why, records the comment and starts the design agent', async () => {
    const board = oneNewComment('Blocked on architect')
    const seen = stub(board)

    const [outcome] = await run(always(DESIGN))

    expect(outcome).toMatchObject({ key: 'DF-3', action: 'design', acted: true })
    expect(seen.transitions).toEqual([{ key: 'DF-3', to: 'Designing' }])
    expect(seen.comments).toEqual(['DF-3'])
    expect(seen.marks).toHaveLength(1)
    expect(seen.marks[0]?.value).toMatchObject({ commentId: '2', action: 'design' })
    expect(seen.dispatches).toEqual([
      ['workflow', 'run', 'design.yml', '--repo', 'acme/dark-factory-playground', '-f', 'key=DF-3'],
    ])
  })

  it('starts the build agent by dispatch, which is the only way in without a PR comment', async () => {
    const board = oneNewComment('Blocked on engineer')
    const seen = stub(board)

    await run(always(BUILD))

    expect(seen.transitions).toEqual([{ key: 'DF-3', to: 'Building' }])
    expect(seen.dispatches[0]).toContain('build-turn.yml')
    expect(seen.dispatches[0]).toContain('key=DF-3')
  })

  // The chosen answer to "what does triage say when it decides nothing?" —
  // nothing. A card that collects a line of factory commentary every time
  // somebody says "thanks" is worse than one that stays quiet.
  it('says nothing on the card when the answer is no action', async () => {
    const board = oneNewComment('Blocked on architect')
    const seen = stub(board)

    const [outcome] = await run(always(NONE))

    expect(outcome).toMatchObject({ action: 'none', acted: true })
    expect(seen.comments).toEqual([])
    expect(seen.transitions).toEqual([])
    expect(seen.dispatches).toEqual([])
    // Silent, but not forgotten: the mark is what stops it being re-read.
    expect(seen.marks[0]?.value).toMatchObject({ commentId: '2', action: 'none' })
  })
})

describe('acting on a decision: who has the card', () => {
  // The status and the avatar are one statement. Leaving the avatar to
  // `announce`, inside the run this dispatches, put tens of seconds of
  // unassigned Designing on the board — and left it that way for good whenever
  // the dispatch below failed.
  it('takes the card as well as moving it, so the board shows who has it', async () => {
    const board = oneNewComment('Blocked on architect')
    const seen = stub(board)

    await run(always(DESIGN))

    expect(seen.assignments).toEqual([{ key: 'DF-3', accountId: FACTORY }])
  })

  // They answered the question the turn stopped on, so the result is theirs —
  // not whoever happened to be assigned while the card waited.
  it('hands the card back to whoever wrote the comment when the turn ends', async () => {
    const seen = stub(oneNewComment('Blocked on architect'))

    await run(always(DESIGN))

    expect(seen.handBacks).toEqual([{ key: 'DF-3', previous: HUMAN }])
  })

  it('does not take a card it failed to move', async () => {
    const board = oneNewComment('Blocked on architect')
    const seen = stub(board)
    server.use(
      http.get(`${BASE}/rest/api/3/issue/DF-3/transitions`, () =>
        HttpResponse.json({ transitions: [{ id: '99', name: 'z', to: { name: 'Done' } }] }),
      ),
    )

    await run(always(DESIGN))

    expect(seen.assignments).toEqual([])
  })

  it('leaves the assignee alone when it decides to do nothing', async () => {
    const board = oneNewComment('Blocked on architect')
    const seen = stub(board)

    await run(always(NONE))

    expect(seen.assignments).toEqual([])
  })

  it('changes nothing at all on a dry run', async () => {
    const board = oneNewComment('Blocked on architect')
    const seen = stub(board)

    const [outcome] = await triagePass({
      cfg,
      projectKey: 'DF',
      classify: always(DESIGN),
      dryRun: true,
    })

    expect(outcome).toMatchObject({ action: 'design', acted: false })
    expect(seen.transitions).toEqual([])
    expect(seen.comments).toEqual([])
    expect(seen.marks).toEqual([])
    expect(seen.assignments).toEqual([])
    expect(seen.dispatches).toEqual([])
  })
})

/**
 * The order of move / explain / mark / dispatch is chosen so that failing at
 * any one of them leaves the least bad state. These pin the two that matter:
 * a card must never be marked as handled without having been handled, and a
 * card must never be left claimed with no way back.
 */
describe('when a step fails', () => {
  const board: Board = {
    cards: {
      'DF-3': {
        status: 'Blocked on architect',
        comments: [
          { id: '1', authorId: FACTORY, body: 'Which tab order?' },
          { id: '2', authorId: HUMAN, body: 'the second one' },
        ],
      },
    },
  }

  it('leaves the comment unmarked when the card will not move, so the next pass retries', async () => {
    const seen = stub(board)
    server.use(
      http.get(`${BASE}/rest/api/3/issue/DF-3/transitions`, () =>
        HttpResponse.json({ transitions: [{ id: '99', name: 'z', to: { name: 'Done' } }] }),
      ),
    )

    const [outcome] = await run(always(DESIGN))

    expect(outcome).toMatchObject({ action: 'design', acted: false })
    expect(seen.marks).toEqual([])
    expect(seen.comments).toEqual([])
    expect(seen.dispatches).toEqual([])
  })

  it('leaves the comment unmarked when the classifier is unreachable', async () => {
    const seen = stub(board)
    const broken: Classifier = () => Promise.reject(new Error('503'))

    expect(await run(broken)).toEqual([])
    expect(seen.marks).toEqual([])
    expect(seen.transitions).toEqual([])
  })

  // The card has already moved by this point, so the mark is beside the point
  // — it has left the statuses triage looks at either way. What matters is
  // that the failure is reported rather than swallowed.
  it('reports a card left claimed with nothing running', async () => {
    const seen = stub(board)
    setRunner(() => ({ status: 1, stdout: '', stderr: 'no such workflow' }))

    const [outcome] = await run(always(DESIGN))

    expect(outcome).toMatchObject({ acted: false })
    expect(seen.transitions).toEqual([{ key: 'DF-3', to: 'Designing' }])
  })

  it('still starts the turn when it cannot post the explanation', async () => {
    const seen = stub(board)
    server.use(
      http.post(
        `${BASE}/rest/api/3/issue/DF-3/comment`,
        () => new HttpResponse(null, { status: 500 }),
      ),
    )

    const [outcome] = await run(always(DESIGN))

    expect(outcome).toMatchObject({ acted: true })
    expect(seen.dispatches).toHaveLength(1)
  })
})
