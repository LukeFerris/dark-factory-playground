import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import type * as childProcess from 'node:child_process'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { git, identifyAsBot, tryCommit } from './git.ts'
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
  tryCommit: vi.fn(() => null),
}))

const npm = vi.mocked(spawnSync)
const gitCalls = vi.mocked(git)
const commits = vi.mocked(tryCommit)

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

/** git as publish sees it: something staged, and a branch checked out. */
function stage(staged: string, current = BRANCH): void {
  gitCalls.mockImplementation((args) => {
    if (args[0] === 'diff') return staged
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
  stage('app/src/App.tsx\n')
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => {
  setRunner(ghRunner)
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

describe('committing the turn', () => {
  it('commits as the bot, within the stage’s paths, under the card key and first line', () => {
    github(null)
    publish({ stage: 'design', cardSummary: 'Add a close date', dryRun: true })

    expect(identifyAsBot).toHaveBeenCalled()
    expect(gitCalls).toHaveBeenCalledWith(['add', '--', 'docs/design/**'], true)
    expect(commits).toHaveBeenCalledWith(['-m', 'DF-9: Added the close date.'])
  })

  it('keeps the subject to 72 characters', () => {
    result({ summary: 'x'.repeat(100) })
    publish({ stage: 'design', cardSummary: 'Add a close date', dryRun: true })
    expect(commits).toHaveBeenCalledWith(['-m', `DF-9: ${'x'.repeat(72)}`])
  })

  it('fails the turn, in result.json for report to post, when the gates refuse the commit', () => {
    github(null)
    commits.mockReturnValueOnce('Coverage gate: app/src/App.tsx lines 40% < 75%')

    expect(() =>
      publish({ stage: 'build', cardSummary: 'Add a close date', dryRun: false }),
    ).toThrow(/refused the commit:\nCoverage gate/)

    const written = JSON.parse(readFileSync(RESULT_PATH, 'utf8')) as Result
    expect(written.status).toBe('failed')
    expect(written.summary).toBe(
      "The build turn's commit was refused by the pre-commit gates, so none of it was pushed.",
    )
    expect(written.reason).toBe('Coverage gate: app/src/App.tsx lines 40% < 75%')
    expect(gitCalls).not.toHaveBeenCalledWith(expect.arrayContaining(['push']))
    expect(gh).toEqual([])
  })

  it('says so, and commits nothing, when nothing in scope changed', () => {
    stage('')
    publish({ stage: 'design', cardSummary: 'Add a close date', dryRun: true })

    expect(console.log).toHaveBeenCalledWith(
      "publish: nothing to commit within the stage's allowed paths.",
    )
    expect(gitCalls.mock.calls.some(([args]) => args[0] === 'commit')).toBe(false)
  })

  // The agent may have added a dependency and cannot run npm install itself.
  it('regenerates the lockfile on a build turn, and only then', () => {
    publish({ stage: 'design', cardSummary: 'Add a close date', dryRun: true })
    expect(npm).not.toHaveBeenCalled()

    publish({ stage: 'build', cardSummary: 'Add a close date', dryRun: true })
    expect(npm).toHaveBeenCalledWith(
      'npm',
      ['install', '--package-lock-only', '--workspaces', '--include-workspace-root'],
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
  it('opens a draft, labels it, takes it out of draft when finished, and records it', () => {
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
      'pr ready 31',
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
