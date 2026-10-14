import { ghJson, repoSlug } from './github.ts'

/**
 * Waiting on the repository's own workflows.
 *
 * Two things the factory does not do itself in some repositories, a preview
 * (the `swa` backend) and production (`FACTORY_PRODUCTION_URL`), are done by
 * a workflow that runs on the same push. The factory's part is to wait for
 * that workflow to finish on the right commit, and to refuse to carry on if
 * it failed.
 */

export interface WorkflowRun {
  id: number
  name: string
  status: string
  conclusion: string | null
  run_attempt: number
  html_url: string
}

/**
 * The newest run of `workflow` on `sha` for `event`, or null.
 *
 * `pull_request` for a preview, which runs on the PR's head commit; `push` for
 * production, which runs on the merge commit once it is on the default branch.
 */
export function findRun(
  workflow: string,
  sha: string,
  event: 'pull_request' | 'push',
): WorkflowRun | null {
  const runs = ghJson<WorkflowRun[]>([
    'api',
    `repos/${repoSlug()}/actions/workflows/${encodeURIComponent(workflow)}/runs?head_sha=${sha}&event=${event}&per_page=10`,
    '--jq',
    '.workflow_runs',
  ])
  // Newest first, as the API returns them. A pull request closed and reopened
  // on the same commit has two runs for it, and the later one is the one that
  // deployed.
  return runs?.[0] ?? null
}

export function getRun(id: number): WorkflowRun {
  return ghJson<WorkflowRun>(['api', `repos/${repoSlug()}/actions/runs/${id}`])
}

export interface RunWaitOptions {
  /** How long to wait for one run to appear and finish. */
  runBudgetMs?: number
  gapMs?: number
}

const RUN_BUDGET_MS = 30 * 60_000
const POLL_GAP_MS = 15_000

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Waits for a run to finish, and for it to be at least `minAttempt`.
 *
 * The attempt is how a rerun is told apart from the run it repeats: they share
 * an id, and until GitHub queues the rerun the old attempt still reads as
 * completed.
 */
export async function waitForRun(
  what: string,
  find: () => WorkflowRun | null,
  minAttempt: number,
  options: RunWaitOptions,
): Promise<WorkflowRun> {
  const budgetMs = options.runBudgetMs ?? RUN_BUDGET_MS
  const gapMs = options.gapMs ?? POLL_GAP_MS
  const started = Date.now()
  let last: WorkflowRun | null = null

  for (;;) {
    last = find()
    if (last !== null && last.run_attempt >= minAttempt && last.status === 'completed') {
      if (last.conclusion !== 'success') {
        throw new Error(
          `${last.name} finished "${last.conclusion ?? 'without a conclusion'}" rather than ` +
            `succeeding: ${last.html_url}`,
        )
      }
      return last
    }
    if (Date.now() - started >= budgetMs) break
    await sleep(gapMs)
  }

  throw new Error(
    last === null
      ? `No run of ${what} appeared within ${Math.round(budgetMs / 60_000)} minutes. Does it run on ` +
          `this event and branch, and was the push made with a token that triggers workflows?`
      : `${last.name} was still ${last.status} after ${Math.round(budgetMs / 60_000)} minutes: ${last.html_url}`,
  )
}
