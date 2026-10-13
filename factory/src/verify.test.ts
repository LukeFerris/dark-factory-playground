import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ghRunner, setRunner, type Runner } from './github.ts'
import {
  MAX_RETRIES,
  decide,
  failureReport,
  readChecks,
  readVerdict,
  requiredChecks,
  verify,
  verifyWorkflows,
  writeVerdict,
  type Verdict,
} from './verify.ts'

const SHA = 'b'.repeat(40)
const FAST = { settleMs: 0, gapMs: 0, budgetMs: 50 }

interface Repo {
  rules?: unknown[]
  classic?: unknown
  runs?: unknown[] | (() => unknown[])
  statuses?: unknown[]
  logs?: Record<number, string>
  /** Workflows the repository has. Dispatching any other fails, as `gh` does. */
  workflows?: string[]
}

let calls: string[][]
let tokens: Array<string | undefined>
const repository = process.env['GITHUB_REPOSITORY']
beforeEach(() => {
  calls = []
  tokens = []
  process.env['GITHUB_REPOSITORY'] = 'o/r'
})
afterEach(() => {
  setRunner(ghRunner)
  if (repository === undefined) delete process.env['GITHUB_REPOSITORY']
  else process.env['GITHUB_REPOSITORY'] = repository
})

/** A stand-in for `gh`, answering the calls `verify` makes. */
function stub(repo: Repo): void {
  const workflows = new Set(repo.workflows ?? ['e2e.yml'])
  const runner: Runner = (args, _input, env) => {
    calls.push(args)
    tokens.push(env?.['GH_TOKEN'])
    const ok = (out: unknown) => ({
      status: 0,
      stdout: typeof out === 'string' ? out : JSON.stringify(out),
      stderr: '',
    })
    if (args[0] === 'pr' && args[1] === 'view') return ok({ headRefName: 'card/DF-1-thing' })
    if (args[0] === 'workflow' && args[1] === 'run') {
      return workflows.has(args[2] ?? '')
        ? ok('')
        : { status: 1, stdout: '', stderr: `could not find any workflows named ${args[2]}` }
    }
    const path = args[1] ?? ''
    if (path.endsWith('/rules/branches/main')) return ok(repo.rules ?? [])
    if (path.endsWith('/branches/main')) return ok(repo.classic ?? { protection: { enabled: false } })
    if (path.includes('/check-runs')) {
      return ok(typeof repo.runs === 'function' ? repo.runs() : (repo.runs ?? []))
    }
    if (path.endsWith('/status?per_page=100')) return ok(repo.statuses ?? [])
    const log = /actions\/jobs\/(\d+)\/logs$/.exec(path)
    if (log !== null) return ok(repo.logs?.[Number(log[1])] ?? '')
    return { status: 1, stdout: '', stderr: `unexpected: ${args.join(' ')}` }
  }
  setRunner(runner)
}

const rule = (...contexts: string[]) => ({
  type: 'required_status_checks',
  parameters: { required_status_checks: contexts.map((context) => ({ context })) },
})

const run = (id: number, name: string, status: string, conclusion: string | null, over = {}) => ({
  id,
  name,
  status,
  conclusion,
  html_url: `https://github.com/o/r/runs/${id}`,
  app: { slug: 'github-actions' },
  ...over,
})

