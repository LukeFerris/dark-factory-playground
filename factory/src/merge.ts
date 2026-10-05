import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { z } from 'zod'
import { REPO_ROOT } from './env.ts'
import { git, gitSucceeds, headSha, identifyAsBot } from './git.ts'
import { AGENT_IN, AGENT_OUT, updateMeta, writeFileEnsuringDir } from './meta.ts'
import { matchesGlob } from './validate.ts'
import { ALWAYS_DENIED, QuestionSchema, type Result } from './schema.ts'

/**
 * Merging main into a card branch, and letting an agent finish the job.
 *
 * Every card branch is long-running: it is cut once and carries the card from
 * the design turn to the merge, which on a busy board is days. Main moves under
 * it the whole time. Two separate things go wrong when it is left to drift, and
 * this module exists because only one of them was ever handled.
 *
 * The first is the one `prepare-branch` already knew about. The agent's manual,
 * the result schema and the factory's own code all live in the checked-out
 * tree, so a stale branch runs a stale prompt against a stale validator and a
 * fix to either silently misses every card in flight.
 *
 * The second is simply that the branch is wrong. It was written against a main
 * that no longer exists, its tests pass against code that has been replaced,
 * and the reviewer looking at the preview is looking at a world that ended two
 * merges ago. Nobody finds out until the merge button, which is the worst
 * possible moment.
 *
 * The old answer to a conflict was to stop the turn and demand a human. That is
 * right about the risk and wrong about the remedy: most conflicts on a card
 * branch are two cards editing the same handful of lines, which is exactly the
 * kind of judgement an agent can make, and the ones it cannot make are better
 * asked as a specific question on the card than as a failed workflow run.
 *
 * So the flow is three steps, and they are three steps because the middle one
 * runs an agent and must therefore be its own workflow step holding nothing but
 * an Anthropic key:
 *
 *   attemptMerge   git tries. Clean, already up to date, conflicted, or
 *                  refused — and `refused` is the one case that still stops
 *                  dead, because a conflict inside `factory/` or `.github/` is
 *                  the stale-rules problem in its purest form.
 *   (the agent)    reads `.agent/in/merge-task.md`, edits the conflicted files,
 *                  writes `.agent/out/merge-result.json`.
 *   finishMerge    checks the agent stayed inside the conflict and left no
 *                  markers, then writes the merge commit.
 *
 * Nothing here commits until `finishMerge` is satisfied. A conflicted merge sits
 * in the index, where `git merge --abort` puts it all back.
 */

/** What `attemptMerge` found. Written to `.agent/in/merge.json` for the step after it. */
export const MergeStateSchema = z.object({
  branch: z.string(),
  state: z.enum(['up-to-date', 'merged', 'conflicted', 'refused']),
  /** Commits on main that the branch did not have. */
  behind: z.number(),
  /** Paths git could not merge on its own. Empty unless conflicted or refused. */
  conflicts: z.array(z.string()).default([]),
  /**
   * Conflicted paths no agent may touch, which is what turns `conflicted` into
   * `refused`. Non-empty only in that case.
   */
  denied: z.array(z.string()).default([]),
  /** HEAD before the merge — what the branch goes back to if this is abandoned. */
  before: z.string(),
  /** origin/main as it was when the attempt ran. */
  main: z.string(),
  /** One line per commit this merge brings in, newest first. Context for the agent. */
  incoming: z.array(z.string()).default([]),
})
export type MergeState = z.infer<typeof MergeStateSchema>

/**
 * The resolving agent's contract. Deliberately not the full `Result`: this turn
 * does not implement a card, has no acceptance criteria to offer and produces
 * no artifacts, and asking it for those fields would only teach it to invent
 * them.
 */
export const MergeResultSchema = z.object({
  status: z.enum(['resolved', 'unresolved']),
  summary: z.string().min(1),
  /** How each conflict was decided. One entry per file, for the card comment. */
  notes: z.array(z.string()).default([]),
  /** Required when unresolved: what the human has to decide, per conflict. */
  questions: z.array(QuestionSchema).default([]),
})
export type MergeResult = z.infer<typeof MergeResultSchema>

