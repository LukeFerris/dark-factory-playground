import {
  PASSING,
  baselineOf,
  dispatchedRuns,
  failedTests,
  mergeBase,
  named,
  newest,
  tagOf,
  type FailedTests,
  type Run,
} from './dispatched.ts'
import { dispatchWorkflow } from './github.ts'

/**
 * Following the workflows `verify` starts to the end, and running what failed
 * again on main (ADR 0010).
 *
 * A dispatched run that fails is not the end of it. Its `failed-tests` artifact
 * names the tests that failed, and the same workflow runs just those again on
 * main, at the commit the pull request's branch left it. A test that fails
 * there too is main's, not the card's: it is excused, and a card is raised for
 * it. A test that fails only on the pull request is the card's to fix.
 *
 * The test is mechanical, and anything it cannot decide counts against the pull
 * request: a run that left no list, a suite that errored outside its tests, a
 * baseline that never ran or could not be read. Excusing too much would let a
 * card through on someone else's red; excusing too little costs a retry turn.
 */

/**
 * `excused` failed, but only on tests that fail on main as well. `missing`
 * could not be started.
 */
export type WorkflowState = 'pass' | 'excused' | 'fail' | 'pending' | 'missing'

export interface WorkflowResult {
  workflow: string
  state: WorkflowState
  /** The pull request's run's conclusion, once it has one. */
  conclusion: string | null
  url: string | null
  /** Tests that failed on the pull request and not on main. */
  failed: string[]
  /** Tests that failed on the pull request and on main as well. */
  excused: string[]
  /** Where main was run: the merge base, and the baseline run. */
  baseline: { sha: string; url: string | null } | null
  /** Why it stands where it does, when the state alone does not say. */
  note: string | null
}

/** A workflow `verify` starts: which, for which pull request, and where. */
export interface Target {
  workflow: string
  pr: number
  /** The commit the turn pushed. */
  sha: string
  /** The pull request's branch. */
  branch: string
  /** This `verify`'s tag, from `verifyTag()`. */
  tag: string
}

/**
 * A workflow input holds 65,535 characters. A list longer than this goes as
 * nothing at all, which runs the whole suite on main: slower, and the same
 * comparison.
 */
const MAX_TESTS_INPUT = 60_000

/** Starts the workflow on main at `base`, running `tests` again. */
function startBaseline(t: Target, base: string, tests: string[]): void {
  const list = JSON.stringify(tests)
  dispatchWorkflow(
    t.workflow,
    {
      pr: String(t.pr),
      sha: base,
      tests: list.length > MAX_TESTS_INPUT ? '' : list,
      tag: `${t.tag}-baseline`,
    },
    'main',
  )
}

const result = (
  workflow: string,
  run: Run | null,
  over: Partial<WorkflowResult>,
): WorkflowResult => ({
  workflow,
  state: 'pending',
  conclusion: run?.status === 'completed' ? (run.conclusion ?? 'unknown') : null,
  url: run?.url ?? null,
  failed: [],
  excused: [],
  baseline: null,
  note: null,
  ...over,
})

/**
 * What a finished pull-request run says on its own: passed, failed beyond
 * comparing, or failed on these tests, which main has to be asked about.
 */
function judgeRun(workflow: string, run: Run): WorkflowResult | FailedTests {
  if (PASSING.has(run.conclusion ?? '')) return result(workflow, run, { state: 'pass' })
  const mine = failedTests(run.databaseId)
  const fail = (note: string) =>
    result(workflow, run, { state: 'fail', failed: mine?.failed ?? [], note })
  if (mine === null)
    return fail('It left no list of the tests that failed, so it could not be compared with main.')
  if (mine.errors > 0)
    return fail('It failed outside its tests as well, so it could not be compared with main.')
  if (mine.failed.length === 0)
    return fail('It failed without a test failing, so there was nothing to compare with main.')
  return mine
}

/** The pull request's failures, against main's run of the same tests at `against.sha`. */
function judgeBaseline(
  workflow: string,
  run: Run,
  mine: FailedTests,
  against: { sha: string; run: Run },
): WorkflowResult {
  const at = { sha: against.sha, url: against.run.url }
  const theirs = PASSING.has(against.run.conclusion ?? '')
    ? { failed: [], errors: 0 }
    : failedTests(against.run.databaseId)
  if (theirs === null || theirs.errors > 0) {
    return result(workflow, run, {
      state: 'fail',
      failed: mine.failed,
      baseline: at,
      note: "Main's run of the same tests could not be read, so none of the failures is excused.",
    })
  }
  const onMain = new Set(theirs.failed)
  const failed = mine.failed.filter((t) => !onMain.has(t))
  const excused = mine.failed.filter((t) => onMain.has(t))
  return result(workflow, run, {
    state: failed.length === 0 ? 'excused' : 'fail',
    failed,
    excused,
    baseline: at,
  })
}

export interface Follow {
  /** Looks again, and says where the workflow stands. Pending until it is decided. */
  step(): WorkflowResult
}

/** A pull-request run that failed on tests, whose baseline on main has been started. */
interface Failing {
  run: Run
  mine: FailedTests
  base: string
}

