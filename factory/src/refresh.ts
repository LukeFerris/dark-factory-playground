import { spawnSync } from 'node:child_process'
import { REPO_ROOT, prUrl, runUrl } from './env.ts'
import * as adf from './adf.ts'
import * as jira from './jira.ts'
import { currentBranch, git } from './git.ts'
import { dispatchWorkflow, findPrForCard } from './github.ts'
import { abortMerge, attemptMerge, type MergeState } from './merge.ts'

/**
 * Keeping the cards in review from going stale.
 *
 * A card sitting in "In review" is waiting on a person, and a person can take
 * days. Meanwhile other cards merge. By the time anyone comes back to it the
 * branch was written against a main that no longer exists: the preview shows a
 * world two merges old, the approval is on a diff that will not apply, and the
 * conflict surfaces at the merge button — the one moment when nobody has any
 * context loaded and the obvious move is to force it through.
 *
 * So every merge to main fans out over every card still in review and brings
 * each one forward. Three things can happen to a branch, and the split between
 * them is the whole design:
 *
 *   nothing        the branch already had main. Say nothing: a card that
 *                  collects a comment every time an unrelated card merges is a
 *                  card nobody reads.
 *   it just works  git merges it, the checks still pass on the result, and the
 *                  merge is pushed. The card gets told, because the pull
 *                  request it is pointing at now says something different from
 *                  what the reviewer last looked at.
 *   it does not    either git conflicts, or the merge is clean and the tests go
 *                  red on it — which is the same problem wearing a disguise,
 *                  two cards that are individually correct and jointly wrong.
 *                  The card goes back to Building and the build agent resolves
 *                  it, because that is where the agent that can resolve it
 *                  lives. Only if *it* cannot decide does a human get asked,
 *                  and then about the specific conflict rather than about the
 *                  merge in general.
 *
 * There is no agent in this file. A clean merge needs judgement from nobody, and
 * spending a model on one per card per merge would be the expensive way to do
 * nothing. The judgement happens one layer down, in the build turn this hands
 * to — see `merge.ts`.
 */

/** The pull request whose merge set this off. */
export interface Trigger {
  number: number
  title: string
}

export interface RefreshTarget {
  key: string
  pr: number
  branch: string
}

/**
 * Every card a merge to main could have invalidated.
 *
 * Read from Jira rather than from the open pull requests, because "in review"
 * is a statement about where the work has got to and the board is where that
 * lives. A card in review with no open pull request is a card mid-teardown or
 * mid-mistake; it is skipped with a warning rather than failing the fan-out.
 */
export async function refreshTargets(
  cfg: jira.JiraConfig,
  projectKey: string,
  exclude: string[] = [],
): Promise<RefreshTarget[]> {
  const cards = await jira.search(
    cfg,
    `project = ${projectKey} AND status = "In review" ORDER BY created ASC`,
    ['summary'],
  )

  const targets: RefreshTarget[] = []
  for (const card of cards) {
    if (exclude.includes(card.key)) continue
    const pr = findPrForCard(card.key)
    if (pr === null) {
      console.warn(`::warning::${card.key} is In review but has no open pull request; skipping.`)
      continue
    }
    targets.push({ key: card.key, pr: pr.number, branch: pr.headRefName })
  }
  return targets
}

/** The scripts that have to still pass on the merged tree, in the order ci.yml runs them. */
export const CHECK_SCRIPTS = ['lint', 'typecheck', 'test', 'build'] as const

export interface CheckOutcome {
  ok: boolean
  /** The script that failed, or null. */
  failed: string | null
}

export type Checks = () => CheckOutcome

/**
 * ci.yml, run locally against the merged tree.
 *
 * `npm ci` first and not optionally: the merge may have brought a new
 * `package-lock.json` across, and running the old `node_modules` against the new
 * lockfile tests a combination that will never exist again.
 *
 * This is the check the fan-out would be useless without. Two cards that touch
 * different files merge cleanly and still contradict each other — one renames
 * what the other calls — and git has no opinion about that at all. Without this
 * the fan-out would confidently push a branch that does not build.
 */
