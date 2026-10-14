import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gh, ghJson, repoSlug } from './github.ts'

/**
 * The runs `verify` dispatches, as `gh` sees them: found by the tag in their
 * names, their `failed-tests` artifacts read, their failed jobs listed. Every
 * call here is a read, with the reader's token.
 */

/**
 * The token everything here reads with: `GH_CHECKS_TOKEN` when it is set, which
 * in the workflows is the job's own GITHUB_TOKEN granted `checks`, `statuses`
 * and `actions` read. The App is given none of those. It needs none of them
 * for anything else, and everything here is a read, which GITHUB_TOKEN does as
 * well as the App does. Writes, the dispatch and the draft, stay with the App.
 */
export function reader(): Record<string, string> | undefined {
  const token = process.env['GH_CHECKS_TOKEN']
  return token === undefined || token === '' ? undefined : { GH_TOKEN: token }
}

/** What branch protection itself accepts as passing. */
export const PASSING = new Set(['success', 'neutral', 'skipped'])

export interface Run {
  databaseId: number
  displayTitle: string
  headSha: string
  status: string
  conclusion: string | null
  url: string
  createdAt: string
}

/** What a verify workflow's `failed-tests` artifact holds. */
export interface FailedTests {
  /** Test ids, opaque to the factory: whatever the workflow can run again. */
  failed: string[]
  /** Failures outside any test: a spec that would not load, a setup that threw. */
  errors: number
}

/**
 * A name for this `verify`, which every run it starts carries at the end of
 * its run name. It is how `verify` finds its own run among the others on the
 * branch, and how a later turn finds the baseline a run was compared with.
 */
export function verifyTag(): string {
  const id = process.env['GITHUB_RUN_ID']
  const attempt = process.env['GITHUB_RUN_ATTEMPT'] ?? '1'
  return id === undefined || id === '' ? `verify-local-${Date.now()}` : `verify-${id}-${attempt}`
}

/** The verify tag a run carries in its name, or null. */
export function tagOf(run: Run): string | null {
  const last = run.displayTitle.trim().split(/\s+/).pop() ?? ''
  return /^verify-[\w-]+$/.test(last) && !last.endsWith('-baseline') ? last : null
}

/** Whether a run carries `tag` at the end of its name. */
export const named = (tag: string) => (r: Run) => r.displayTitle.trim().endsWith(` ${tag}`)

const RUN_FIELDS = 'databaseId,displayTitle,headSha,status,conclusion,url,createdAt'

/** Dispatched runs of `workflow`, by branch or by commit. */
export function dispatchedRuns(workflow: string, by: ['--branch' | '--commit', string]): Run[] {
  return (
    ghJson<Run[]>(
      [
        'run',
        'list',
        '--repo',
        repoSlug(),
        '--workflow',
        workflow,
        '--event',
        'workflow_dispatch',
        ...by,
        '--limit',
        '30',
        '--json',
        RUN_FIELDS,
      ],
      undefined,
      reader(),
    ) ?? []
  )
}

/** The newest of `runs`, by id. */
export function newest(runs: Run[]): Run | null {
  return runs.reduce<Run | null>(
    (best, r) => (best === null || r.databaseId > best.databaseId ? r : best),
    null,
  )
}

/** The newest finished run of `workflow` on main carrying `tag`'s baseline name, or null. */
export function baselineOf(workflow: string, tag: string): Run | null {
  return newest(dispatchedRuns(workflow, ['--branch', 'main']).filter(named(`${tag}-baseline`)))
}

/**
 * The tests a finished run failed, from its `failed-tests` artifact, or null
 * when there is no artifact or it is not what the contract says.
 */
export function failedTests(runId: number): FailedTests | null {
  const dir = mkdtempSync(join(tmpdir(), 'failed-tests-'))
  try {
    gh(
      [
        'run',
        'download',
        String(runId),
        '--repo',
        repoSlug(),
        '--name',
        'failed-tests',
        '--dir',
        dir,
      ],
      undefined,
      reader(),
    )
    return parseFailedTests(readFileSync(join(dir, 'failed-tests.json'), 'utf8'))
  } catch {
    return null
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const MAX_ID = 500

const isTestId = (id: unknown): id is string =>
  typeof id === 'string' && id !== '' && id.length <= MAX_ID && !/[\r\n]/.test(id)

const isCount = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0

/**
 * A `failed-tests.json`, checked. The ids come from the pull request's own
 * code, so one that is not a single line of reasonable length rejects the
 * whole list: it goes back out as a workflow input, onto the card and into
 * the agent's prompt.
 */
export function parseFailedTests(text: string): FailedTests | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const { failed, errors } = parsed as { failed?: unknown; errors?: unknown }
  if (!Array.isArray(failed) || !isCount(errors) || !failed.every(isTestId)) return null
  return { failed: [...new Set(failed)].sort(), errors }
}

/** The commit on main the pull request's branch last took in. */
export function mergeBase(sha: string): string {
  return gh(
    ['api', `repos/${repoSlug()}/compare/main...${sha}`, '--jq', '.merge_base_commit.sha'],
    undefined,
    reader(),
  ).trim()
}

/** The ids of a run's failed jobs, whose logs say what went wrong. */
export function failedJobs(runId: number): number[] {
  return (
    ghJson<number[]>(
      [
        'run',
        'view',
        String(runId),
        '--repo',
        repoSlug(),
        '--json',
        'jobs',
        '--jq',
        '[.jobs[] | select(.conclusion == "failure") | .databaseId]',
      ],
      undefined,
      reader(),
    ) ?? []
  )
}

/** A run's id, from its URL. */
export function runId(url: string | null): number | null {
  const match = /\/actions\/runs\/(\d+)/.exec(url ?? '')
  return match === null ? null : Number(match[1])
}
