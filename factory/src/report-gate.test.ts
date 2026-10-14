import { describe, expect, it } from 'vitest'
import { textOf } from './jira.stub.ts'
import { targetStatus } from './report.ts'
import { buildComment } from './report-comment.ts'
import { CRITERIA, NO_LINKS, result } from './report-comment.stub.ts'
import type { WorkflowResult } from './baseline.ts'
import { gated, type Gate } from './report-gate.ts'
import { MAX_RETRIES } from './verify.ts'

function hrefs(node: unknown): string[] {
  if (node === null || typeof node !== 'object') return []
  const n = node as Record<string, unknown>
  const marks = Array.isArray(n['marks']) ? (n['marks'] as Array<Record<string, unknown>>) : []
  const own = marks
    .filter((m) => m['type'] === 'link')
    .map((m) => (m['attrs'] as Record<string, unknown>)['href'] as string)
  const kids = Array.isArray(n['content']) ? (n['content'] as unknown[]) : []
  return [...own, ...kids.flatMap(hrefs)]
}

const SHA = 'c0ffee0'.padEnd(40, '0')
const red: Gate['verdict'] = {
  outcome: 'red',
  sha: SHA,
  checks: [
    { name: 'ci', state: 'pass', conclusion: 'success', url: null },
    {
      name: 'E2E Tests (Playwright)',
      state: 'fail',
      conclusion: 'failure',
      url: 'https://github.com/o/r/runs/9',
    },
  ],
  workflows: [],
}
const comment = (gate: Gate) =>
  buildComment('build', result({ acceptance_criteria: CRITERIA }), { ...NO_LINKS, gate })

describe('the gate on a finished build', () => {
  it('stands only between a build that says it is done and In review', () => {
    expect(gated('build', result({ status: 'ready_for_review' }))).toBe(true)
    expect(gated('design', result({ status: 'ready_for_review' }))).toBe(false)
    for (const status of ['continue', 'blocked', 'question', 'failed'] as const) {
      expect(gated('build', result({ status }))).toBe(false)
    }
  })

  it('sends a green build to In review, and says the checks passed', () => {
    const gate: Gate = {
      decision: { action: 'ready' },
      verdict: {
        outcome: 'green',
        sha: SHA,
        checks: red!.checks.map((c) => ({ ...c, state: 'pass' as const })),
        workflows: [],
      },
    }
    expect(targetStatus('build', result(), gate)).toBe('In review')
    const text = textOf(comment(gate))
    expect(text).toContain('ready for review')
    expect(text).toContain('All 2 passed on commit c0ffee0')
    expect(text).toContain('approve and merge the pull request')
  })

  it('says so when main requires no checks at all', () => {
    const gate: Gate = {
      decision: { action: 'ready' },
      verdict: { outcome: 'green', sha: SHA, checks: [], workflows: [] },
    }
    expect(textOf(comment(gate))).toContain('Main requires none.')
  })

  it('keeps a red build in Building, lists what failed, and says another turn has started', () => {
    const gate: Gate = { decision: { action: 'retry', next: 1 }, verdict: red }
    expect(targetStatus('build', result(), gate)).toBeNull()
    const doc = comment(gate)
    const text = textOf(doc)
    expect(text).toContain('checks failed, trying again')
    expect(text).toContain('E2E Tests (Playwright)')
    expect(text).not.toContain('ci —')
    expect(text).toContain(`automatic turn 1 of ${MAX_RETRIES}`)
    expect(text).not.toContain('approve and merge')
    expect(hrefs(doc)).toContain('https://github.com/o/r/runs/9')
  })

  it('sends a build that is still red to Blocked on engineer, with the reason', () => {
    const gate: Gate = {
      decision: { action: 'blocked', why: 'Still failing after 2.' },
      verdict: red,
    }
    expect(targetStatus('build', result(), gate)).toBe('Blocked on engineer')
    const text = textOf(comment(gate))
    expect(text).toContain('checks not passing')
    expect(text).toContain('Still failing after 2.')
    expect(text).toContain('stays a draft')
  })
})

