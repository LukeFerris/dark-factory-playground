import { spawnSync } from 'node:child_process'
import type * as childProcess from 'node:child_process'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { git, identifyAsBot } from './git.ts'
import { ghRunner, parseFactoryBlock, setRunner, type PullRequest } from './github.ts'
import { RESULT_PATH, readMeta, writeFileEnsuringDir, writeMeta, type Meta } from './meta.ts'
import { publish } from './publish.ts'
import type { Result } from './schema.ts'

/**
 * `publish` from the result file to the pull request.
 *
 * git and npm are stubbed — committing and pushing are git's business and are
 * tested against a real repository in `git.test.ts` — and `gh` is answered by
 * a runner that remembers every call. What is under test is the order of
 * things and what reaches GitHub: which PR is opened or edited, which labels go
 * on, and when it leaves draft.
 */

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof childProcess>()),
  spawnSync: vi.fn(() => ({ status: 0 })),
}))
vi.mock('./git.ts', () => ({
  git: vi.fn(() => ''),
  identifyAsBot: vi.fn(),
}))

const npm = vi.mocked(spawnSync)
const gitCalls = vi.mocked(git)

const BRANCH = 'card/DF-9-add-a-close-date'
const previousRepo = process.env['GITHUB_REPOSITORY']
beforeAll(() => {
  process.env['GITHUB_REPOSITORY'] = 'acme/dark-factory-playground'
})
afterAll(() => {
  if (previousRepo === undefined) delete process.env['GITHUB_REPOSITORY']
  else process.env['GITHUB_REPOSITORY'] = previousRepo
})

function meta(over: Partial<Meta> = {}): void {
  writeMeta({
    key: 'DF-9',
    stage: 'build',
    turn: 2,
    branch: BRANCH,
    base_sha: 'abc',
    pr: null,
    preview_url: null,
    ...over,
  })
}

function result(over: Partial<Result> = {}): void {
  const full: Result = {
    status: 'ready_for_review',
    summary: 'Added the close date.\nWith more detail below.',
    context: '',
    acceptance_criteria: [],
    out_of_scope: [],
    answers: [],
    artifacts: [],
    questions: [],
    assumptions: [],
    reason: '',
    ...over,
  }
  writeFileEnsuringDir(RESULT_PATH, JSON.stringify(full))
}

/** git as publish sees it: what the lockfile's status is, and a branch checked out. */
function stage(lockfile: string, current = BRANCH): void {
  gitCalls.mockImplementation((args) => {
    if (args[0] === 'status') return lockfile
    if (args[0] === 'branch') return `${current}\n`
    return ''
  })
}

let gh: string[][] = []
let bodies: string[] = []

/** A GitHub with at most one open PR for the branch, created on demand. */
function github(existing: PullRequest | null): void {
  let open = existing
  setRunner((args, input) => {
    gh.push(args)
    if (input !== undefined) bodies.push(input)
    if (args[0] === 'pr' && args[1] === 'create') {
      open = {
        number: 31,
        url: 'https://github.com/x/pull/31',
        body: '',
        isDraft: true,
        headRefOid: 'f',
      }
    }
    const stdout = args[0] === 'pr' && args[1] === 'list' ? JSON.stringify(open ? [open] : []) : ''
    return { status: 0, stdout, stderr: '' }
  })
}

/** Every gh call, without the `--repo` every one of them carries. */
const said = (): string[] =>
  gh.map((args) => args.filter((a, i) => a !== '--repo' && args[i - 1] !== '--repo').join(' '))