export const npmChecks: Checks = () => {
  const run = (args: string[]): boolean =>
    spawnSync('npm', args, { cwd: REPO_ROOT, stdio: 'inherit' }).status === 0

  if (!run(['ci'])) return { ok: false, failed: 'npm ci' }
  for (const script of CHECK_SCRIPTS) {
    if (!run(['run', script])) return { ok: false, failed: `npm run ${script}` }
  }
  return { ok: true, failed: null }
}

function trailer(pr: number | null, run: string | null): adf.AdfNode[] {
  const links: adf.AdfNode[] = []
  const url = prUrl(pr)
  if (url !== null) links.push(adf.link('Pull request', url))
  if (run !== null) {
    if (links.length > 0) links.push(adf.text('  ·  '))
    links.push(adf.link('Actions run', run))
  }
  return links.length > 0 ? [adf.paragraph(...links)] : []
}

/**
 * What the card says when the merge worked.
 *
 * It names the pull request that caused it, because the reviewer's next thought
 * is "what changed, and do I care" and the answer is a link away. And it says
 * the approval is gone, because the repository ruleset dismisses reviews on
 * push and a reviewer who approved this yesterday will otherwise assume it is
 * still approved.
 */
export function refreshedComment(
  because: Trigger,
  state: MergeState,
  pr: number,
  run: string | null,
): adf.AdfDoc {
  return adf.doc(
    adf.paragraph(
      adf.strong('Main has changed.'),
      adf.text(
        ` ${because.title} merged as PR #${because.number}, so those changes have been merged ` +
          `into this card's branch and pushed.`,
      ),
    ),
    adf.paragraph(
      adf.text(
        `${state.behind} commit(s) came across. Nothing conflicted, and lint, typecheck, tests ` +
          `and build all still pass on the merged branch — so what is on the pull request now is ` +
          `this card's work on top of current main.`,
      ),
    ),
    adf.paragraph(
      adf.text(
        'Pushing to the branch dismisses any approval that was already on the pull request. It ' +
          'needs approving again before it can merge.',
      ),
    ),
    ...trailer(pr, run),
  )
}

/**
 * What the card says when it is going back to Building.
 *
 * Deliberately not phrased as a question. Nobody is being asked anything yet —
 * the build agent is about to try, and most of the time it succeeds and the card
 * comes straight back. Asking here as well would train people to ignore it.
 */
export function handOverComment(
  because: Trigger,
  reason: string,
  pr: number,
  run: string | null,
): adf.AdfDoc {
  return adf.doc(
    adf.paragraph(
      adf.strong('Main has changed and this branch cannot take it as it stands.'),
      adf.text(` ${because.title} merged as PR #${because.number}. ${reason}`),
    ),
    adf.paragraph(
      adf.text(
        'The card is going back to Building so the build agent can work it through. Nothing has ' +
          'been pushed and the branch is exactly as you left it. If the answer turns out to be a ' +
          'decision rather than a merge, the agent will ask here and the card will come back to ' +
          'you.',
      ),
    ),
    ...trailer(pr, run),
  )
}

/** What the card says when no agent is allowed near the conflict. */
export function refusedComment(
  because: Trigger,
  state: MergeState,
  pr: number,
  run: string | null,
): adf.AdfDoc {
  return adf.doc(
    adf.paragraph(
      adf.strong('Main cannot be merged into this branch.'),
      adf.text(
        ` ${because.title} merged as PR #${because.number}, and merging it here conflicts in ` +
          `${state.denied.join(', ')}.`,
      ),
    ),
    adf.paragraph(
      adf.text(
        'Those are factory machinery, which no agent may edit — including the agent that would ' +
          'otherwise resolve this, whose own code is in the conflict. Someone needs to merge ' +
          'main into the branch by hand.',
      ),
    ),
    ...trailer(pr, run),
  )
}

export type RefreshState = 'up-to-date' | 'refreshed' | 'handed-to-build' | 'refused'

export interface RefreshOptions {
  key: string
  because: Trigger
  cfg: jira.JiraConfig
  /** Swapped out in tests so nothing shells out to npm. */
  checks?: Checks
  dryRun?: boolean
}

export interface RefreshOutcome {
  state: RefreshState
  /** One line for the workflow log. */
  detail: string
}

/**
 * Brings one card in review up to main.
 *
 * Runs on a checkout of the card's own branch, which the workflow has already
 * made — the fan-out is one job per card and each gets its own runner, which is
 * what makes "parallel" true rather than decorative.
 */
