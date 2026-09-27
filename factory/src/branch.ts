import { git, headSha, remoteBranchExists } from './git.ts'
import { updateMeta } from './meta.ts'

/** `DF-12 Let the user type their name` -> `df-12-let-the-user-type-their-name` */
export function slugify(value: string, maxLength = 48): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug.length <= maxLength ? slug : slug.slice(0, maxLength).replace(/-+$/, '')
}

/**
 * One branch per card, not one per stage.
 *
 * The design turn opens it, the build turns commit to it, and the single pull
 * request it carries lives for as long as the card does. That is what puts the
 * design document in the build agent's working tree: it is simply already
 * there, committed by the stage before. No merge to main, no copying, and no
 * window in which the build turn can start against a design that has not
 * landed.
 *
 * The stage still decides what a turn may write — see ALLOWED_PATHS — so a
 * build turn sharing a branch with the design still cannot edit the design.
 */
export function branchName(key: string, summary: string): string {
  return `card/${key}-${slugify(summary)}`
}

/**
 * Checks out the card's branch: the existing remote one if there is one (so
 * every turn after the first continues the same branch and the same PR), a
 * fresh branch cut from origin/main otherwise.
 *
 * This does NOT bring the branch up to main, and a turn is not safe to run
 * until something does. The agent's manual, the result schema and the factory's
 * own code all live in the checked-out tree — `claude -p "$(cat
 * .agent/design.md)"` reads the branch's copy and `npm run factory` executes the
 * branch's TypeScript — so a branch cut a fortnight ago runs a fortnight-old
 * prompt against a fortnight-old validator, and a fix to either silently does
 * not reach any card in flight. That is the worst kind of bug: the fix looks
 * applied everywhere you check.
 *
 * `merge-begin` is what does it, and every workflow that calls this calls that
 * immediately afterwards — by way of `.github/actions/merge-main`, which also
 * carries the agent that resolves a conflict. It used to happen here instead,
 * which read better but could not work: resolving a conflict needs a model, a
 * model needs a credential, and a credential needs a workflow step of its own.
 *
 * The HEAD it settles on is recorded as the turn's base, so everything already
 * on the branch is the turn's inheritance rather than its output — which is what
 * lets a build turn share a branch with the design that preceded it. The merge
 * moves that base on again if it produces a commit; see `recordMerge`.
 */
export function prepareBranch(key: string, summary: string): string {
  const branch = branchName(key, summary)
  git(['fetch', 'origin', '--quiet'], true)

  const from = remoteBranchExists(branch) ? `origin/${branch}` : 'origin/main'
  git(['checkout', '-B', branch, from])
  updateMeta({ branch, base_sha: headSha() })
  return branch
}
