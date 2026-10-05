import { spawnSync } from 'node:child_process'
import { optional, REPO_ROOT } from './env.ts'

export function git(args: string[], allowFailure = false): string {
  const result = spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' })
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`git ${args.join(' ')} failed: ${(result.stderr ?? '').trim()}`)
  }
  return result.stdout ?? ''
}

/**
 * Runs git and reports whether it succeeded, for commands where failure is an
 * outcome to branch on rather than a bug. `git` itself throws, and `git(…,
 * true)` swallows the status along with the failure — neither is usable when
 * the caller has to clean up after a failed command.
 */
export function gitSucceeds(args: string[]): boolean {
  const result = spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' })
  if (result.status !== 0) {
    console.error(`git ${args.join(' ')}: ${(result.stderr ?? '').trim()}`)
  }
  return result.status === 0
}

/**
 * Runs `git commit` with these arguments, and returns null if it landed or
 * what the pre-commit gates said if they refused it.
 *
 * Both of the factory's commits go through the gates, and a refusal is not a
 * crash: it is the reason a turn did not ship, and it belongs on the card.
 * Git sends a hook's output to stderr. Only the end of it is kept, because the
 * gate that refused prints last, and without the colour codes a card cannot
 * show.
 */
export function tryCommit(args: string[]): string | null {
  const result = spawnSync('git', ['commit', ...args], { cwd: REPO_ROOT, encoding: 'utf8' })
  if (result.status === 0) return null
  const said = `${result.stdout ?? ''}${result.stderr ?? ''}`
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;]*m/g, '')
    .trim()
    .split('\n')
  return said.slice(-30).join('\n')
}

export function currentBranch(): string {
  return git(['rev-parse', '--abbrev-ref', 'HEAD']).trim()
}

/**
 * Gives this checkout the factory's git identity.
 *
 * Any command that writes a commit needs one, and three of them do: `publish`
 * commits the turn's output, `prepare-branch` commits a merge from main, and
 * `merge-finish` commits a resolved one. They all have to agree — a commit
 * authored by "runner" is a commit no reviewer can attribute — so the spelling
 * of the address lives here rather than three times over.
 */
export function identifyAsBot(): string {
  const login = optional('FACTORY_BOT_LOGIN', 'factory[bot]')
  git(['config', 'user.name', login])
  git(['config', 'user.email', `${login.replace(/\[bot\]$/, '')}[bot]@users.noreply.github.com`])
  return login
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
