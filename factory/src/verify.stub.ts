import { afterEach, beforeEach } from 'vitest'
import { ghRunner, setRunner, type Runner } from './github.ts'

/**
 * A stand-in for `gh` that answers the calls `verify` makes, from a
 * description of the repository, for the tests of `verify.ts`.
 *
 * Not a test file itself, so the tests that use it are what cover it.
 */

export interface Repo {
  rules?: unknown[]
  classic?: unknown
  runs?: unknown[] | (() => unknown[])
  statuses?: unknown[]
  logs?: Record<number, string>
  /** Workflows the repository has. Dispatching any other fails, as `gh` does. */
  workflows?: string[]
}

/** Every call the stand-in `gh` answered, and the token it was given, in order. */
export const calls: string[][] = []
export const tokens: Array<string | undefined> = []
const repository = process.env['GITHUB_REPOSITORY']

/** Puts `gh` and the repository back after each test of the file that calls it. */
export function useStubGh(): void {
  beforeEach(() => {
    calls.length = 0
    tokens.length = 0
    process.env['GITHUB_REPOSITORY'] = 'o/r'
  })
  afterEach(() => {
    setRunner(ghRunner)
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

function runsOf(repo: Repo): unknown {
  return typeof repo.runs === 'function' ? repo.runs() : (repo.runs ?? [])
}

/** What the stand-in `gh` says to an `api` call, or `null` to one it was not expecting. */
function apiAnswer(repo: Repo, path: string): Answer | null {
  if (path.endsWith('/rules/branches/main')) return ok(repo.rules ?? [])
  if (path.endsWith('/branches/main')) return ok(repo.classic ?? { protection: { enabled: false } })
  if (path.includes('/check-runs')) return ok(runsOf(repo))
  if (path.endsWith('/status?per_page=100')) return ok(repo.statuses ?? [])
  const log = /actions\/jobs\/(\d+)\/logs$/.exec(path)
  return log === null ? null : ok(repo.logs?.[Number(log[1])] ?? '')
}

/** A stand-in for `gh`, answering the calls `verify` makes. */
export function stub(repo: Repo): void {
  const workflows = new Set(repo.workflows ?? ['e2e.yml'])
  const runner: Runner = (args, _input, env) => {
    calls.push(args)
    tokens.push(env?.['GH_TOKEN'])
    if (args[0] === 'pr' && args[1] === 'view') return ok({ headRefName: 'card/DF-1-thing' })
    if (args[0] === 'workflow' && args[1] === 'run') {
      return workflows.has(args[2] ?? '')
        ? ok('')
        : { status: 1, stdout: '', stderr: `could not find any workflows named ${args[2]}` }
    }
    return (
      apiAnswer(repo, args[1] ?? '') ?? {
        status: 1,
        stdout: '',
        stderr: `unexpected: ${args.join(' ')}`,
      }
    )
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
