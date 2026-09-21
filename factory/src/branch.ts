import { git, remoteBranchExists } from './git.ts'
import { updateMeta } from './meta.ts'
import type { Stage } from './schema.ts'

/** `DF-12 Let the user type their name` -> `df-12-let-the-user-type-their-name` */
export function slugify(value: string, maxLength = 48): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug.length <= maxLength ? slug : slug.slice(0, maxLength).replace(/-+$/, '')
}

export function branchName(stage: Stage, key: string, summary: string): string {
  return `${stage}/${key}-${slugify(summary)}`
}

/**
 * Checks out the stage's branch: the existing remote one if there is one (so a
 * second design turn updates the same PR instead of opening a new one), a fresh
 * branch cut from origin/main otherwise.
 */
export function prepareBranch(stage: Stage, key: string, summary: string): string {
  const branch = branchName(stage, key, summary)
  git(['fetch', 'origin', '--quiet'], true)

  if (remoteBranchExists(branch)) {
    git(['checkout', '-B', branch, `origin/${branch}`])
  } else {
    git(['checkout', '-B', branch, 'origin/main'])
  }

  updateMeta({ branch })
  return branch
}
