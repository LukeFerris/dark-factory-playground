import { describe, expect, it } from 'vitest'
import {
  ORPHAN_GRACE_MS,
  holdFrom,
  isStopCommand,
  releaseOrphans,
  returnStatus,
  takeCard,
} from './lock.ts'
import { ANA, FACTORY, LUKE, comment, move, stub, type Card } from './lock.stub.ts'
import { cfg, useFakes } from './jira.stub.ts'

useFakes()

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
