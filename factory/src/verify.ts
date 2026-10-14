import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { dispatchWorkflow, gh, ghJson, repoSlug } from './github.ts'
import { AGENT_OUT, writeFileEnsuringDir } from './meta.ts'

/**
 * The gate between "the agent thinks it is done" and "In review".
 *
 * A build turn that ends `ready_for_review` leaves its pull request a draft.
 * `factory verify` then waits for the checks main requires on the commit the
 * turn pushed, and `report` acts on what it found: all green, and the pull
 * request comes out of draft and the card goes to In review; anything red, and
 * the card stays in Building for another turn, up to `MAX_RETRIES`, then goes
 * to Blocked on engineer.
 *
 * Without it a card reaches In review whatever the checks say, and the first
 * person to learn that the suite is red is the reviewer.
 *
 * `FACTORY_VERIFY_WORKFLOWS` is for repositories whose expensive checks skip
 * drafts, as Workbench's end-to-end suite does. `verify` dispatches each one on
 * the pull request's branch, with the App token, so the full suite runs once
 * per finished turn rather than on every push the agent makes on the way
 * there. A dispatch, not a label: a workflow that listened for
 * `pull_request: labeled` would also run, and skip, on every other label
 * anyone put on any pull request, and a skipped run newer than a failed one
 * passes branch protection.
 */

/** The workflows `verify` dispatches, from `FACTORY_VERIFY_WORKFLOWS`. */
export function verifyWorkflows(): string[] {
  return (process.env['FACTORY_VERIFY_WORKFLOWS'] ?? '')
    .split(',')
    .map((w) => w.trim())
    .filter((w) => w !== '')
}

/**
 * The token the checks are read with: `GH_CHECKS_TOKEN` when it is set, which
 * in the workflows is the job's own GITHUB_TOKEN granted `checks`, `statuses`
 * and `actions` read. The App is given none of those. It needs none of them
 * for anything else, and everything here is a read, which GITHUB_TOKEN does as
 * well as the App does. Writes, the dispatch and the draft, stay with the App.
 */
function reader(): Record<string, string> | undefined {
  const token = process.env['GH_CHECKS_TOKEN']
  return token === undefined || token === '' ? undefined : { GH_TOKEN: token }
}

/** Automatic turns after the first red verdict, before a person is asked. */
export const MAX_RETRIES = 2

/** Where `verify` writes its verdict, and where `report` reads it. */
export const VERIFY_PATH = resolve(AGENT_OUT, 'verify.json')

/**
 * `stale` is a run skipped before `verify` asked for the full suite: the
 * draft's push skipping it, not an answer to the question asked.
 */
export type CheckState = 'pass' | 'fail' | 'pending' | 'missing' | 'stale'

export interface CheckResult {
  name: string
  state: CheckState
  /** The check run's conclusion, or the status's state. */
  conclusion: string | null
  url: string | null
}

export interface Verdict {
  /**
   * `green` every required check passed; `red` all have finished and at least
   * one failed; `timeout` the budget ran out with some still running or never
   * reported.
   */
  outcome: 'green' | 'red' | 'timeout'
  sha: string
  checks: CheckResult[]
}

interface CheckRun {
  id: number
  name: string
  status: string
  conclusion: string | null
  html_url: string | null
  completed_at?: string | null
  app?: { slug?: string } | null
  output?: { title?: string | null; summary?: string | null } | null
}

interface CommitStatus {
  context: string
  state: string
  target_url: string | null
}

/**
 * The checks main requires, by name, from rulesets and from classic branch
 * protection both. A repository can use either, or both at once.
 *
 * The rules endpoint needs only read access, which the App token has. Classic
 * protection is read off the branch, which says what it requires without the
 * administration permission the protection endpoint itself asks for.
 */
export function requiredChecks(branch = 'main'): string[] {
  const slug = repoSlug()
  return [...new Set([...rulesetChecks(slug, branch), ...classicChecks(slug, branch)])].sort()
}

function rulesetChecks(slug: string, branch: string): string[] {
  const rules =
    ghJson<
      Array<{ type: string; parameters?: { required_status_checks?: Array<{ context: string }> } }>
    >(['api', `repos/${slug}/rules/branches/${branch}`], undefined, reader()) ?? []
  return rules
    .filter((rule) => rule.type === 'required_status_checks')
    .flatMap((rule) =>
      (rule.parameters?.required_status_checks ?? []).map((check) => check.context),
    )
}

function classicChecks(slug: string, branch: string): string[] {
  const classic = ghJson<{
    protection?: {
      required_status_checks?: { contexts?: string[]; checks?: Array<{ context: string }> }
    }
  }>(['api', `repos/${slug}/branches/${branch}`], undefined, reader())
  const protection = classic?.protection?.required_status_checks
  return [
    ...(protection?.contexts ?? []),
    ...(protection?.checks ?? []).map((check) => check.context),
  ]
}