export const MERGE_STATE_PATH = resolve(AGENT_IN, 'merge.json')
export const MERGE_TASK_PATH = resolve(AGENT_IN, 'merge-task.md')
export const MERGE_RESULT_PATH = resolve(AGENT_OUT, 'merge-result.json')

/** Paths git has left unmerged in the index. */
function unmergedPaths(): string[] {
  return git(['diff', '--name-only', '--diff-filter=U'], true)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .sort()
}

/**
 * Paths whose working-tree content differs from the index.
 *
 * This is the whole scope check for a resolving agent, and it works because of
 * how git stages a conflicted merge. Everything main changed that merged
 * cleanly is already *in* the index, so it does not show up here. The conflicted
 * files do, because an unmerged entry always differs. So anything listed that
 * was not conflicted is a file the agent edited on its own initiative — which is
 * the one thing it is not allowed to do.
 */
function dirtyPaths(): string[] {
  return git(['diff', '--name-only'], true)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .sort()
}

/**
 * Tries to merge origin/main into the checked-out branch.
 *
 * Fetches first, always. Local main goes stale within minutes of anything
 * merging, and a merge analysis against a stale main is worse than none: it
 * reports clean and the branch stays behind.
 */
export function attemptMerge(branch: string): MergeState {
  git(['fetch', 'origin', '--quiet'], true)

  const before = headSha()
  const main = git(['rev-parse', 'origin/main']).trim()
  const behindRaw = git(['rev-list', '--count', 'HEAD..origin/main'], true).trim()
  const behind = behindRaw === '' ? 0 : Number.parseInt(behindRaw, 10)

  const base: MergeState = {
    branch,
    state: 'up-to-date',
    behind,
    conflicts: [],
    denied: [],
    before,
    main,
    incoming: [],
  }
  if (behind === 0) return base

  base.incoming = git(['log', '--oneline', '--no-merges', '-n', '20', 'HEAD..origin/main'], true)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')

  // A merge writes a commit, and a commit needs an identity. Set before the
  // attempt rather than after: a clean merge commits immediately.
  identifyAsBot()

  if (gitSucceeds(['merge', '--no-edit', 'origin/main'])) {
    return { ...base, state: 'merged' }
  }

  const conflicts = unmergedPaths()
  if (conflicts.length === 0) {
    // `git merge` failed for something other than a conflict — an unrelated
    // history, a dirty tree, a missing ref. There is nothing for an agent to
    // resolve and pretending otherwise would hand it an empty file list.
    git(['merge', '--abort'], true)
    throw new Error(
      `git merge origin/main into ${branch} failed without leaving a conflict to resolve. ` +
        `The message from git is above.`,
    )
  }

  // The stale-rules problem, undiluted. A conflict inside `factory/` or
  // `.github/` means the branch has edited the machinery that is about to
  // judge it, and no agent gets to arbitrate that — not least because the
  // resolution it wrote would be the code running the next step.
  const denied = conflicts.filter((p) => ALWAYS_DENIED.some((g) => matchesGlob(p, g)))
  if (denied.length > 0) {
    git(['merge', '--abort'], true)
    return { ...base, state: 'refused', conflicts, denied }
  }

  return { ...base, state: 'conflicted', conflicts }
}

/** Puts the branch back exactly as `attemptMerge` found it. */
export function abortMerge(): void {
  git(['merge', '--abort'], true)
}

export function writeMergeState(state: MergeState): void {
  writeFileEnsuringDir(MERGE_STATE_PATH, `${JSON.stringify(state, null, 2)}\n`)
}

export function readMergeState(): MergeState {
  if (!existsSync(MERGE_STATE_PATH)) {
    throw new Error(`${MERGE_STATE_PATH} is missing. Run \`factory merge-begin\` first.`)
  }
  return MergeStateSchema.parse(JSON.parse(readFileSync(MERGE_STATE_PATH, 'utf8')))
}

/**
 * Reads what the resolving agent wrote, treating every way of not writing it as
 * the same thing: it did not resolve the merge.
 *
 * An agent that crashed, ran out of budget or produced malformed JSON has told
 * us nothing about the conflict, and the only safe reading of nothing is that
 * the conflict is still there. The specific failure goes into `summary` so it
 * reaches the card rather than only the run log.
 */
