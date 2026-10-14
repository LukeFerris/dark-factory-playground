import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  MAX_RETRIES,
  decide,
  readChecks,
  readVerdict,
  requiredChecks,
  verify,
  verifyWorkflows,
  writeVerdict,
  type Verdict,
} from './verify.ts'
import { FAST, SHA, calls, failing, rule, run, stub, tokens, useStubGh } from './verify.stub.ts'

useStubGh()

describe('the checks main requires', () => {
  it('come from rulesets and classic protection both, once each', () => {
    stub({
      rules: [rule('ci', 'E2E Tests (Playwright)'), { type: 'pull_request' }],
      classic: {
        protection: {
          required_status_checks: { contexts: ['ci', 'legacy'], checks: [{ context: 'app' }] },
        },
      },
    })
    expect(requiredChecks()).toEqual(['E2E Tests (Playwright)', 'app', 'ci', 'legacy'])
  })

  it('are none when main has no protection', () => {
    stub({})
    expect(requiredChecks()).toEqual([])
  })
})

describe('where each check stands', () => {
  it('takes the newest run of a name, so a skipped draft run cannot stand for the one verify started', () => {
    stub({ runs: [run(1, 'e2e', 'skipped'), run(2, 'e2e', 'in_progress')] })
    expect(readChecks(SHA, ['e2e'])[0]).toMatchObject({ state: 'pending' })
  })

  it('counts success, neutral and skipped as passing, as branch protection does', () => {
    stub({
      runs: [
        run(1, 'a', 'success'),
        run(2, 'b', 'neutral'),
        run(3, 'c', 'skipped'),
        run(4, 'd', 'cancelled'),
      ],
    })
    expect(readChecks(SHA, ['a', 'b', 'c', 'd']).map((c) => c.state)).toEqual([
      'pass',
      'pass',
      'pass',
      'fail',
    ])
  })

  it('falls back to commit statuses, and calls a check nobody reported missing', () => {
    stub({
      statuses: [
        { context: 'Datadog', state: 'failure', target_url: 'https://dd/1' },
        { context: 'Other', state: 'pending', target_url: null },
      ],
    })
    expect(readChecks(SHA, ['Datadog', 'Other', 'Nobody'])).toEqual([
      { name: 'Datadog', state: 'fail', conclusion: 'failure', url: 'https://dd/1' },
      { name: 'Other', state: 'pending', conclusion: 'pending', url: null },
      { name: 'Nobody', state: 'missing', conclusion: null, url: null },
    ])
  })
})

describe('verify', () => {
  it('is green once every required check has passed, and waits for the ones still running', async () => {
    let polls = 0
    stub({
      rules: [rule('ci')],
      runs: () => (++polls < 3 ? [run(1, 'ci', 'in_progress')] : [run(1, 'ci', 'success')]),
    })
    const verdict = await verify({ pr: 7, sha: SHA, ...FAST, budgetMs: 10_000 })
    expect(verdict.outcome).toBe('green')
    expect(polls).toBe(3)
  })

  it('is red when everything has finished and something failed', async () => {
    stub({
      rules: [rule('ci', 'e2e')],
      runs: [run(1, 'ci', 'success'), run(2, 'e2e', 'failure')],
    })
    const verdict = await verify({ pr: 7, sha: SHA, ...FAST })
    expect(verdict.outcome).toBe('red')
    expect(verdict.checks.find((c) => c.name === 'e2e')?.state).toBe('fail')
  })

  it('waits for the rest when one has already failed, so the next turn sees all of it', async () => {
    let polls = 0
    stub({
      rules: [rule('ci', 'e2e')],
      runs: () => [
        run(1, 'ci', 'failure'),
        ++polls < 2 ? run(2, 'e2e', 'in_progress') : run(2, 'e2e', 'failure'),
      ],
    })
    const verdict = await verify({ pr: 7, sha: SHA, ...FAST, budgetMs: 10_000 })
    expect(verdict.outcome).toBe('red')
    expect(verdict.checks.map((c) => c.state)).toEqual(['fail', 'fail'])
  })

  it('times out on a check that never reports', async () => {
    stub({ rules: [rule('ci')] })
    expect((await verify({ pr: 7, sha: SHA, ...FAST })).outcome).toBe('timeout')
  })
})