const workflow = (over: Partial<WorkflowResult>): WorkflowResult => ({
  workflow: 'e2e-tests.yml',
  state: 'pass',
  conclusion: 'success',
  url: 'https://github.com/o/r/actions/runs/100',
  failed: [],
  excused: [],
  baseline: null,
  note: null,
  ...over,
})

describe('what the gate says of the workflows verify dispatched (ADR 0010)', () => {
  it('counts them among what passed', () => {
    const gate: Gate = {
      decision: { action: 'ready' },
      verdict: { outcome: 'green', sha: SHA, checks: [], workflows: [workflow({})] },
    }
    expect(textOf(comment(gate))).toContain('All 1 passed on commit c0ffee0')
  })

  it("lists a workflow's own failures, and those main has too with their cards", () => {
    const gate: Gate = {
      decision: { action: 'retry', next: 1 },
      verdict: {
        outcome: 'red',
        sha: SHA,
        checks: [],
        workflows: [
          workflow({
            state: 'fail',
            conclusion: 'failure',
            failed: ['b'],
            excused: ['a'],
            baseline: { sha: 'm'.repeat(40), url: null },
          }),
        ],
      },
      raised: [{ workflow: 'e2e-tests.yml', test: 'a', key: 'DF-50', created: true }],
    }
    const doc = comment(gate)
    const text = textOf(doc)
    expect(text).toContain('e2e-tests.yml')
    expect(text).toContain('1 test(s) failed that pass on main: b')
    expect(text).toContain('Failing on main as well, so not held against this card:')
    expect(text).toContain('a  — DF-50')
    expect(hrefs(doc)).toContain('https://github.com/o/r/actions/runs/100')
  })
})

describe('what the gate says of the workflows verify dispatched, when main fails them too', () => {
  it('hands over a build whose only failures main has too, and says which they are', () => {
    const gate: Gate = {
      decision: { action: 'ready' },
      verdict: {
        outcome: 'green',
        sha: SHA,
        checks: [],
        workflows: [workflow({ state: 'excused', conclusion: 'failure', excused: ['a'] })],
      },
    }
    const text = textOf(comment(gate))
    expect(text).toContain('All 1 passed on commit c0ffee0')
    expect(text).toContain('a  — no card raised')
  })

  it('says a workflow that could not be started could not be', () => {
    const gate: Gate = {
      decision: { action: 'blocked', why: 'x' },
      verdict: {
        outcome: 'timeout',
        sha: SHA,
        checks: [],
        workflows: [workflow({ state: 'missing', conclusion: null, url: null })],
      },
    }
    expect(textOf(comment(gate))).toContain('e2e-tests.yml  — could not be started')
  })
})

describe('what the gate says of checks that did not pass', () => {
  // A check can fail to pass without failing: these say what it did instead.
  it('says what a check that never finished did', () => {
    const gate: Gate = {
      decision: { action: 'blocked', why: 'Timed out.' },
      verdict: {
        outcome: 'timeout',
        sha: SHA,
        checks: [
          { name: 'slow', state: 'pending', conclusion: null, url: '' },
          { name: 'absent', state: 'missing', conclusion: null, url: null },
          { name: 'skipped', state: 'stale', conclusion: 'skipped', url: null },
          { name: 'odd', state: 'fail', conclusion: null, url: null },
        ],
        workflows: [],
      },
    }
    const text = textOf(comment(gate), '')
    expect(text).toContain('slow — still running')
    expect(text).toContain('absent — never reported')
    expect(text).toContain('skipped — skipped on the push, and never run again when asked')
    expect(text).toContain('odd — failed')
  })

  it('says so when the checks could not be read at all', () => {
    const gate: Gate = {
      decision: { action: 'blocked', why: 'Could not read them.' },
      verdict: null,
    }
    expect(textOf(comment(gate))).toContain('The factory could not read them.')
  })
})
