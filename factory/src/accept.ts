import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { REPO_ROOT } from './env.ts'
import { botIdentity, git, gitSucceeds, headSha, identifyAsBot } from './git.ts'
import {
  abortMerge,
  finishMerge,
  mergeQuestionResult,
  readMergeResult,
  readMergeState,
  type MergeState,
} from './merge.ts'
import { AGENT_OUT, RESULT_PATH, readMeta, updateMeta, writeFileEnsuringDir } from './meta.ts'
import type { Stage } from './schema.ts'
import { rejection } from './validate.ts'

/**
 * Taking an agent's turn into a job that holds tokens, without running any of
 * it.
 *
 * The agent runs in a job of its own that holds the Anthropic key and nothing
 * else (ADR 0008). A build agent runs code there: its own tests, its own app,
 * with the passwordless `sudo` every hosted runner has. So nothing that job
 * produces can be trusted to *do* anything, and what comes out of it is data:
 *
 *   - a git bundle holding the commits the agent made, through the
 *     repository's own pre-commit hook (ADR 0011), on top of the commit the
 *     turn started from, or on top of the merge from main if there was one;
 *   - a list of what the agent left uncommitted, which has to be empty;
 *   - the turn's result.json, and the resolving agent's merge-result.json.
 *
 * This runs in the publishing job, on a fresh runner, from main's factory. It
 * does not take the agent's merge commit. It merges main itself, from the same
 * commit the agent was given, and takes from the agent's merge only the files
 * that conflicted, which `finishMerge` then judges exactly as it always has.
 * If the merge that results is not the merge the agent worked on, the turn is
 * refused: the agent built on something other than main.
 *
 * The agent's commits then go on the branch as they are: the same trees,
 * messages, authors and dates. Where there was no merge they are the very
 * commits the agent made. Where there was, each is made again on the
 * factory's merge instead of the agent's, which has the same tree, so only
 * the parent differs. `validate` judges the branch as it then stands, and
 * `publish` pushes it.
 */

/** The branch the agent job bundles its commits on. */
export const TURN_REF = 'enki-turn'

export type AcceptOutcome =
  | { state: 'accepted'; base: string }
  /** The merge from main could not be finished. A question is on the result. */
  | { state: 'merge-unresolved'; problems: string[] }
  /** The turn is refused. A failed result says why. */
  | { state: 'rejected'; problems: string[] }

function revParse(ref: string): string | null {
  const out = git(['rev-parse', '--verify', '--quiet', ref], true).trim()
  return out === '' ? null : out
}

/**
 * Where the agent job lists what the agent left uncommitted, one
 * `git status --porcelain` line each. The job writes it whenever it packages a
 * turn, so a missing list means the job never got that far.
 */
export const UNCOMMITTED_PATH = resolve(AGENT_OUT, 'uncommitted.txt')

/** The agent's turn: the commit its work starts from, and its commits, oldest first. */
export interface Turn {
  merge: string
  commits: string[]
}

type Expected = { before: string; main: string; merged: boolean }

/**
 * The agent's turn, if its history has the shape it was given.
 *
 * `before` is where the branch was when the turn started. On top of it there
 * is a merge of `main` into `before`, if the turn was told to merge, and then
 * the agent's commits in a line: no merges of its own, nothing rewritten, and
 * every one made as the factory. Anything else is history the factory did not
 * hand out and will not push.
 */
export function readTurn(bundle: string, expected: Expected): Turn | { problem: string } {
  const left = uncommittedProblem()
  if (left !== null) return { problem: left }
  // The job bundles only when there is something on top of `before`, and a
  // merge always is.
  if (!existsSync(bundle)) {
    return expected.merged
      ? { problem: 'The agent job left no turn to take.' }
      : { merge: expected.before, commits: [] }
  }

  const tip = fetchTurn(bundle)
  if (tip === null) {
    return { problem: 'The turn the agent job left is not a git bundle this branch can take.' }
  }
  const added = addedBy(tip, expected)
  const { at, commits } = lineDownFrom(tip, added)
  const shape = shapeProblem(expected, added, at, commits.length)
  if (shape !== null) return { problem: shape }

  const strangers = commits.filter((sha) => !madeByTheFactory(sha))
  if (strangers.length > 0) {
    return {
      problem: `The turn has commits not made as the factory: ${strangers.map((s) => s.slice(0, 12)).join(', ')}.`,
    }
  }
  return { merge: at, commits }
}