/**
 * Starts the workflow on the pull request's branch and follows it: to its run's
 * end, then, if it failed on tests, through the baseline on main. Every result
 * but a pending one is final.
 *
 * A workflow written before the contract takes no `tag`. It is started
 * without one and its run found by commit and time instead, and a failure is
 * then compared with nothing: main's copy of the workflow takes none of the
 * baseline's inputs either.
 */
export function follow(t: Target): Follow {
  const askedAt = Date.now()
  const started = start(t)
  if (typeof started !== 'boolean') return { step: () => started }
  const tagged = started
  const mine = (r: Run) =>
    tagged ? named(t.tag)(r) : r.headSha === t.sha && Date.parse(r.createdAt) >= askedAt - 60_000

  let done: WorkflowResult | null = null
  let failing: Failing | null = null
  const step = (): WorkflowResult => {
    if (done !== null) return done
    if (failing === null) {
      const looked = firstLook(t, tagged, mine)
      if ('state' in looked) {
        if (looked.state !== 'pending') done = looked
        return looked
      }
      failing = looked
    }
    const judged = againstMain(t, failing)
    if (judged.state !== 'pending') done = judged
    return judged
  }
  return { step }
}

/**
 * Starts the workflow: true when it took the tag, false when it takes none,
 * or why it could not be started at all.
 */
function start(t: Target): boolean | WorkflowResult {
  try {
    const tagged = dispatchTagged(t)
    console.log(`verify: started ${t.workflow} on ${t.branch}`)
    return tagged
  } catch (error) {
    const message = (error as Error).message
    console.error(`::warning::could not start ${t.workflow} on ${t.branch}: ${message}`)
    return result(t.workflow, null, {
      state: 'missing',
      note: `It could not be started: ${message}`,
    })
  }
}

function dispatchTagged(t: Target): boolean {
  try {
    dispatchWorkflow(t.workflow, { pr: String(t.pr), tag: t.tag }, t.branch)
    return true
  } catch (error) {
    if (!/unexpected inputs/i.test((error as Error).message)) throw error
  }
  console.log(
    `::warning::${t.workflow} takes no tag yet, so its run is found by commit and time (ADR 0010).`,
  )
  dispatchWorkflow(t.workflow, { pr: String(t.pr) }, t.branch)
  return false
}

/** The pull request's own run: where it stands, or its failures, sent to main. */
function firstLook(
  t: Target,
  tagged: boolean,
  mine: (r: Run) => boolean,
): WorkflowResult | Failing {
  const run = newest(dispatchedRuns(t.workflow, ['--branch', t.branch]).filter(mine))
  if (run === null) return result(t.workflow, null, { note: 'Not started yet.' })
  if (run.status !== 'completed') return result(t.workflow, run, { note: 'Still running.' })
  const judged = judgeRun(t.workflow, run)
  if ('state' in judged) return judged
  if (!tagged) {
    return result(t.workflow, run, {
      state: 'fail',
      failed: judged.failed,
      note: 'This workflow cannot yet be run on main for comparison, so none of the failures is excused.',
    })
  }
  try {
    const base = mergeBase(t.sha)
    startBaseline(t, base, judged.failed)
    console.log(
      `verify: ${t.workflow} failed ${judged.failed.length} test(s); running them on main at ${base.slice(0, 7)}`,
    )
    return { run, mine: judged, base }
  } catch (error) {
    return result(t.workflow, run, {
      state: 'fail',
      failed: judged.failed,
      note: `The failures could not be run again on main: ${(error as Error).message}`,
    })
  }
}

/** The failures against main's run of them, once it has finished. */
function againstMain(t: Target, { run, mine, base }: Failing): WorkflowResult {
  const baseline = baselineOf(t.workflow, t.tag)
  if (baseline === null || baseline.status !== 'completed') {
    return result(t.workflow, run, {
      failed: mine.failed,
      baseline: { sha: base, url: baseline?.url ?? null },
      note: 'Running the failures again on main.',
    })
  }
  return judgeBaseline(t.workflow, run, mine, { sha: base, run: baseline })
}

/**
 * Where `workflow` stood after the newest `verify` that ran it on `sha`, read
 * back from the runs themselves: for a later turn, which has nothing else to go
 * on. Null when it never ran there, or is still running.
 */
export function lastVerdict(workflow: string, sha: string): WorkflowResult | null {
  const run = newest(dispatchedRuns(workflow, ['--commit', sha]).filter((r) => r.headSha === sha))
  if (run === null || run.status !== 'completed') return null
  const judged = judgeRun(workflow, run)
  if ('state' in judged) return judged

  const tag = tagOf(run)
  const baseline = tag === null ? null : baselineOf(workflow, tag)
  if (baseline === null || baseline.status !== 'completed') {
    return result(workflow, run, {
      state: 'fail',
      failed: judged.failed,
      note: 'It was not compared with main.',
    })
  }
  return judgeBaseline(workflow, run, judged, { sha: shownBase(sha), run: baseline })
}

/**
 * The merge base, for showing. Not the baseline's own headSha, which is main's
 * head when it was started: it checked out the merge base, and a commit's
 * merge base with main stays put however far main moves on.
 */
function shownBase(sha: string): string {
  try {
    return mergeBase(sha)
  } catch {
    return ''
  }
}
