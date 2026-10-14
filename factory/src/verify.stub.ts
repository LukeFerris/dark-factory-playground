import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach } from 'vitest'
import { ghRunner, setRunner, type Runner } from './github.ts'

/**
 * A stand-in for `gh` that answers the calls `verify` makes, from a
 * description of the repository, for the tests of `verify.ts`. Workflows it is
 * asked to dispatch run at once, and end as `outcome` says.
 *
 * Not a test file itself, so the tests that use it are what cover it.
 */

export const SHA = 'b'.repeat(40)
/** The pull request's merge base with main. */
export const BASE = 'm'.repeat(40)
/** Main's head, where a dispatch on main runs. */
export const MAIN_HEAD = 'f'.repeat(40)

export interface Repo {
  rules?: unknown[]
  classic?: unknown
  runs?: unknown[] | (() => unknown[])
  statuses?: unknown[]
  logs?: Record<number, string>
  /** Workflows the repository has. Dispatching any other fails, as `gh` does. */
  workflows?: string[]
  /** Workflows written before ADR 0010, which take no `tag` or baseline inputs. */
  untagged?: string[]
  /** How a dispatched run ends, and the `failed-tests.json` it leaves, if any. */
  outcome?: (
    inputs: Record<string, string>,
    ref: string,
  ) => { conclusion: string; artifact?: unknown }
  /** Failed job ids, by run. */
  jobs?: Record<number, number[]>
}

export interface FakeRun {
  databaseId: number
  displayTitle: string
  headSha: string
  status: string
  conclusion: string
  url: string
  createdAt: string
  branch: string
  workflow: string
  inputs: Record<string, string>
  artifact?: unknown
}

/** Every call the stand-in `gh` answered, and the token it was given, in order. */
export const calls: string[][] = []
export const tokens: Array<string | undefined> = []
/** The runs the stand-in's dispatches made, newest last. */
export const dispatched: FakeRun[] = []
const repository = process.env['GITHUB_REPOSITORY']

/** Puts `gh` and the environment back after each test of the file that calls it. */
export function useStubGh(): void {
  beforeEach(() => {
    calls.length = 0
    tokens.length = 0
    dispatched.length = 0
    process.env['GITHUB_REPOSITORY'] = 'o/r'
    process.env['GITHUB_RUN_ID'] = '55'
    process.env['GITHUB_RUN_ATTEMPT'] = '1'
  })
  afterEach(() => {
    setRunner(ghRunner)
    delete process.env['GITHUB_RUN_ID']
    delete process.env['GITHUB_RUN_ATTEMPT']
    if (repository === undefined) delete process.env['GITHUB_REPOSITORY']
    else process.env['GITHUB_REPOSITORY'] = repository
  })
}

type Answer = { status: number; stdout: string; stderr: string }

const ok = (out: unknown): Answer => ({
  status: 0,
  stdout: typeof out === 'string' ? out : JSON.stringify(out),
  stderr: '',
})

const fail = (stderr: string): Answer => ({ status: 1, stdout: '', stderr })

export const flag = (args: string[], name: string): string | undefined => {
  const i = args.indexOf(name)
  return i === -1 ? undefined : args[i + 1]
}

function runsOf(repo: Repo): unknown {
  return typeof repo.runs === 'function' ? repo.runs() : (repo.runs ?? [])
}

/** What the stand-in `gh` says to an `api` call, or `null` to one it was not expecting. */
function apiAnswer(repo: Repo, path: string): Answer | null {
  if (path === `repos/o/r/compare/main...${SHA}`) return ok(`${BASE}\n`)
  if (path.endsWith('/rules/branches/main')) return ok(repo.rules ?? [])
  if (path.endsWith('/branches/main')) return ok(repo.classic ?? { protection: { enabled: false } })
  if (path.includes('/check-runs')) return ok(runsOf(repo))
  if (path.endsWith('/status?per_page=100')) return ok(repo.statuses ?? [])
  const log = /actions\/jobs\/(\d+)\/logs$/.exec(path)
  return log === null ? null : ok(repo.logs?.[Number(log[1])] ?? '')
}