/** Why what the agent left uncommitted refuses the turn, or `null` when it left nothing. */
function uncommittedProblem(): string | null {
  if (!existsSync(UNCOMMITTED_PATH)) return 'The agent job left no turn to take.'
  const uncommitted = readFileSync(UNCOMMITTED_PATH, 'utf8')
    .split('\n')
    .map((l) => l.slice(3).trim())
    .filter((l) => l !== '')
  if (uncommitted.length === 0) return null
  return `The agent left work it had not committed: ${uncommitted.join(', ')}. A turn's work is what it commits.`
}

/** The tip of the turn in `bundle`, fetched here, or `null` if it cannot be. */
function fetchTurn(bundle: string): string | null {
  const ref = `refs/enki/${TURN_REF}`
  git(['update-ref', '-d', ref], true)
  const fetched = gitSucceeds([
    'fetch',
    '--quiet',
    '--no-tags',
    bundle,
    `+refs/heads/${TURN_REF}:${ref}`,
  ])
  return fetched ? revParse(ref) : null
}

/** Everything the turn added, its commits and the merge if there is one, each with its parents. */
function addedBy(tip: string, expected: Expected): Map<string, string[]> {
  return new Map(
    git(['rev-list', '--parents', tip, `^${expected.before}`, `^${expected.main}`])
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => {
        const [sha, ...rest] = l.trim().split(/\s+/)
        return [sha as string, rest]
      }),
  )
}

/** The added commits with one parent each, walked down from `tip`, and where the walk stopped. */
function lineDownFrom(
  tip: string,
  added: Map<string, string[]>,
): { at: string; commits: string[] } {
  const commits: string[] = []
  let at = tip
  for (let up = added.get(at); up?.length === 1; up = added.get(at)) {
    commits.unshift(at)
    at = up[0] as string
  }
  return { at, commits }
}

/** Why the turn's history is not the shape it was given, or `null` when it is. */
function shapeProblem(
  expected: Expected,
  added: Map<string, string[]>,
  at: string,
  line: number,
): string | null {
  if (!expected.merged) {
    if (at === expected.before && added.size === line) return null
    return 'The turn does not start from the commit it was given, or is not a line of commits.'
  }
  const merge = added.get(at)?.join(' ')
  if (merge === `${expected.before} ${expected.main}` && added.size === line + 1) return null
  return 'The turn does not start from a merge of main into the commit it was given, or is not a line of commits on it.'
}

/** Whether `sha` was authored and committed as the factory, as the agent job's own commits are. */
function madeByTheFactory(sha: string): boolean {
  const { name, email } = botIdentity()
  const [an, ae, cn, ce] = git(['log', '-1', '--format=%an%n%ae%n%cn%n%ce', sha]).split('\n')
  return an === name && ae === email && cn === name && ce === email
}

/** Puts `path` in the working tree and the index as it is in `commit`, or removes it if it is not there. */
function takeFrom(commit: string, path: string): void {
  if (revParse(`${commit}:${path}`) === null) {
    git(['rm', '--quiet', '--force', '--ignore-unmatch', '--', path], true)
    return
  }
  git(['checkout', commit, '--', path])
}

export function acceptTurn(stage: Stage, bundle: string): AcceptOutcome {
  const state = readMergeState()
  const meta = readMeta()

  const reject = (problems: string[]): AcceptOutcome => {
    const existing = existsSync(RESULT_PATH) ? readFileSync(RESULT_PATH, 'utf8') : null
    writeFileEnsuringDir(
      RESULT_PATH,
      `${JSON.stringify(rejection(stage, existing, problems), null, 2)}\n`,
    )
    return { state: 'rejected', problems }
  }

  if (state.state === 'refused') {
    return reject(['The merge from main was refused, so there was no turn to take.'])
  }

  // The branch as the turn found it. `publish` pushes this name.
  git(['checkout', '--quiet', '-B', meta.branch, state.before])

  const merged = state.state === 'merged' || state.state === 'conflicted'
  const turn = readTurn(bundle, { before: state.before, main: state.main, merged })
  // An unresolved conflict is the one failure worth more than "rejected": it
  // goes on the card as a question, as it did before the agent had a job of
  // its own. So the resolving agent's answer is read before the bundle is.
  if (state.state === 'conflicted' && readMergeResult().status === 'unresolved') {
    return unresolved(state, [])
  }
  if ('problem' in turn) return reject([turn.problem])

  const refused = merged ? mergeMain(state, meta.branch, turn.merge) : null
  if (refused !== null && 'unresolved' in refused) return unresolved(state, refused.unresolved)
  if (refused !== null) return reject([refused.reject])

  const base = headSha()
  updateMeta({ base_sha: base })

  takeCommits(turn)
  return { state: 'accepted', base }
}