function checkRuns(sha: string): CheckRun[] {
  return (
    ghJson<CheckRun[]>(
      [
        'api',
        `repos/${repoSlug()}/commits/${sha}/check-runs?filter=all&per_page=100`,
        '--jq',
        '.check_runs',
      ],
      undefined,
      reader(),
    ) ?? []
  )
}

function commitStatuses(sha: string): CommitStatus[] {
  return (
    ghJson<CommitStatus[]>(
      ['api', `repos/${repoSlug()}/commits/${sha}/status?per_page=100`, '--jq', '.statuses'],
      undefined,
      reader(),
    ) ?? []
  )
}

/**
 * The newest check run of a name, by id, not the first the API lists. A
 * draft's push can leave a skipped run of a check that `verify` then starts
 * again on the same commit, and the skipped one must not stand for it.
 */
function newestRun(runs: CheckRun[], name: string): CheckRun | null {
  return runs
    .filter((r) => r.name === name)
    .reduce<CheckRun | null>(
      (newest, r) => (newest === null || r.id > newest.id ? r : newest),
      null,
    )
}

// What branch protection itself accepts as passing.
const PASSING = new Set(['success', 'neutral', 'skipped'])

/**
 * Where each required check stands on `sha`: its newest check run, or failing
 * that its commit status, which is how some integrations still report.
 *
 * Given `askedAt`, when `verify` dispatched the full suite, a run that was
 * skipped before then is `stale`, not passing, until a newer run replaces it.
 * Otherwise the draft push's skipped run would pass the gate in the moments
 * before the dispatched run's job exists.
 */
export function readChecks(sha: string, required: string[], askedAt?: number): CheckResult[] {
  const runs = checkRuns(sha)
  const statuses = commitStatuses(sha)

  return required.map((name): CheckResult => {
    const run = newestRun(runs, name)
    if (run !== null) return fromRun(name, run, askedAt)
    const status = statuses.find((s) => s.context === name)
    if (status !== undefined) return fromStatus(name, status)
    return { name, state: 'missing', conclusion: null, url: null }
  })
}

function fromRun(name: string, run: CheckRun, askedAt?: number): CheckResult {
  if (run.status !== 'completed') {
    return { name, state: 'pending', conclusion: null, url: run.html_url }
  }
  const conclusion = run.conclusion ?? 'unknown'
  const finished = run.completed_at == null ? Number.NaN : Date.parse(run.completed_at)
  if (askedAt !== undefined && conclusion === 'skipped' && !(finished >= askedAt)) {
    return { name, state: 'stale', conclusion, url: run.html_url }
  }
  return { name, state: PASSING.has(conclusion) ? 'pass' : 'fail', conclusion, url: run.html_url }
}

function fromStatus(name: string, status: CommitStatus): CheckResult {
  const state: CheckState =
    status.state === 'success' ? 'pass' : status.state === 'pending' ? 'pending' : 'fail'
  return { name, state, conclusion: status.state, url: status.target_url }
}

/**
 * Starts each of `workflows` on the pull request's branch, with the pull
 * request's number as `pr`. A workflow that cannot be started is a warning,
 * not the end: its checks then go unanswered and the wait times out, which
 * says so on the card.
 */
function dispatch(pr: number, workflows: string[]): void {
  const branch = ghJson<{ headRefName: string }>([
    'pr',
    'view',
    String(pr),
    '--repo',
    repoSlug(),
    '--json',
    'headRefName',
  ]).headRefName
  for (const workflow of workflows) {
    try {
      dispatchWorkflow(workflow, { pr: String(pr) }, branch)
      console.log(`verify: started ${workflow} on ${branch}`)
    } catch (error) {
      console.error(
        `::warning::could not start ${workflow} on ${branch}: ${(error as Error).message}`,
      )
    }
  }
}

