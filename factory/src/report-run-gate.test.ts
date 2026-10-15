import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as GitHub from './github.ts'
import { dispatchWorkflow, markReady } from './github.ts'
import { adfToText } from './jira.ts'
import { report } from './report.ts'
import { HUMAN, card, logs, turn, useReportRun, verdict } from './report-run.stub.ts'

vi.mock('./github.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof GitHub>()),
  dispatchWorkflow: vi.fn(),
  markReady: vi.fn(),
}))

useReportRun()
// Braced: a function returned from beforeEach is run as its teardown.
beforeEach(() => {
  vi.mocked(dispatchWorkflow).mockReset()
  vi.mocked(markReady).mockReset()
})

const BLOCKED = ['In review', 'Blocked on engineer']

/** A finished build only reaches In review through main's required checks (ADR 0009). */
describe('a finished build at the gate', () => {
  it('takes a green build out of draft and moves it to In review', async () => {
    turn({}, {})
    const seen = card()

    await report({ stage: 'build' })

    expect(markReady).toHaveBeenCalledWith(20)
    expect(seen.moved).toEqual(['31'])
    expect(dispatchWorkflow).not.toHaveBeenCalled()
  })

  it('keeps a red build in Building, still the factory’s, and starts another turn', async () => {
    turn({}, {})
    verdict('red')
    const seen = card()

    await report({ stage: 'build', retry: 1 })

    expect(dispatchWorkflow).toHaveBeenCalledWith('build-turn.yml', { key: 'DF-7', retry: '2' })
    expect(markReady).not.toHaveBeenCalled()
    expect(seen.comments).toHaveLength(1)
    expect(seen.assigned).toEqual([])
    expect(seen.moved).toEqual([])
    expect(logs).toContain('report: DF-7 stays in Building; automatic turn 2 of 2 started.')
  })

  it('gives the card to a person when the next turn will not start', async () => {
    turn({}, {})
    verdict('red')
    vi.mocked(dispatchWorkflow).mockImplementation(() => {
      throw new Error('no dispatch')
    })
    const seen = card({ statuses: BLOCKED })

    await report({ stage: 'build' })

    expect(seen.comments).toHaveLength(2)
    expect(adfToText(seen.comments[1])).toContain('could not be started after all')
    expect(seen.assigned).toEqual([HUMAN])
    expect(seen.moved).toEqual(['32'])
    expect(process.exitCode).toBe(3)
  })

  it('sends a build still red after every retry to Blocked on engineer', async () => {
    turn({}, {})
    verdict('red')
    const seen = card({ statuses: BLOCKED })

    await report({ stage: 'build', retry: 2 })

    expect(dispatchWorkflow).not.toHaveBeenCalled()
    expect(adfToText(seen.comments[0])).toContain('checks not passing')
    expect(seen.assigned).toEqual([HUMAN])
    expect(seen.moved).toEqual(['32'])
  })
})

describe('a green build that cannot be handed over', () => {
  it('sends a green build to a person when its pull request will not come out of draft', async () => {
    turn({}, {})
    vi.mocked(markReady).mockImplementation(() => {
      throw new Error('gh failed')
    })
    const seen = card({ statuses: BLOCKED })

    await report({ stage: 'build' })

    expect(adfToText(seen.comments[0])).toContain('would not come out of draft: gh failed.')
    expect(seen.moved).toEqual(['32'])
  })

  it('touches nothing on a dry run', async () => {
    turn({}, {})
    const seen = card()

    await report({ stage: 'build', dryRun: true })

    expect(markReady).not.toHaveBeenCalled()
    expect(seen.moved).toEqual([])
  })
})