beforeEach(() => {
  gh = []
  bodies = []
  meta()
  result()
  stage('')
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => {
  setRunner(ghRunner)
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

describe('committing the turn', () => {
  // The agent made its own commits, through the hook, and accept put them on
  // the branch (ADR 0011). publish has nothing of the turn's to commit.
  it('commits nothing of a design turn', () => {
    github(null)
    publish({ stage: 'design', cardSummary: 'Add a close date', dryRun: true })

    expect(identifyAsBot).not.toHaveBeenCalled()
    expect(gitCalls.mock.calls.some(([args]) => args[0] === 'add' || args[0] === 'commit')).toBe(
      false,
    )
  })

  it('commits the lockfile, as the bot, when regenerating it changed it', () => {
    stage(' M package-lock.json\n')
    publish({ stage: 'build', cardSummary: 'Add a close date', dryRun: true })

    expect(identifyAsBot).toHaveBeenCalled()
    expect(gitCalls).toHaveBeenCalledWith(['add', '--', 'package-lock.json'])
    expect(gitCalls).toHaveBeenCalledWith([
      'commit',
      '--no-verify',
      '-m',
      'DF-9: Bring the lockfile up to date',
    ])
  })

  it('commits nothing when the lockfile was already up to date', () => {
    stage('')
    publish({ stage: 'build', cardSummary: 'Add a close date', dryRun: true })

    expect(gitCalls.mock.calls.some(([args]) => args[0] === 'commit')).toBe(false)
  })

  // The agent may have added a dependency and cannot run npm install itself.
  // The job holds tokens, so none of the package's scripts run (ADR 0008).
  it('regenerates the lockfile on a build turn, and only then, without scripts', () => {
    publish({ stage: 'design', cardSummary: 'Add a close date', dryRun: true })
    expect(npm).not.toHaveBeenCalled()

    publish({ stage: 'build', cardSummary: 'Add a close date', dryRun: true })
    expect(npm).toHaveBeenCalledWith(
      'npm',
      [
        'install',
        '--package-lock-only',
        '--ignore-scripts',
        '--workspaces',
        '--include-workspace-root',
      ],
      expect.objectContaining({ stdio: 'inherit' }),
    )
  })

  it('stops before committing when the lockfile cannot be regenerated', () => {
    npm.mockReturnValueOnce({ status: 1 } as ReturnType<typeof spawnSync>)
    expect(() => publish({ stage: 'build', cardSummary: 'Add a close date' })).toThrow(
      'npm install --package-lock-only failed; the lockfile is out of date.',
    )
    expect(identifyAsBot).not.toHaveBeenCalled()
  })
})

describe('pushing', () => {
  it('stops short of the push on a dry run', () => {
    github(null)
    expect(publish({ stage: 'build', cardSummary: 'Add a close date', dryRun: true })).toBeNull()
    expect(console.log).toHaveBeenCalledWith(`publish --dry-run: would push ${BRANCH}`)
    expect(gitCalls.mock.calls.some(([args]) => args[0] === 'push')).toBe(false)
    expect(gh).toEqual([])
  })

  // gather in a build turn may predate the branch being recorded at all.
  it('falls back to the checked-out branch when none was recorded', () => {
    meta({ branch: '' })
    stage('', 'card/DF-9-from-head')
    github(null)
    publish({ stage: 'build', cardSummary: 'Add a close date' })
    expect(gitCalls).toHaveBeenCalledWith([
      'push',
      '--set-upstream',
      'origin',
      'card/DF-9-from-head',
    ])
  })

  it('refuses to push a detached HEAD', () => {
    meta({ branch: '' })
    stage('', '')
    expect(() => publish({ stage: 'build', cardSummary: 'Add a close date' })).toThrow(
      'No branch to push to: none recorded and HEAD is detached.',
    )
  })
})

describe('the pull request', () => {
  it('takes a finished design out of draft', () => {
    github({
      number: 7,
      url: 'https://github.com/x/pull/7',
      body: '',
      isDraft: true,
      headRefOid: 'e',
    })
    publish({ stage: 'design', cardSummary: 'Add a close date' })
    expect(said()).toContain('pr ready 7')
  })

  it('puts a build turn back into draft, whatever it ended on', () => {
    result({ status: 'continue' })
    github({
      number: 7,
      url: 'https://github.com/x/pull/7',
      body: '',
      isDraft: false,
      headRefOid: 'e',
    })
    publish({ stage: 'build', cardSummary: 'Add a close date' })
    expect(said()).toContain('pr ready 7 --undo')
  })

  // A build stays a draft until verify has seen main's checks pass (ADR 0009).
})

describe('opening and editing the pull request', () => {
  it('opens a draft, labels it, keeps a finished build in draft, and records it', () => {
    github(null)
    meta({ preview_url: 'https://pr-31.preview.example' })

    const pr = publish({ stage: 'build', cardSummary: 'Add a close date' })

    expect(pr?.number).toBe(31)
    expect(said()).toEqual([
      'pr list --head card/DF-9-add-a-close-date --state open --json number,url,body,isDraft,headRefOid',
      `pr create --head ${BRANCH} --base main --title [DF-9] Add a close date --body-file - --draft`,
      'pr list --head card/DF-9-add-a-close-date --state open --json number,url,body,isDraft,headRefOid',
      'pr edit 31 --add-label factory:build',
      'pr edit 31 --add-label factory:active',
    ])
    expect(bodies[0]).toContain('**Preview:** https://pr-31.preview.example')
    expect(parseFactoryBlock(bodies[0] ?? '')).toEqual({
      key: 'DF-9',
      stage: 'build',
      turn: 2,
      preview_url: 'https://pr-31.preview.example',
    })
    expect(readMeta().pr).toBe(31)
    expect(console.log).toHaveBeenCalledWith('publish: https://github.com/x/pull/31')
  })

  it('edits the existing PR in place, and leaves an unfinished one in draft', () => {
    result({ status: 'continue' })
    github({
      number: 7,
      url: 'https://github.com/x/pull/7',
      body: '',
      isDraft: true,
      headRefOid: 'e',
    })

    publish({ stage: 'design', cardSummary: 'Add a close date' })

    expect(said()).toEqual([
      'pr list --head card/DF-9-add-a-close-date --state open --json number,url,body,isDraft,headRefOid',
      'pr edit 7 --title [DF-9] Add a close date',
      'pr edit 7 --body-file -',
      'pr edit 7 --add-label factory:design',
    ])
    // No preview yet, so the block does not claim one.
    expect(parseFactoryBlock(bodies[0] ?? '')).toEqual({ key: 'DF-9', stage: 'design', turn: 2 })
    expect(readMeta().pr).toBe(7)
  })
})