/** Why merging main here refused the turn, or `null` when it did not. */
type MergeRefusal = { reject: string } | { unresolved: string[] } | null

/**
 * Merges main here, from the commit the agent was given, taking from the
 * agent's merge only the files that conflicted.
 */
function mergeMain(state: MergeState, branch: string, agentMerge: string): MergeRefusal {
  identifyAsBot()
  const message = `Merge main (${state.main.slice(0, 12)}) into ${branch}`
  const clean = gitSucceeds(['merge', '--no-ff', '--no-edit', '-m', message, state.main])

  if (state.state === 'merged' && !clean) {
    abortMerge()
    return {
      reject: 'Main merged cleanly into this branch once, and then did not. Nothing was taken.',
    }
  }
  if (state.state === 'conflicted') {
    if (clean)
      return {
        reject: 'Main was expected to conflict with this branch, and did not. Nothing was taken.',
      }
    for (const path of state.conflicts) takeFrom(agentMerge, path)
    const outcome = finishMerge(state, readMergeResult())
    if (!outcome.ok) return { unresolved: outcome.problems }
  }

  // Everything outside the conflicts is main's, merged here. If the agent's
  // merge says otherwise, the agent built its turn on a tree main never had.
  // The trees have to be the same, not just similar: the agent's commits are
  // made again on this merge, and carry their trees with them.
  if (revParse('HEAD^{tree}') === revParse(`${agentMerge}^{tree}`)) return null
  const strayed = git(['diff', '--name-only', 'HEAD', agentMerge])
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
  return {
    reject: `The merge the agent worked on is not the merge of main: it differs in ${strayed.length > 0 ? strayed.join(', ') : 'file modes'}.`,
  }
}

/**
 * Puts the agent's commits on the branch. With no merge they already sit on
 * it, and the branch moves up to them. After one, each is made again on the
 * factory's merge with its own tree, message, author and dates.
 */
function takeCommits(turn: Turn): void {
  const last = turn.commits.at(-1)
  if (last === undefined) return
  if (turn.merge === headSha()) {
    git(['merge', '--quiet', '--ff-only', last])
    return
  }
  let parent = headSha()
  for (const sha of turn.commits) parent = remake(sha, parent)
  git(['reset', '--quiet', '--hard', parent])
}

/** `sha` again, on `parent`. Everything but the parent is as it was. */
function remake(sha: string, parent: string): string {
  const [an, ae, ad, cn, ce, cd] = git([
    'log',
    '-1',
    '--date=raw',
    '--format=%an%n%ae%n%ad%n%cn%n%ce%n%cd',
    sha,
  ]).split('\n')
  const raw = git(['cat-file', 'commit', sha])
  const message = raw.slice(raw.indexOf('\n\n') + 2)
  const result = spawnSync('git', ['commit-tree', `${sha}^{tree}`, '-p', parent], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    input: message,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: an,
      GIT_AUTHOR_EMAIL: ae,
      GIT_AUTHOR_DATE: ad,
      GIT_COMMITTER_NAME: cn,
      GIT_COMMITTER_EMAIL: ce,
      GIT_COMMITTER_DATE: cd,
    },
  })
  if (result.status !== 0) throw new Error(`git commit-tree failed: ${result.stderr.trim()}`)
  return result.stdout.trim()
}

function unresolved(state: MergeState, problems: string[]): AcceptOutcome {
  abortMerge()
  const result = readMergeResult()
  writeFileEnsuringDir(
    RESULT_PATH,
    `${JSON.stringify(mergeQuestionResult(state, problems, result), null, 2)}\n`,
  )
  return { state: 'merge-unresolved', problems: problems.length > 0 ? problems : [result.summary] }
}
