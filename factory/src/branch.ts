import { optional } from './env.ts'
import { git, gitSucceeds, headSha, remoteBranchExists } from './git.ts'
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
 * Brings a reused branch up to date with main before the turn runs.
 *
 * This is not housekeeping. The agent's manual, the result schema and the
 * factory's own code all live in the checked-out tree — `claude -p "$(cat
 * .agent/design.md)"` reads the branch's copy, and `npm run factory` executes
 * the branch's TypeScript. A branch cut a fortnight ago therefore runs a
 * fortnight-old prompt against a fortnight-old validator, and a fix to either
 * silently does not reach any card already in flight. That is the worst kind of
 * bug: the fix looks applied everywhere you check.
 *
 * A conflict stops the turn rather than resolving itself. The only files an
 * agent commits are its own design or build output, so a conflict here means
 * something genuinely needs a human, and running the turn anyway would run it
 * against exactly the stale rules this exists to prevent.
 */
function mergeMainInto(branch: string): void {
  const behind = git(['rev-list', '--count', 'HEAD..origin/main'], true).trim()
  if (behind === '' || behind === '0') return

  // Merging writes a commit, which needs an identity. `publish` sets the same
  // one later; it has not run yet.
  const botLogin = optional('FACTORY_BOT_LOGIN', 'factory[bot]')
  git(['config', 'user.name', botLogin])
  git(['config', 'user.email', `${botLogin.replace(/\[bot\]$/, '')}[bot]@users.noreply.github.com`])

  console.log(`prepare-branch: ${branch} is ${behind} commit(s) behind main; merging.`)
  if (!gitSucceeds(['merge', '--no-edit', 'origin/main'])) {
    git(['merge', '--abort'], true)
    throw new Error(
      `Could not merge origin/main into ${branch}: the merge conflicts. Resolve it on the ` +
        `branch by hand. The turn is not safe to run until then — it would use the manual and ` +
        `the validator as they were when the branch was cut.`,
    )
  }
}

/**
 * Checks out the card's branch: the existing remote one if there is one (so
 * every turn after the first continues the same branch and the same PR), a
 * fresh branch cut from origin/main otherwise.
 *
 * A reused branch is merged up to main first — see `mergeMainInto`. A fresh one
 * is cut from main and needs nothing.
 *
 * The HEAD it settles on is recorded as the turn's base. Everything already on
 * the branch is therefore the turn's inheritance rather than its output, which
 * is what lets a build turn share a branch with the design that preceded it.
 */
export function prepareBranch(key: string, summary: string): string {
  const branch = branchName(key, summary)
  git(['fetch', 'origin', '--quiet'], true)

  if (remoteBranchExists(branch)) {
    git(['checkout', '-B', branch, `origin/${branch}`])
    mergeMainInto(branch)
  } else {
    git(['checkout', '-B', branch, 'origin/main'])
  }

  updateMeta({ branch, base_sha: headSha() })
  return branch
}