export function readMergeResult(): MergeResult {
  const unresolved = (summary: string): MergeResult => ({
    status: 'unresolved',
    summary,
    notes: [],
    questions: [],
  })

  if (!existsSync(MERGE_RESULT_PATH)) {
    return unresolved('The resolving agent did not write .agent/out/merge-result.json.')
  }
  try {
    const parsed = MergeResultSchema.safeParse(JSON.parse(readFileSync(MERGE_RESULT_PATH, 'utf8')))
    if (parsed.success) return parsed.data
    return unresolved(
      `merge-result.json does not match the contract: ${parsed.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ')}`,
    )
  } catch (error) {
    return unresolved(`merge-result.json is not valid JSON: ${(error as Error).message}`)
  }
}

/**
 * Writes down what `attemptMerge` found, the brief if an agent is needed, and
 * the turn's base.
 *
 * Both entrances to a build turn go through here — `prepare-branch` on turn one
 * and `merge-begin` on every turn after, because build-turn.yml checks the
 * branch out itself and never calls `prepare-branch`. Until now that second
 * entrance did not merge main at all, which meant every turn granted by a
 * comment ran against whatever main looked like when the branch was cut.
 *
 * `base_sha` is the reason this is one function rather than a line in each
 * caller. It is what `validate` diffs the turn against, and the merge moves it:
 *
 *   merged      HEAD is the merge commit, and the base has to be it. Left at the
 *               pre-merge commit, every change main made would be attributed to
 *               the agent — and `validate` would reject the turn for editing
 *               `factory/`, which it did not touch and could not have.
 *   conflicted  there is no commit yet. `merge-finish` records it when there is.
 *   otherwise   HEAD has not moved, so whatever the caller recorded still holds.
 */
export function recordMerge(state: MergeState, key: string, summary: string): MergeState {
  writeMergeState(state)
  if (state.state === 'merged') updateMeta({ base_sha: headSha() })
  if (state.state === 'conflicted') {
    writeFileEnsuringDir(MERGE_TASK_PATH, conflictBrief(state, key, summary))
  }

  const detail: Record<MergeState['state'], string> = {
    'up-to-date': 'already has main',
    merged: `took ${state.behind} commit(s) from main`,
    conflicted: `conflicts in ${state.conflicts.join(', ')} — handing it to an agent`,
    refused: `conflicts in ${state.denied.join(', ')}, which no agent may edit`,
  }
  console.log(`merge: ${state.branch} ${detail[state.state]}`)
  return state
}

/**
 * The brief handed to the resolving agent.
 *
 * It gets the conflicted files, what main did to earn them, and nothing else —
 * no card, no design, no PR thread. That narrowness is deliberate: the job is to
 * reconcile two versions of a few files, and an agent given the card as well
 * starts reasoning about whether the card is still a good idea, which is a
 * question for a person and a much more expensive turn.
 */
export function conflictBrief(state: MergeState, cardKey: string, cardSummary: string): string {
  const lines = [
    '# Resolve a merge',
    '',
    `Branch: \`${state.branch}\` (card ${cardKey} — ${cardSummary})`,
    `Behind main by ${state.behind} commit(s).`,
    '',
    '## What main changed',
    '',
  ]
  if (state.incoming.length === 0) {
    lines.push('_(merges only)_')
  } else {
    for (const line of state.incoming) lines.push(`- ${line}`)
  }

  lines.push(
    '',
    '## The conflicts',
    '',
    'Each of these files is in your working tree right now with git conflict',
    'markers in it. Nothing else in the tree is yours to change.',
    '',
  )
  for (const path of state.conflicts) lines.push(`- \`${path}\``)

  lines.push(
    '',
    'To see the two sides of any one of them:',
    '',
    '```',
    `git show ${state.before.slice(0, 12)}:<path>   # this branch, before the merge`,
    `git show ${state.main.slice(0, 12)}:<path>   # main`,
    '```',
    '',
  )
  return `${lines.join('\n')}\n`
}

export interface FinishOutcome {
  ok: boolean
  /** Why the merge was not committed. Empty when ok. */
  problems: string[]
  /** The merge commit, when one was written. */
  sha: string | null
}

const CONFLICT_MARKER = /^(<{7}|={7}|>{7})(\s|$)/m

