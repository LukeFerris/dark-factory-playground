import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, vi } from 'vitest'

/**
 * Throwaway git repositories for the tests that drive real git: a bare
 * "origin", and a clone of it to work in.
 *
 * Not a test file itself, so the tests that use it are what cover it. Pointing
 * REPO_ROOT at the clone stays in each test file, because `vi.mock` is hoisted
 * to the top of the file that calls it and cannot be shared from here.
 */

/** Runs git in `cwd` and returns what it printed. */
export function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' })
}

/** Writes a file inside the checkout, making its directories as needed. */
export function writeIn(work: string, path: string, body: string): void {
  mkdirSync(dirname(join(work, path)), { recursive: true })
  writeFileSync(join(work, path), body)
}

/** One commit of one file. */
export interface Seed {
  path: string
  body: string
  message: string
}

/** Writes, stages and commits one file. */
export function commitIn(work: string, { path, body, message }: Seed): void {
  writeIn(work, path, body)
  sh(work, 'add', '--', path)
  sh(work, 'commit', '--quiet', '-m', message)
}

/** The repository a test is running against. Replaced before every test. */
export interface ScratchRepo {
  /** The temporary directory holding both repositories. */
  scratch: string
  /** The clone, which is what REPO_ROOT should point at. */
  work: string
}

// A pre-commit hook exports these, and they would point every git command at
// the outer repository's index instead of the temporary one.
const HOOK_VARS = ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE', 'GIT_PREFIX']

function clearHookVars(): void {
  beforeAll(() => {
    for (const name of HOOK_VARS) vi.stubEnv(name, undefined)
  })
  afterAll(() => {
    vi.unstubAllEnvs()
  })
}

/** A bare origin with `seeds` committed on main, and a clone of it to work in. */
function makeRepo(prefix: string, seeds: Seed[]): ScratchRepo {
  const scratch = mkdtempSync(join(tmpdir(), prefix))
  const origin = join(scratch, 'origin.git')
  const work = join(scratch, 'work')
  sh(scratch, 'init', '--quiet', '--bare', '-b', 'main', origin)
  sh(scratch, 'init', '--quiet', '-b', 'main', work)
  sh(work, 'config', 'user.name', 'Test')
  sh(work, 'config', 'user.email', 'test@example.com')
  sh(work, 'config', 'commit.gpgsign', 'false')
  sh(work, 'config', 'core.hooksPath', '/dev/null')
  sh(work, 'remote', 'add', 'origin', origin)
  for (const seed of seeds) commitIn(work, seed)
  sh(work, 'push', '--quiet', 'origin', 'main')
  return { scratch, work }
}

/**
 * A fresh repository for every test in the file that calls it, with `root.path`
 * pointed at the clone, and the hook's variables cleared for the whole file.
 * The object returned is updated in place before each test.
 */
export function useScratchRepo(
  prefix: string,
  root: { path: string },
  seeds: Seed[] = [{ path: 'README.md', body: 'hello\n', message: 'initial' }],
): ScratchRepo {
  const repo: ScratchRepo = { scratch: '', work: '' }
  clearHookVars()
  beforeEach(() => {
    Object.assign(repo, makeRepo(prefix, seeds))
    root.path = repo.work
  })
  afterEach(() => {
    rmSync(repo.scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })
  return repo
}

/** Installs an executable `pre-commit` hook in the clone, in place of none. */
export function installPreCommit(repo: ScratchRepo, script: string): void {
  const hooks = join(repo.scratch, 'hooks')
  mkdirSync(hooks)
  writeFileSync(join(hooks, 'pre-commit'), script, { mode: 0o755 })
  sh(repo.work, 'config', 'core.hooksPath', hooks)
}
