import { describe, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import type * as GitHub from './github.ts'
import { adfToText } from './jira.ts'
import { report } from './report.ts'
import {
  HUMAN,
  ISSUE,
  captured,
  card,
  logs,
  server,
  turn,
  useReportRun,
} from './report-run.stub.ts'

// A green build takes its pull request out of draft, which is a `gh` call.
vi.mock('./github.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof GitHub>()),
  markReady: vi.fn(),
}))

useReportRun()

describe('reporting a finished turn', () => {
  it('comments, hands the card back, links the PR and moves it on', async () => {
    turn({}, {})
    const seen = card()

    await report({ stage: 'build' })

    const [comment] = seen.comments
    expect(comment?.content[0]?.['content']).toContainEqual({
      type: 'mention',
      attrs: { id: HUMAN },
    })
    const text = adfToText(comment)
    expect(text).toContain('build turn finished — ready for review')
    expect(JSON.stringify(comment)).toContain('https://github.com/o/r/pull/20')
    expect(JSON.stringify(comment)).toContain('https://github.com/o/r/actions/runs/99')
    expect(seen.assigned).toEqual([HUMAN])
    expect(seen.links).toEqual(['factory-pull-request'])
    expect(seen.moved).toEqual(['31'])
    expect(logs).toContain('report: DF-7 -> In review')
    expect(logs).toContain('report: evidence — nothing was captured')
    expect(process.exitCode).toBeUndefined()
  })

  it('prefers a PR URL passed in over the one in meta', async () => {
    turn({ pr: null }, {})
    const seen = card()

    await report({ stage: 'build', prUrl: 'https://github.com/x/y/pull/5' })

    expect(JSON.stringify(seen.comments[0])).toContain('https://github.com/x/y/pull/5')
  })

  it('leaves a continuing design turn where it is, but still hands it back', async () => {
    turn({ stage: 'design', pr: null }, { status: 'continue', acceptance_criteria: [] })
    const seen = card()

    await report({ stage: 'design' })

    expect(seen.comments).toHaveLength(1)
    expect(seen.assigned).toEqual([HUMAN])
    expect(seen.moved).toEqual([])
    expect(logs).toContain('report: DF-7 stays where it is (status "continue").')
  })
})

/**
 * The evidence is an enrichment. A screenshot that would not go up is not
 * marked as proved, and nothing that goes wrong with it costs the hand-off.
 */
describe('putting the evidence on the card', () => {
  it('attaches each screenshot and the walkthrough, and marks the steps it holds', async () => {
    turn({}, {})
    captured([1, 2], true)
    const seen = card()

    await report({ stage: 'build' })

    expect(seen.attached).toBe(3)
    const text = adfToText(seen.comments[0])
    expect(text).toContain('Open a deal. (in the walkthrough)')
    expect(text).toContain('Save it. (in the walkthrough)')
    expect(logs).toContain('report: evidence — attached 2/2 screenshot(s) and the walkthrough')
  })

  it('does not mark a step whose screenshot Jira refused', async () => {
    turn({}, {})
    captured([1, 2], false)
    const seen = card({ attachments: [1] })

    await report({ stage: 'build' })

    const text = adfToText(seen.comments[0])
    expect(text).toContain('Open a deal. (screenshot attached)')
    expect(text).not.toContain('Save it. (screenshot attached)')
    expect(logs).toContain('report: could not attach step 2: Jira attach to DF-7 failed: 500 no')
    expect(logs).toContain('report: evidence — attached 1/2 screenshot(s)')
    expect(seen.moved).toEqual(['31'])
  })

  it('says nothing of a walkthrough Jira would not take', async () => {
    turn({}, {})
    captured([1], true)
    const seen = card({ attachments: [1] })

    await report({ stage: 'build' })

    expect(adfToText(seen.comments[0])).not.toContain('walkthrough')
    expect(logs.some((l) => l.startsWith('report: could not attach the walkthrough:'))).toBe(true)
    expect(logs).toContain('report: evidence — attached 1/1 screenshot(s)')
  })
})

/**
 * Until DF-9 a comment Jira would not take threw, and cost the card its
 * hand-back and its transition. Now the card moves whatever the comment does.
 */
describe('when Jira will not take the comment', () => {
  it('posts the plain fallback instead, and still moves the card', async () => {
    turn({}, {})
    const seen = card({ comments: 1 })

    await report({ stage: 'build' })

    expect(adfToText(seen.comments[0])).toContain('Jira would not accept the full comment')
    expect(logs).toContain('report: posted the plain-text fallback instead.')
    expect(seen.moved).toEqual(['31'])
    expect(process.exitCode).toBe(3)
  })

  it('still hands back and moves the card when the fallback fails too', async () => {
    turn({}, {})
    const seen = card({ comments: 2 })

    await report({ stage: 'build' })

    expect(seen.comments).toEqual([])
    expect(logs.some((l) => l.startsWith('report: the fallback failed too:'))).toBe(true)
    expect(seen.assigned).toEqual([HUMAN])
    expect(seen.moved).toEqual(['31'])
  })
})

describe('when the card cannot move', () => {
  // The comment is already on the card, so a re-run would double it.
  it('fails the run loudly but does not throw on a missing transition', async () => {
    turn({}, {})
    const seen = card({ statuses: ['Backlog'] })

    await expect(report({ stage: 'build' })).resolves.toBeUndefined()

    expect(seen.moved).toEqual([])
    expect(process.exitCode).toBe(3)
    expect(logs).toContain(
      'report: could not move DF-7 to In review: DF-7 has no transition to "In review". ' +
        'Available: Backlog',
    )
  })

  it('throws anything that is not a missing transition', async () => {
    turn({}, {})
    card()
    server.use(http.get(`${ISSUE}/transitions`, () => new HttpResponse('down', { status: 500 })))

    await expect(report({ stage: 'build' })).rejects.toThrow()
  })
})

describe('a dry run', () => {
  it('prints what it would post and writes nothing', async () => {
    turn({}, {})
    captured([1, 2], true)
    const seen = card()

    await report({ stage: 'build', dryRun: true })

    expect(seen).toEqual({ comments: [], attached: 0, assigned: [], links: [], moved: [] })
    expect(logs).toContain('report --dry-run: would attach 2 screenshot(s) and the walkthrough')
    expect(logs).toContain('report --dry-run: would move DF-7 to In review')
    expect(logs.some((l) => l.includes('(in the walkthrough)'))).toBe(true)
  })

  it('says so when there was nothing captured to attach', async () => {
    turn({}, {})
    captured([], false)
    card()

    await report({ stage: 'build', dryRun: true })

    expect(logs).toContain('report --dry-run: nothing was captured')
  })

  it('names screenshots alone when there is no walkthrough', async () => {
    turn({}, {})
    captured([1], false)
    card()

    await report({ stage: 'build', dryRun: true })

    expect(logs).toContain('report --dry-run: would attach 1 screenshot(s)')
  })
})