/**
 * Commits a resolved merge, or refuses to.
 *
 * Three things have to hold, and each of them has been the failure mode of some
 * other agent pipeline:
 *
 *   the agent says it is done   an `unresolved` result is the agent telling us
 *                               the choice is a product decision. Believe it.
 *   it stayed in the conflict   see `dirtyPaths`. An agent that "while I was in
 *                               here" edits a file main brought in is writing
 *                               unreviewed code into a merge commit, which is
 *                               the single least visible place to put it.
 *   no markers survived         a file with `<<<<<<<` still in it compiles
 *                               about as often as it does not, and when it does
 *                               the damage is silent.
 *
 * Any of them failing leaves the merge uncommitted for the caller to abort. This
 * function does not abort it itself — the caller may want to read the tree
 * first, and unwinding someone else's working state is not this function's call
 * to make.
 */
export function finishMerge(state: MergeState, result: MergeResult): FinishOutcome {
  const problems: string[] = []

  if (result.status === 'unresolved') {
    problems.push(
      result.summary.trim() === ''
        ? 'The resolving agent could not decide how to merge, and said no more than that.'
        : result.summary.trim(),
    )
    return { ok: false, problems, sha: null }
  }

  const allowed = new Set(state.conflicts)
  const strayed = dirtyPaths().filter((p) => !allowed.has(p))
  for (const path of strayed) {
    problems.push(
      `${path} was changed while resolving the merge, and it was not one of the conflicts.`,
    )
  }

  for (const path of state.conflicts) {
    const full = resolve(REPO_ROOT, path)
    // A deleted file is a legitimate resolution: one side removed it.
    if (!existsSync(full)) continue
    if (CONFLICT_MARKER.test(readFileSync(full, 'utf8'))) {
      problems.push(`${path} still has conflict markers in it.`)
    }
  }

  if (problems.length > 0) return { ok: false, problems, sha: null }

  // Only the conflicted paths. Everything else main brought is already staged
  // by the merge, and `git add .` here would sweep up whatever the agent left
  // lying around untracked.
  for (const path of state.conflicts) git(['add', '--', path], true)

  const stillUnmerged = unmergedPaths()
  if (stillUnmerged.length > 0) {
    return {
      ok: false,
      sha: null,
      problems: [`git still considers these unmerged: ${stillUnmerged.join(', ')}.`],
    }
  }

  identifyAsBot()
  // --no-edit takes the merge message git already wrote into MERGE_MSG, so the
  // commit reads like any other merge rather than like an agent artefact.
  git(['commit', '--no-edit'])
  return { ok: true, problems: [], sha: headSha() }
}

/**
 * Turns a merge that could not be finished into a normal turn result.
 *
 * This is the join between the merge flow and everything that already exists.
 * `report --stage build` reads `.agent/out/result.json`, posts it as the card
 * comment and moves the card to Blocked on engineer — which is precisely where
 * a merge nobody can resolve needs to end up. Writing this file rather than
 * inventing a second reporting path means the card gets the same comment shape,
 * the same links, the same release of the assignee, for free.
 */
export function mergeQuestionResult(
  state: MergeState,
  problems: string[],
  result: MergeResult | null,
): Result {
  const files = state.conflicts.join(', ')
  const headline =
    state.state === 'refused'
      ? `Main cannot be merged into this branch: it conflicts in ${state.denied.join(', ')}, ` +
        `which is factory machinery no agent may edit. This needs a person on the branch.`
      : `Main has moved on and this branch cannot take it unaided. The conflict is in ${files}.`

  const questions =
    result !== null && result.questions.length > 0
      ? result.questions
      : [
          {
            question: `How should the conflict in ${files} be resolved?`,
            context: problems.join(' '),
            options: [],
          },
        ]

  return {
    status: 'question',
    summary: headline,
    context:
      `Main is ${state.behind} commit(s) ahead of this branch. The merge was attempted and ` +
      `then undone, so the branch is exactly as it was — but it cannot be merged to main ` +
      `until this is settled. Answer here and the build agent will pick it up.`,
    acceptance_criteria: [],
    // A merge escalation asks rather than delivers: there is nothing it left
    // out, and nothing it was told before it started.
    out_of_scope: [],
    answers: [],
    artifacts: [],
    questions,
    assumptions: result?.notes ?? [],
    reason: problems.join('\n'),
  }
}