describe('the workflows verify dispatches', () => {
  it("dispatches each workflow on the pull request's branch, with its number", async () => {
    stub({
      rules: [rule('ci')],
      runs: [run(1, 'ci', 'success')],
      workflows: ['e2e.yml', 'slow.yml'],
    })
    await verify({ pr: 7, sha: SHA, ...FAST, workflows: ['e2e.yml', 'slow.yml'] })
    expect(calls.filter((c) => c[0] === 'workflow')).toEqual([
      [
        'workflow',
        'run',
        'e2e.yml',
        '--repo',
        'o/r',
        '--ref',
        'card/DF-1-thing',
        '-f',
        'pr=7',
        '-f',
        'tag=verify-55-1',
      ],
      [
        'workflow',
        'run',
        'slow.yml',
        '--repo',
        'o/r',
        '--ref',
        'card/DF-1-thing',
        '-f',
        'pr=7',
        '-f',
        'tag=verify-55-1',
      ],
    ])
  })

  it('takes its workflows from FACTORY_VERIFY_WORKFLOWS', () => {
    process.env['FACTORY_VERIFY_WORKFLOWS'] = ' e2e-tests.yml, ,slow.yml '
    try {
      expect(verifyWorkflows()).toEqual(['e2e-tests.yml', 'slow.yml'])
    } finally {
      delete process.env['FACTORY_VERIFY_WORKFLOWS']
    }
    expect(verifyWorkflows()).toEqual([])
  })
})

describe('a run verify did not start', () => {
  it('does not take a run skipped before it asked as passing, and waits for the one it started', async () => {
    let polls = 0
    const before = { completed_at: '2026-01-01T00:00:00Z' }
    stub({
      rules: [rule('e2e')],
      runs: () =>
        ++polls < 3
          ? [run(1, 'e2e', 'skipped', before)]
          : [
              run(1, 'e2e', 'skipped', before),
              run(2, 'e2e', 'failure', { completed_at: new Date().toISOString() }),
            ],
    })
    const verdict = await verify({
      pr: 7,
      sha: SHA,
      ...FAST,
      budgetMs: 10_000,
      workflows: ['e2e.yml'],
    })
    expect(verdict.outcome).toBe('red')
    expect(polls).toBe(3)
  })

  it('takes a run skipped after it asked as passing, as when the change is nothing the suite looks at', async () => {
    stub({
      rules: [rule('e2e')],
      runs: () => [
        run(2, 'e2e', 'skipped', {
          completed_at: new Date(Date.now() + 1000).toISOString(),
        }),
      ],
    })
    expect((await verify({ pr: 7, sha: SHA, ...FAST, workflows: ['e2e.yml'] })).outcome).toBe(
      'green',
    )
  })

  it('times out, calling the old skip stale, when what it started never reports', async () => {
    stub({
      rules: [rule('e2e')],
      runs: [run(1, 'e2e', 'skipped', { completed_at: '2026-01-01T00:00:00Z' })],
    })
    const verdict = await verify({ pr: 7, sha: SHA, ...FAST, workflows: ['e2e.yml'] })
    expect(verdict.outcome).toBe('timeout')
    expect(verdict.checks[0]?.state).toBe('stale')
  })

  it('carries on when a workflow cannot be started, and does not call it green', async () => {
    stub({
      rules: [rule('ci')],
      runs: [run(1, 'ci', 'success')],
      workflows: ['e2e.yml'],
    })
    const verdict = await verify({ pr: 7, sha: SHA, ...FAST, workflows: ['gone.yml', 'e2e.yml'] })
    expect(verdict.outcome).toBe('timeout')
    expect(verdict.workflows.map((r) => r.state)).toEqual(['missing', 'pass'])
  })
})

