import { lastVerdict } from './baseline.ts'
import { failedJobs, reader, runId } from './dispatched.ts'
import { gh, repoSlug } from './github.ts'
import {
  checkRuns,
  checksToWaitFor,
  newestRun,
  readChecks,
  verifyWorkflows,
  type CheckRun,
} from './verify.ts'

/**
 * What the next build turn reads about the checks the last one did not pass,
 * when `verify` sent the card back.
 */

const LOG_LINES = 80
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z ?/

/**
 * The end of a failed job's log, which is where a test runner prints what
 * failed. The id of a check run made by Actions is its job's id.
 */
function logTail(job: number): string | null {
  try {
    const log = gh(['api', `repos/${repoSlug()}/actions/jobs/${job}/logs`], undefined, reader())
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
 * What is failing on `sha`, written up for the agent: each failing check that
 * `verify` waits for, with the end of its log, or what the check said of itself
 * when it is not an Actions job; and each dispatched workflow that failed,
 * split into the tests that are the pull request's to fix and those that fail
 * on main too.
 *
 * All of it is untrusted, as everything the agent reads is: a log is whatever
 * the pull request's code printed.
 */
export function failureReport(sha: string, workflows = verifyWorkflows()): string[] {
  const required = checksToWaitFor()
  const failing =
    required.length === 0 ? [] : readChecks(sha, required).filter((c) => c.state === 'fail')
  const runs = failing.length === 0 ? [] : checkRuns(sha)
  return [
    ...failing.flatMap((check) => [
      `### ${check.name} — ${check.conclusion ?? 'failed'}`,
      '',
      ...whatItSaid(newestRun(runs, check.name)),
    ]),
    ...workflows.flatMap((workflow) => workflowReport(workflow, sha)),
  ]
}

/** The end of a failing run's log, or failing that what it said of itself. */
function whatItSaid(run: CheckRun | null): string[] {
  const tail = run?.app?.slug === 'github-actions' ? logTail(run.id) : null
  if (tail !== null && tail !== '') return ['The end of its log:', '', '~~~~', tail, '~~~~', '']
  const said = [run?.output?.title, run?.output?.summary].filter(
    (s): s is string => (s ?? '') !== '',
  )
  return [said.length > 0 ? said.join('\n\n').slice(0, 4000) : '_(it gave no detail)_', '']
}

/**
 * A dispatched workflow's last failure on `sha`: the tests that are the pull
 * request's to fix, those main fails as well, and the end of each failed job's
 * log. Nothing when its last run there did not fail.
 */
function workflowReport(workflow: string, sha: string): string[] {
  const result = lastVerdict(workflow, sha)
  if (result === null || result.state !== 'fail') return []
  const lines = [`### ${workflow} — ${result.conclusion ?? 'failed'}`, '']
  if (result.failed.length > 0) {
    lines.push(
      result.baseline === null
        ? 'These tests failed:'
        : 'These tests failed here and pass on main, so they are yours to fix:',
      '',
      ...result.failed.map((t) => `- ${t}`),
      '',
    )
  }
  if (result.excused.length > 0) {
    lines.push(
      "These failed on main as well. They are not this card's to fix, and the factory raises a card for",
      'each one it can; leave them alone:',
      '',
      ...result.excused.map((t) => `- ${t}`),
      '',
    )
  }
  if (result.note !== null) lines.push(result.note, '')
  const id = runId(result.url)
  for (const job of id === null ? [] : failedJobs(id)) {
    const tail = logTail(job)
    if (tail !== null && tail !== '') {
      lines.push("The end of a failed job's log:", '', '~~~~', tail, '~~~~', '')
    }
  }
  return lines
}
