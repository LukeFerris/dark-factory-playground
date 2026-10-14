import { describe, expect, it } from 'vitest'
import { TRIAGE_PROPERTY } from './triage.ts'
import { stop } from './lock.ts'
import { FACTORY, LUKE, comment, move, stub, type Card, type FakeRun } from './lock.stub.ts'
import { cfg, useFakes } from './jira.stub.ts'

useFakes()

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
})

describe('stopping a turn: whose runs, and racing them', () => {
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
})

describe('stopping a turn: when not to', () => {
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