export interface VerifyOptions {
  pr: number
  sha: string
  /** Workflows to dispatch first. `verifyWorkflows()` by default. */
  workflows?: string[]
  /** How long to wait for every required check to finish. */
  budgetMs?: number
  /**
   * How long to give GitHub to start the runs the push and the dispatch set
   * off, before anything already finished is believed.
   */
  settleMs?: number
  gapMs?: number
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** The wait budget: the job's own timeout less five minutes to report in. */
export function budgetFromEnv(): number {
  const minutes = Number.parseInt(process.env['FACTORY_VERIFY_TIMEOUT_MINUTES'] ?? '', 10)
  return Math.max(1, (Number.isFinite(minutes) ? minutes : 60) - 5) * 60_000
}

export async function verify(options: VerifyOptions): Promise<Verdict> {
  const budgetMs = options.budgetMs ?? budgetFromEnv()
  const settleMs = options.settleMs ?? 60_000
  const gapMs = options.gapMs ?? 30_000

  const required = requiredChecks()
  if (required.length === 0) {
    console.log('verify: main requires no checks, so there is nothing to wait for.')
    return { outcome: 'green', sha: options.sha, checks: [] }
  }
  console.log(`verify: main requires ${required.join(', ')}`)

  const workflows = options.workflows ?? verifyWorkflows()
  let askedAt: number | undefined
  if (workflows.length > 0) {
    askedAt = Date.now()
    dispatch(options.pr, workflows)
  }

  await sleep(settleMs)
  const started = Date.now()
  for (;;) {
    const checks = readChecks(options.sha, required, askedAt)
    const waiting = checks.filter(
      (c) => c.state === 'pending' || c.state === 'missing' || c.state === 'stale',
    )
    if (waiting.length === 0) {
      const outcome = checks.some((c) => c.state === 'fail') ? 'red' : 'green'
      return { outcome, sha: options.sha, checks }
    }
    if (Date.now() - started >= budgetMs) {
      return { outcome: 'timeout', sha: options.sha, checks }
    }
    console.log(`verify: waiting on ${waiting.map((c) => c.name).join(', ')}`)
    await sleep(gapMs)
  }
}

export function writeVerdict(verdict: Verdict, path = VERIFY_PATH): void {
  writeFileEnsuringDir(path, `${JSON.stringify(verdict, null, 2)}\n`)
}

/** The verdict `verify` left, or null when it never ran or never finished. */
export function readVerdict(path = VERIFY_PATH): Verdict | null {
  if (!existsSync(path)) return null
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Verdict
    return ['green', 'red', 'timeout'].includes(parsed.outcome) && Array.isArray(parsed.checks)
      ? parsed
      : null
  } catch {
    return null
  }
}

/**
 * What `report` does with a finished build turn.
 *
 *   ready    take the pull request out of draft, card to In review
 *   retry    card stays in Building, and another turn is started
 *   blocked  card to Blocked on engineer, pull request stays a draft
 */
export type Decision =
  { action: 'ready' } | { action: 'retry'; next: number } | { action: 'blocked'; why: string }

export function decide(verdict: Verdict | null, retry: number): Decision {
  if (verdict === null) {
    return {
      action: 'blocked',
      why: "The factory could not read the pull request's required checks, so it has not marked it ready.",
    }
  }
  if (verdict.outcome === 'green') return { action: 'ready' }
  if (verdict.outcome === 'timeout') {
    return {
      action: 'blocked',
      why:
        'Some required checks had not finished when the factory stopped waiting. Another agent turn ' +
        'would not make them finish sooner.',
    }
  }
  if (retry < MAX_RETRIES) return { action: 'retry', next: retry + 1 }
  return {
    action: 'blocked',
    why: `Required checks still fail after ${MAX_RETRIES} automatic turns to fix them.`,
  }
}

const LOG_LINES = 80
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z ?/

/**
 * The end of a failed job's log, which is where a test runner prints what
 * failed. The id of a check run made by Actions is its job's id.
 */
function logTail(run: CheckRun): string | null {
  if (run.app?.slug !== 'github-actions') return null
  try {
    const log = gh(['api', `repos/${repoSlug()}/actions/jobs/${run.id}/logs`], undefined, reader())
    return log
      .split('\n')
      .map((line) => line.replace(TIMESTAMP, ''))
      .slice(-LOG_LINES)
      .join('\n')
      .trim()
  } catch {
    return null
  }
}

/**
 * The failing required checks on `sha`, written up for the agent: which
 * failed, and the end of each one's log, or what the check said of itself when
 * it is not an Actions job.
 *
 * All of it is untrusted, as everything the agent reads is: a log is whatever
 * the pull request's code printed.
 */
export function failureReport(sha: string): string[] {
  const required = requiredChecks()
  if (required.length === 0) return []
  const failing = readChecks(sha, required).filter((c) => c.state === 'fail')
  if (failing.length === 0) return []

  const runs = checkRuns(sha)
  return failing.flatMap((check) => [
    `### ${check.name} — ${check.conclusion ?? 'failed'}`,
    '',
    ...whatItSaid(newestRun(runs, check.name)),
  ])
}

/** The end of a failing run's log, or failing that what it said of itself. */
function whatItSaid(run: CheckRun | null): string[] {
  const tail = run === null ? null : logTail(run)
  if (tail !== null && tail !== '') return ['The end of its log:', '', '~~~~', tail, '~~~~', '']
  const said = [run?.output?.title, run?.output?.summary].filter(
    (s): s is string => (s ?? '') !== '',
  )
  return [said.length > 0 ? said.join('\n\n').slice(0, 4000) : '_(it gave no detail)_', '']
}