describe('what verify reads checks with, and when main requires none', () => {
  it("reads the checks with GH_CHECKS_TOKEN, and leaves the dispatch to the App's own token", async () => {
    process.env['GH_CHECKS_TOKEN'] = 'read-only'
    try {
      stub({ rules: [rule('ci')], runs: [run(1, 'ci', 'success')] })
      await verify({ pr: 7, sha: SHA, ...FAST, workflows: ['e2e.yml'] })
    } finally {
      delete process.env['GH_CHECKS_TOKEN']
    }
    expect(calls.some((c) => c[0] === 'workflow')).toBe(true)
    expect(calls.some((c) => c[0] === 'run')).toBe(true)
    calls.forEach((args, i) => {
      expect(tokens[i]).toBe(args[0] === 'workflow' || args[0] === 'pr' ? undefined : 'read-only')
    })
  })

  it('is green at once, and starts nothing, when main requires no checks and nothing is dispatched', async () => {
    stub({})
    expect(await verify({ pr: 7, sha: SHA, ...FAST, workflows: [] })).toEqual({
      outcome: 'green',
      sha: SHA,
      checks: [],
      workflows: [],
    })
    expect(calls.some((c) => c[0] === 'workflow' || c[0] === 'pr')).toBe(false)
  })

  it('still waits for what it dispatched when main requires no checks', async () => {
    stub({ outcome: failing({ failed: ['t1'], errors: 0 }) })
    const verdict = await verify({ pr: 7, sha: SHA, ...FAST, workflows: ['e2e.yml'] })
    expect(verdict.outcome).toBe('red')
    expect(verdict.workflows[0]).toMatchObject({
      workflow: 'e2e.yml',
      state: 'fail',
      failed: ['t1'],
    })
  })
})

describe('the verdict on disk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'verify-'))

  it('round-trips', () => {
    const verdict: Verdict = {
      outcome: 'red',
      sha: SHA,
      checks: [{ name: 'ci', state: 'fail', conclusion: 'failure', url: null }],
      workflows: [],
    }
    writeVerdict(verdict, join(dir, 'v.json'))
    expect(readVerdict(join(dir, 'v.json'))).toEqual(verdict)
  })

  it('is null when there is none, or it is not a verdict', () => {
    expect(readVerdict(join(dir, 'nothing.json'))).toBeNull()
    writeFileSync(join(dir, 'odd.json'), '{"outcome":"maybe","checks":[]}')
    expect(readVerdict(join(dir, 'odd.json'))).toBeNull()
  })

  it('reads one written before there were workflows as having none', () => {
    writeFileSync(join(dir, 'old.json'), JSON.stringify({ outcome: 'green', sha: SHA, checks: [] }))
    expect(readVerdict(join(dir, 'old.json'))?.workflows).toEqual([])
  })
})

describe('what the factory does with a verdict', () => {
  const verdict = (outcome: Verdict['outcome']): Verdict => ({
    outcome,
    sha: SHA,
    checks: [],
    workflows: [],
  })

  it('hands a green turn over', () => {
    expect(decide(verdict('green'), 0)).toEqual({ action: 'ready' })
    expect(decide(verdict('green'), MAX_RETRIES)).toEqual({ action: 'ready' })
  })

  it(`starts another turn on red, ${MAX_RETRIES} times, then asks a person`, () => {
    expect(decide(verdict('red'), 0)).toEqual({ action: 'retry', next: 1 })
    expect(decide(verdict('red'), MAX_RETRIES - 1)).toEqual({ action: 'retry', next: MAX_RETRIES })
    expect(decide(verdict('red'), MAX_RETRIES)).toMatchObject({ action: 'blocked' })
  })

  it('asks a person when the checks did not finish, or could not be read', () => {
    expect(decide(verdict('timeout'), 0)).toMatchObject({ action: 'blocked' })
    expect(decide(null, 0)).toMatchObject({ action: 'blocked' })
  })
})