export async function refresh(options: RefreshOptions): Promise<RefreshOutcome> {
  const { key, because, cfg } = options
  const pr = findPrForCard(key)
  if (pr === null) throw new Error(`${key} has no open pull request to refresh.`)

  const branch = currentBranch()
  const state = attemptMerge(branch)

  if (state.state === 'up-to-date') {
    return { state: 'up-to-date', detail: `${key} already had main; nothing to do.` }
  }

  if (state.state === 'refused') {
    await say(options, refusedComment(because, state, pr.number, runUrl()), 'Blocked on engineer')
    return { state: 'refused', detail: `${key} conflicts in ${state.denied.join(', ')}; a human has it.` }
  }

  if (state.state === 'conflicted') {
    abortMerge()
    const reason = `Merging main into this branch conflicts in ${state.conflicts.join(', ')}.`
    await handToBuild(options, pr.number, reason)
    return { state: 'handed-to-build', detail: `${key} conflicts in ${state.conflicts.join(', ')}.` }
  }

  // Merged cleanly. Whether that means anything is the next question.
  const checks = (options.checks ?? npmChecks)()
  if (!checks.ok) {
    // Back to exactly where the branch was. `--hard` is safe here and only
    // here: this runner checked the branch out thirty seconds ago and nothing
    // but the merge has touched it.
    git(['reset', '--hard', state.before])
    const reason =
      `Main merges into it cleanly, but \`${checks.failed}\` then fails on the result — so the ` +
      `two changes are individually fine and jointly not.`
    await handToBuild(options, pr.number, reason)
    return { state: 'handed-to-build', detail: `${key} merged clean but ${checks.failed} failed.` }
  }

  if (options.dryRun === true) {
    console.log(`refresh --dry-run: would push ${branch} and comment on ${key}`)
    return { state: 'refreshed', detail: `${key} would be refreshed (dry run).` }
  }

  git(['push', 'origin', `HEAD:refs/heads/${branch}`])
  await comment(cfg, key, refreshedComment(because, state, pr.number, runUrl()))
  return { state: 'refreshed', detail: `${key} took ${state.behind} commit(s) from main.` }
}

/**
 * Moves the card, says why, and starts the turn — in that order, and for the
 * reasons `triage.act` sets out at length: the transition is the step that can
 * legitimately fail, and failing it before anything has been said leaves a card
 * that is merely unchanged rather than one that is lying.
 *
 * The dispatch is last and is the one failure worth shouting about: a card in
 * Building with nothing running waits forever.
 */
async function handToBuild(options: RefreshOptions, pr: number, reason: string): Promise<void> {
  const { key, because, cfg } = options

  if (options.dryRun === true) {
    console.log(`refresh --dry-run: would move ${key} to Building — ${reason}`)
    return
  }

  try {
    await jira.transitionTo(cfg, key, 'Building')
  } catch (error) {
    console.error(`::warning::could not move ${key} to Building: ${(error as Error).message}`)
    return
  }

  await comment(cfg, key, handOverComment(because, reason, pr, runUrl()))

  try {
    dispatchWorkflow('build-turn.yml', { key })
  } catch (error) {
    console.error(
      `::error::${key} was moved to Building but build-turn.yml could not be dispatched ` +
        `(${(error as Error).message}); re-run it by hand`,
    )
  }
}

/** Comment and move, for the paths that do not start a turn. */
async function say(options: RefreshOptions, body: adf.AdfDoc, status: string): Promise<void> {
  if (options.dryRun === true) {
    console.log(`refresh --dry-run: would move ${options.key} to ${status} and comment`)
    return
  }
  try {
    await jira.transitionTo(options.cfg, options.key, status)
  } catch (error) {
    console.error(
      `::warning::could not move ${options.key} to ${status}: ${(error as Error).message}`,
    )
  }
  await comment(options.cfg, options.key, body)
}

/** A comment that fails is worth a warning, not a failed fan-out leg. */
async function comment(cfg: jira.JiraConfig, key: string, body: adf.AdfDoc): Promise<void> {
  await jira.addComment(cfg, key, body).catch((error: Error) => {
    console.error(`::warning::could not comment on ${key}: ${error.message}`)
  })
}