/** `gh workflow run`: a run that has already finished, as `outcome` says. */
function dispatch(repo: Repo, workflows: Set<string>, args: string[]): Answer {
  const workflow = args[2] ?? ''
  if (!workflows.has(workflow)) return fail(`could not find any workflows named ${workflow}`)
  const ref = flag(args, '--ref') ?? 'main'
  const inputs = Object.fromEntries(
    args.flatMap((a, i) =>
      args[i - 1] === '-f' ? [a.split(/=(.*)/s).slice(0, 2) as [string, string]] : [],
    ),
  )
  if (repo.untagged?.includes(workflow) && Object.keys(inputs).some((k) => k !== 'pr')) {
    return fail('HTTP 422: Unexpected inputs provided: ["tag"]')
  }
  const { conclusion, artifact } = repo.outcome?.(inputs, ref) ?? { conclusion: 'success' }
  const id = 100 + dispatched.length
  dispatched.push({
    databaseId: id,
    displayTitle: `E2E Tests for #${inputs['pr']}${inputs['tag'] === undefined ? '' : ` ${inputs['tag']}`}`,
    headSha: ref === 'main' ? MAIN_HEAD : SHA,
    status: 'completed',
    conclusion,
    url: `https://github.com/o/r/actions/runs/${id}`,
    createdAt: new Date().toISOString(),
    branch: ref,
    workflow,
    inputs,
    artifact,
  })
  return ok('')
}

/** `gh run …`: listing the dispatched runs, downloading one's artifact, its jobs. */
function runAnswer(repo: Repo, args: string[]): Answer | null {
  if (args[1] === 'list') {
    const branch = flag(args, '--branch')
    const commit = flag(args, '--commit')
    return ok(
      dispatched.filter(
        (r) =>
          r.workflow === flag(args, '--workflow') &&
          (branch === undefined || r.branch === branch) &&
          (commit === undefined || r.headSha === commit),
      ),
    )
  }
  if (args[1] === 'download') {
    const found = dispatched.find((r) => r.databaseId === Number(args[2]))
    if (found?.artifact === undefined) return fail('no artifact matches any of the names')
    writeFileSync(
      join(flag(args, '--dir') ?? '', 'failed-tests.json'),
      JSON.stringify(found.artifact),
    )
    return ok('')
  }
  if (args[1] === 'view') return ok(repo.jobs?.[Number(args[2])] ?? [])
  return null
}

/** A stand-in for `gh`, answering the calls `verify` makes. */
export function stub(repo: Repo): void {
  const workflows = new Set(repo.workflows ?? ['e2e.yml'])
  const runner: Runner = (args, _input, env) => {
    calls.push(args)
    tokens.push(env?.['GH_TOKEN'])
    if (args[0] === 'pr' && args[1] === 'view') return ok({ headRefName: 'card/DF-1-thing' })
    if (args[0] === 'workflow' && args[1] === 'run') return dispatch(repo, workflows, args)
    const answer = args[0] === 'run' ? runAnswer(repo, args) : apiAnswer(repo, args[1] ?? '')
    return answer ?? fail(`unexpected: ${args.join(' ')}`)
  }
  setRunner(runner)
}

export const rule = (...contexts: string[]) => ({
  type: 'required_status_checks',
  parameters: { required_status_checks: contexts.map((context) => ({ context })) },
})

/** A check run: `in_progress`, or finished with the given conclusion. */
export const run = (id: number, name: string, outcome: string, over = {}) => ({
  id,
  name,
  status: outcome === 'in_progress' ? 'in_progress' : 'completed',
  conclusion: outcome === 'in_progress' ? null : outcome,
  html_url: `https://github.com/o/r/runs/${id}`,
  app: { slug: 'github-actions' },
  ...over,
})

/** Waits that do not wait, and a budget a test can run out of. */
export const FAST = { settleMs: 0, gapMs: 0, budgetMs: 50 }

/** A suite whose run on the pull request fails `mine`, and on main fails `theirs`. */
export const failing =
  (mine: unknown, theirs?: unknown) => (_inputs: Record<string, string>, ref: string) =>
    ref === 'main'
      ? theirs === undefined
        ? { conclusion: 'success' }
        : { conclusion: 'failure', artifact: theirs }
      : { conclusion: 'failure', artifact: mine }
