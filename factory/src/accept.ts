import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { REPO_ROOT } from './env.ts'
import { git, gitSucceeds, headSha, identifyAsBot } from './git.ts'
import {
  abortMerge,
  finishMerge,
  mergeQuestionResult,
  readMergeResult,
  readMergeState,
  type MergeState,
} from './merge.ts'
import { RESULT_PATH, readMeta, updateMeta, writeFileEnsuringDir } from './meta.ts'
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
 *   - a git bundle holding at most two commits on top of the commit the turn
 *     started from: the merge from main, if there was one, and then everything
 *     the turn wrote, committed as one;
 *   - the turn's result.json, and the resolving agent's merge-result.json.
 *
 * This runs in the publishing job, on a fresh runner, from main's factory. It
 * does not take the agent's merge commit. It merges main itself, from the same
 * commit the agent was given, and takes from the agent's merge only the files
 * that conflicted, which `finishMerge` then judges exactly as it always has.
 * If the merge that results is not the merge the agent worked on, the turn is
 * refused: the agent built on something other than main.
 *
 * The turn's own work is then applied as a diff to the working tree and left
 * uncommitted, which is the state `validate` and `publish` have always found a
 * turn in.
 */

/** The branch the agent job bundles its two commits on. */
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

function parents(sha: string): string[] {
  return git(['rev-list', '--parents', '-n', '1', sha]).trim().split(/\s+/).slice(1)
}

/** What changed between two commits, as a patch `git apply` takes back. */
function binaryDiff(from: string, to: string): Buffer {
  const result = spawnSync('git', ['diff', '--binary', '--full-index', '--no-renames', from, to], {
    cwd: REPO_ROOT,
    maxBuffer: 512 * 1024 * 1024,
  })
  if (result.status !== 0)
    throw new Error(`git diff ${from} ${to} failed: ${result.stderr.toString().trim()}`)
  return result.stdout
}

/**
 * The agent's turn, if its history has the shape it was given.
 *
 * `before` is where the branch was when the turn started. On top of it there is
 * one commit holding the turn's work, and between them a merge of `main` into
 * `before` if the turn was told to merge. Anything else is history the factory
 * did not hand out and will not push.
 */
export function readTurn(
  bundle: string,
  expected: { before: string; main: string; merged: boolean },
): { merge: string; work: string } | { problem: string } {
  if (!existsSync(bundle)) return { problem: 'The agent job left no turn to take.' }
  git(['update-ref', '-d', `refs/enki/${TURN_REF}`], true)
  if (
    !gitSucceeds([
      'fetch',
      '--quiet',
      '--no-tags',
      bundle,
      `+refs/heads/${TURN_REF}:refs/enki/${TURN_REF}`,
    ])
  ) {
    return { problem: 'The turn the agent job left is not a git bundle this branch can take.' }
  }
  const work = revParse(`refs/enki/${TURN_REF}`) as string
  const workParents = parents(work)
  if (workParents.length !== 1) return { problem: 'The turn is not a single commit of work.' }
  const merge = workParents[0] as string

  if (!expected.merged) {
    return merge === expected.before
      ? { merge, work }
      : { problem: 'The turn does not start from the commit it was given.' }
  }
  const mergeParents = parents(merge)
  if (
    mergeParents.length !== 2 ||
    mergeParents[0] !== expected.before ||
    mergeParents[1] !== expected.main
  ) {
    return { problem: 'The turn does not start from a merge of main into the commit it was given.' }
  }
  return { merge, work }
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

  const problem = applyWork(turn.merge, turn.work)
  return problem === null ? { state: 'accepted', base } : reject([problem])
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
  const strayed = git(['diff', '--name-only', 'HEAD', agentMerge])
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
  if (strayed.length > 0) {
    return {
      reject: `The merge the agent worked on is not the merge of main: it differs in ${strayed.join(', ')}.`,
    }
  }
  return null
}

/** Lays the turn's work on the branch, uncommitted. Says why when it will not go. */
function applyWork(merge: string, work: string): string | null {
  const patch = binaryDiff(merge, work)
  if (patch.length === 0) return null
  const file = resolve(REPO_ROOT, '.git', 'enki-turn.patch')
  writeFileSync(file, patch)
  // Into the working tree only, not the index: `publish` stages what the
  // stage may write and nothing else, and `validate` sees the rest.
  return gitSucceeds(['apply', '--binary', file])
    ? null
    : 'The turn’s changes do not apply to the branch.'
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
