import { describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { TRIAGE_STATUSES, triagePass } from './triage.ts'
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

describe('what triage looks at', () => {
  it('searches only the statuses where the factory is waiting on a person', async () => {
    let jql = ''
    server.use(
      http.post(`${BASE}/rest/api/3/search/jql`, async ({ request }) => {
        jql = ((await request.json()) as { jql: string }).jql
        return HttpResponse.json({ issues: [], isLast: true })
      }),
    )

    await triagePass({ cfg, projectKey: 'DF', classify: always(NONE) })

    for (const status of TRIAGE_STATUSES) expect(jql).toContain(`"${status}"`)
    // A card in one of these has an agent running on its branch, or is not the
    // factory's problem. Waking a second agent on a live branch is the one
    // mistake triage must not be able to make.
    for (const status of ['Designing', 'Building', 'Backlog', 'Done']) {
      expect(jql).not.toContain(`"${status}"`)
    }
    // The two Ready columns are dispatched by status on the same pass. Reading
    // them here as well would hand one card to two runners.
    expect(jql).not.toContain('Ready for')
  })

  // The poller runs this every thirty seconds, mostly against nothing.
  it('costs one search and nothing else when no card is waiting', async () => {
    const seen = stub({ cards: {} })
    const classify = always(NONE)

    expect(await triagePass({ cfg, projectKey: 'DF', classify })).toEqual([])
    expect(seen.searches).toBe(1)
    expect(seen.myself).toBe(0)
    expect(classify.calls).toBe(0)
  })
})

describe('what triage leaves alone', () => {
  it("ignores a card whose last word is the factory's own", async () => {
    const board: Board = {
      cards: {
        'DF-3': {
          status: 'Blocked on architect',
          comments: [
            { id: '1', authorId: HUMAN, body: 'please look at this' },
            { id: '2', authorId: FACTORY, body: 'design turn finished' },
          ],
        },
      },
    }
    const seen = stub(board)
    const classify = always(DESIGN)

    expect(await run(classify)).toEqual([])
    expect(classify.calls).toBe(0)
    expect(seen.transitions).toEqual([])
  })

  /**
   * The factory now comments twice per turn, not once — `announce` at the start
   * as well as `report` at the end — so the number of its own comments a card
   * carries has gone up and every one of them must stay invisible here. It is
   * account ids that decide this, not the wording, which is why a start comment
   * needs no special case: the check is "did we write it", and we did.
   *
   * Reachable in practice: a turn whose `report` comment fails to post still
   * transitions the card, which can land it in Blocked on architect with the
   * factory's own start comment as the newest thing on it.
   */
  it('ignores its own "turn started" ping, which it now leaves on every turn', async () => {
    const board: Board = {
      cards: {
        'DF-3': {
          status: 'Blocked on architect',
          comments: [
            { id: '1', authorId: HUMAN, body: 'can you look at the spacing' },
            { id: '2', authorId: FACTORY, body: 'design turn 2 started' },
          ],
        },
      },
    }
    const seen = stub(board)
    const classify = always(DESIGN)

    expect(await run(classify)).toEqual([])
    expect(classify.calls).toBe(0)
    expect(seen.transitions).toEqual([])
    expect(seen.dispatches).toEqual([])
  })
})

describe('what triage has already read', () => {
  // Without the mark, a comment judged "no action" stays the newest comment on
  // the card forever and is re-read on every pass for the life of the card.
  it('ignores a comment it has already considered', async () => {
    const board: Board = {
      cards: {
        'DF-3': {
          status: 'Blocked on engineer',
          comments: [{ id: '7', authorId: HUMAN, body: 'nice one' }],
          mark: '7',
        },
      },
    }
    stub(board)
    const classify = always(NONE)

    expect(await run(classify)).toEqual([])
    expect(classify.calls).toBe(0)
  })

  it('reads a comment newer than the one it last considered', async () => {
    const board: Board = {
      cards: {
        'DF-3': {
          status: 'Blocked on engineer',
          comments: [
            { id: '7', authorId: HUMAN, body: 'nice one' },
            { id: '8', authorId: HUMAN, body: 'actually the button does nothing' },
          ],
          mark: '7',
        },
      },
    }
    stub(board)
    const classify = always(BUILD)

    const [outcome] = await run(classify)
    expect(classify.calls).toBe(1)
    expect(outcome?.action).toBe('build')
  })
})
