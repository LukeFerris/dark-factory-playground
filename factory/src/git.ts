import { spawnSync } from 'node:child_process'
import { REPO_ROOT } from './env.ts'

export function git(args: string[], allowFailure = false): string {
  const result = spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' })
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`git ${args.join(' ')} failed: ${(result.stderr ?? '').trim()}`)
  }
  return result.stdout ?? ''
}

export function currentBranch(): string {
  return git(['rev-parse', '--abbrev-ref', 'HEAD']).trim()
}

export function headSha(): string {
  return git(['rev-parse', 'HEAD']).trim()
}

/** Files changed on this branch relative to origin/main, staged and unstaged alike. */
export function changedFiles(base = 'origin/main'): string[] {
  git(['fetch', 'origin', 'main', '--quiet'], true)
  const committed = git(['diff', '--name-only', `${base}...HEAD`], true)
  const working = git(['status', '--porcelain'], true)
  const fromStatus = working
    .split('\n')
    .map((l) => l.slice(3).trim())
    .filter((l) => l !== '')
    // A rename shows as "old -> new"; only the destination matters for scope.
    .map((l) => (l.includes(' -> ') ? (l.split(' -> ')[1] as string) : l))

  return [...new Set([...committed.split('\n'), ...fromStatus])]
    .map((f) => f.trim())
    .filter((f) => f !== '')
    .sort()
}

export function remoteBranchExists(branch: string): boolean {
  const out = git(['ls-remote', '--heads', 'origin', branch], true)
  return out.trim() !== ''
}