describe('the checks main requires', () => {
  it('come from rulesets and classic protection both, once each', () => {
    stub({
      rules: [rule('ci', 'E2E Tests (Playwright)'), { type: 'pull_request' }],
      classic: { protection: { required_status_checks: { contexts: ['ci', 'legacy'], checks: [{ context: 'app' }] } } },
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
    stub({ runs: [run(1, 'e2e', 'completed', 'skipped'), run(2, 'e2e', 'in_progress', null)] })
    expect(readChecks(SHA, ['e2e'])[0]).toMatchObject({ state: 'pending' })
  })

  it('counts success, neutral and skipped as passing, as branch protection does', () => {
    stub({
      runs: [
        run(1, 'a', 'completed', 'success'),
        run(2, 'b', 'completed', 'neutral'),
        run(3, 'c', 'completed', 'skipped'),
        run(4, 'd', 'completed', 'cancelled'),
      ],
    })
    expect(readChecks(SHA, ['a', 'b', 'c', 'd']).map((c) => c.state)).toEqual(['pass', 'pass', 'pass', 'fail'])
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
      runs: () => (++polls < 3 ? [run(1, 'ci', 'in_progress', null)] : [run(1, 'ci', 'completed', 'success')]),
    })
    const verdict = await verify({ pr: 7, sha: SHA, ...FAST, budgetMs: 10_000 })
    expect(verdict.outcome).toBe('green')
    expect(polls).toBe(3)
  })

  it('is red when everything has finished and something failed', async () => {
    stub({ rules: [rule('ci', 'e2e')], runs: [run(1, 'ci', 'completed', 'success'), run(2, 'e2e', 'completed', 'failure')] })
    const verdict = await verify({ pr: 7, sha: SHA, ...FAST })
    expect(verdict.outcome).toBe('red')
    expect(verdict.checks.find((c) => c.name === 'e2e')?.state).toBe('fail')
  })

  it('waits for the rest when one has already failed, so the next turn sees all of it', async () => {
    let polls = 0
    stub({
      rules: [rule('ci', 'e2e')],
      runs: () => [
        run(1, 'ci', 'completed', 'failure'),
        ++polls < 2 ? run(2, 'e2e', 'in_progress', null) : run(2, 'e2e', 'completed', 'failure'),
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

  it("dispatches each workflow on the pull request's branch, with its number", async () => {
    stub({ rules: [rule('ci')], runs: [run(1, 'ci', 'completed', 'success')], workflows: ['e2e.yml', 'slow.yml'] })
    await verify({ pr: 7, sha: SHA, ...FAST, workflows: ['e2e.yml', 'slow.yml'] })
    expect(calls.filter((c) => c[0] === 'workflow')).toEqual([
      ['workflow', 'run', 'e2e.yml', '--repo', 'o/r', '--ref', 'card/DF-1-thing', '-f', 'pr=7'],
      ['workflow', 'run', 'slow.yml', '--repo', 'o/r', '--ref', 'card/DF-1-thing', '-f', 'pr=7'],
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

  it('does not take a run skipped before it asked as passing, and waits for the one it started', async () => {
    let polls = 0
    const before = { completed_at: '2026-01-01T00:00:00Z' }
    stub({
      rules: [rule('e2e')],
      runs: () =>
        ++polls < 3
          ? [run(1, 'e2e', 'completed', 'skipped', before)]
          : [run(1, 'e2e', 'completed', 'skipped', before), run(2, 'e2e', 'completed', 'failure', { completed_at: new Date().toISOString() })],
    })
    const verdict = await verify({ pr: 7, sha: SHA, ...FAST, budgetMs: 10_000, workflows: ['e2e.yml'] })
    expect(verdict.outcome).toBe('red')
    expect(polls).toBe(3)
  })

  it('takes a run skipped after it asked as passing, as when the change is nothing the suite looks at', async () => {
    stub({ rules: [rule('e2e')], runs: () => [run(2, 'e2e', 'completed', 'skipped', { completed_at: new Date(Date.now() + 1000).toISOString() })] })
    expect((await verify({ pr: 7, sha: SHA, ...FAST, workflows: ['e2e.yml'] })).outcome).toBe('green')
  })

  it('times out, calling the old skip stale, when what it started never reports', async () => {
    stub({ rules: [rule('e2e')], runs: [run(1, 'e2e', 'completed', 'skipped', { completed_at: '2026-01-01T00:00:00Z' })] })
    const verdict = await verify({ pr: 7, sha: SHA, ...FAST, workflows: ['e2e.yml'] })
    expect(verdict.outcome).toBe('timeout')
    expect(verdict.checks[0]?.state).toBe('stale')
  })

  it('carries on when a workflow cannot be started, and lets the wait say so', async () => {
    stub({ rules: [rule('ci')], runs: [run(1, 'ci', 'completed', 'success')], workflows: [] })
    expect((await verify({ pr: 7, sha: SHA, ...FAST, workflows: ['gone.yml'] })).outcome).toBe('green')
  })

  it("reads the checks with GH_CHECKS_TOKEN, and leaves the dispatch to the App's own token", async () => {
    process.env['GH_CHECKS_TOKEN'] = 'read-only'
    try {
      stub({ rules: [rule('ci')], runs: [run(1, 'ci', 'completed', 'success')] })
      await verify({ pr: 7, sha: SHA, ...FAST, workflows: ['e2e.yml'] })
    } finally {
      delete process.env['GH_CHECKS_TOKEN']
    }
    expect(calls.some((c) => c[0] === 'workflow')).toBe(true)
    calls.forEach((args, i) => {
      expect(tokens[i]).toBe(args[0] === 'api' ? 'read-only' : undefined)
    })
  })

  it('is green at once, and starts nothing, when main requires no checks', async () => {
    stub({})
    expect(await verify({ pr: 7, sha: SHA, ...FAST, workflows: ['e2e.yml'] })).toEqual({ outcome: 'green', sha: SHA, checks: [] })
    expect(calls.some((c) => c[0] === 'workflow' || c[0] === 'pr')).toBe(false)
  })
})

describe('the verdict on disk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'verify-'))

  it('round-trips', () => {
    const verdict: Verdict = { outcome: 'red', sha: SHA, checks: [{ name: 'ci', state: 'fail', conclusion: 'failure', url: null }] }
    writeVerdict(verdict, join(dir, 'v.json'))
    expect(readVerdict(join(dir, 'v.json'))).toEqual(verdict)
  })

  it('is null when there is none, or it is not a verdict', () => {
    expect(readVerdict(join(dir, 'nothing.json'))).toBeNull()
    writeFileSync(join(dir, 'odd.json'), '{"outcome":"maybe","checks":[]}')
    expect(readVerdict(join(dir, 'odd.json'))).toBeNull()
  })
})

describe('what the factory does with a verdict', () => {
  const verdict = (outcome: Verdict['outcome']): Verdict => ({ outcome, sha: SHA, checks: [] })

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

describe('the failure report the next turn reads', () => {
  it("gives the end of a failed Actions job's log, without the timestamps", () => {
    const log = Array.from({ length: 200 }, (_, i) => `2026-10-13T10:00:00.1234567Z line ${i}`).join('\n')
    stub({ rules: [rule('ci')], runs: [run(41, 'ci', 'completed', 'failure')], logs: { 41: log } })
    const text = failureReport(SHA).join('\n')
    expect(text).toContain('### ci — failure')
    expect(text).toContain('line 199')
    expect(text).not.toContain('line 100\n')
    expect(text).not.toContain('2026-10-13T')
  })

  it('gives what a check from another app said of itself', () => {
    stub({
      rules: [rule('Datadog')],
      runs: [run(9, 'Datadog', 'completed', 'failure', { app: { slug: 'datadog' }, output: { title: 'Path traversal', summary: 'in x.ts' } })],
    })
    expect(failureReport(SHA).join('\n')).toContain('Path traversal\n\nin x.ts')
  })

  it('is empty when nothing required is failing', () => {
    stub({ rules: [rule('ci')], runs: [run(1, 'ci', 'completed', 'success')] })
    expect(failureReport(SHA)).toEqual([])
  })
})
