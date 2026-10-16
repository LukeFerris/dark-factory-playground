import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach } from 'vitest'
import { TURN_REF, UNCOMMITTED_PATH } from './accept.ts'
import { REPO_ROOT } from './env.ts'
import { MERGE_RESULT_PATH, writeMergeState, type MergeState } from './merge.ts'
import { RESULT_PATH, writeFileEnsuringDir, writeMeta } from './meta.ts'

/**
 * Real repositories, because what is under test is what git makes of an
 * agent's history. Each test has a card repository (the publishing job's
 * checkout, at REPO_ROOT) and an agent clone of it (the agent job's), and hands
 * the one to the other as a bundle, as the workflow does.
 *
 * Not a test file itself, so the tests that use it are what cover it. A test
 * file points FACTORY_REPO_ROOT at a scratch directory before importing this.
 */

export const BRANCH = 'card/DF-9-say-hello'

const IDENTITY = [
  '-c',
  'user.name=t',
  '-c',
  'user.email=t@example.com',
  '-c',
  'commit.gpgsign=false',
]
/** Who the agent job tells git it is. */
export const asFactory = (as = 'factory[bot]'): string[] => [
  '-c',
  `user.name=${as}`,
  '-c',
  `user.email=${as}@users.noreply.github.com`,
]

export const run = (cwd: string, ...args: string[]): string =>
  execFileSync('git', [...IDENTITY, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
export const write = (dir: string, path: string, body: string | Buffer): void => {
  mkdirSync(join(dir, path, '..'), { recursive: true })
  writeFileSync(join(dir, path), body)
}
// Tools that watch git through trace2, such as git-ai, write into a repository
// just after a commit, and a test that deletes it then fails. So the suite's
// git, and the factory's, tells them nothing.
process.env['GIT_TRACE2_EVENT'] = '0'

export const remove = (dir: string): void =>
  rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
export const commit = (dir: string, message: string): string => {
  run(dir, 'add', '-A')
  run(dir, 'commit', '-q', '--allow-empty', '-m', message)
  return run(dir, 'rev-parse', 'HEAD')
}

/** The current test's repositories and the commits it starts from. */
export const card = { scratch: '', agent: '', bundle: '', before: '', main: '' }

/** A commit the agent makes, as the factory unless `as` says otherwise. */
export const agentCommit = (message: string, as?: string): string => {
  run(card.agent, 'add', '-A')
  run(card.agent, ...asFactory(as), 'commit', '-q', '-m', message)
  return run(card.agent, 'rev-parse', 'HEAD')
}

/** Points the card at `before`, and gives the agent a fresh clone of it. */
export function cloneForTheAgent(): void {
  remove(card.agent)
  run(card.scratch, 'clone', '-q', REPO_ROOT, card.agent)
  run(card.agent, 'checkout', '-q', BRANCH)
  writeMeta({
    key: 'DF-9',
    stage: 'build',
    turn: 2,
    branch: BRANCH,
    base_sha: card.before,
    pr: 9,
    preview_url: null,
  })
}

/**
 * A card branch one design commit past the start, and a main one commit past
 * it in another file, so main merges in cleanly.
 */
export function useCardRepos(): void {
  beforeEach(() => {
    remove(REPO_ROOT)
    mkdirSync(REPO_ROOT)
    card.scratch = mkdtempSync(join(tmpdir(), 'accept-agent-'))
    card.agent = join(card.scratch, 'agent')
    card.bundle = join(card.scratch, 'turn.bundle')

    run(REPO_ROOT, 'init', '-q', '-b', 'main')
    write(REPO_ROOT, 'app/src/greeting.ts', 'export const greeting = "hi"\n')
    write(REPO_ROOT, 'app/src/colour.ts', 'export const colour = "red"\n')
    commit(REPO_ROOT, 'start')
    run(REPO_ROOT, 'checkout', '-q', '-b', BRANCH)
    write(REPO_ROOT, 'app/src/greeting.ts', 'export const greeting = "hello"\n')
    card.before = commit(REPO_ROOT, 'DF-9: design')
    run(REPO_ROOT, 'checkout', '-q', 'main')
    write(REPO_ROOT, 'app/src/colour.ts', 'export const colour = "blue"\n')
    card.main = commit(REPO_ROOT, 'DF-7: paint it blue')
    run(REPO_ROOT, 'checkout', '-q', BRANCH)
    cloneForTheAgent()
  })

  afterEach(() => {
    remove(card.scratch)
    rmSync(RESULT_PATH, { force: true })
    rmSync(MERGE_RESULT_PATH, { force: true })
    rmSync(UNCOMMITTED_PATH, { force: true })
  })
}

export const mergeState = (over: Partial<MergeState>): void =>
  writeMergeState({
    branch: BRANCH,
    state: 'merged',
    behind: 1,
    conflicts: [],
    denied: [],
    before: card.before,
    main: card.main,
    incoming: [],
    ...over,
  })

/**
 * What the agent job does after its agent has finished: lists what it left
 * uncommitted, and bundles its commits if there are any.
 */
export function packageTurn(): void {
  run(card.agent, 'branch', '-f', TURN_REF)
  writeFileEnsuringDir(UNCOMMITTED_PATH, run(card.agent, 'status', '--porcelain'))
  if (run(card.agent, 'rev-parse', 'HEAD') !== card.before) {
    run(card.agent, 'bundle', 'create', '-q', card.bundle, TURN_REF, `^${card.before}`)
  }
}

export const status = (): string => run(REPO_ROOT, 'status', '--porcelain')
/** The parents of `ref` in the card repository. */
export const parentsOf = (ref: string): string[] =>
  run(REPO_ROOT, 'rev-list', '--parents', '-n', '1', ref).split(' ').slice(1)
