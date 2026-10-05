import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as jira from './jira.ts'
import { gather } from './gather.ts'
import { prepareBranch } from './branch.ts'
import { currentBranch } from './git.ts'
import {
  abortMerge,
  attemptMerge,
  finishMerge,
  mergeQuestionResult,
  readMergeResult,
  readMergeState,
  recordMerge,
} from './merge.ts'
import { refresh, refreshTargets } from './refresh.ts'
import { validate } from './validate.ts'
import { publish } from './publish.ts'
import type * as Meta from './meta.ts'
import { RESULT_PATH, readMeta, turnBase, updateMeta, writeFileEnsuringDir } from './meta.ts'
import { registerTurnCommands } from './cli-turn.ts'

const CFG: jira.JiraConfig = { base: 'https://example.atlassian.net', user: 'u', token: 't' }

vi.mock('./jira.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof jira>()),
  configFromEnv: vi.fn(() => CFG),
  getIssue: vi.fn(),
}))
vi.mock('./gather.ts', () => ({ gather: vi.fn() }))
vi.mock('./branch.ts', () => ({ prepareBranch: vi.fn() }))
vi.mock('./git.ts', () => ({ currentBranch: vi.fn() }))
vi.mock('./merge.ts', () => ({
  abortMerge: vi.fn(),
  attemptMerge: vi.fn(),
  finishMerge: vi.fn(),
  mergeQuestionResult: vi.fn(),
  readMergeResult: vi.fn(),
  readMergeState: vi.fn(),
  recordMerge: vi.fn(),
}))
vi.mock('./refresh.ts', () => ({ refresh: vi.fn(), refreshTargets: vi.fn() }))
vi.mock('./validate.ts', () => ({ validate: vi.fn() }))
vi.mock('./publish.ts', () => ({ publish: vi.fn() }))
vi.mock('./meta.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof Meta>()),
  readMeta: vi.fn(),
  turnBase: vi.fn(() => 'base-sha'),
  updateMeta: vi.fn(),
  writeFileEnsuringDir: vi.fn(),
}))

class Exit extends Error {}

let log: ReturnType<typeof vi.spyOn>
let error: ReturnType<typeof vi.spyOn>
const previousProject = process.env['JIRA_PROJECT_KEY']

beforeEach(() => {
  vi.clearAllMocks()
  log = vi.spyOn(console, 'log').mockImplementation(() => {})
  error = vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(process, 'exit').mockImplementation(((code: number) => {
    throw new Exit(String(code))
  }) as never)
  process.env['JIRA_PROJECT_KEY'] = 'DF'
})
afterEach(() => {
  vi.restoreAllMocks()
  if (previousProject === undefined) delete process.env['JIRA_PROJECT_KEY']
  else process.env['JIRA_PROJECT_KEY'] = previousProject
})

function run(...args: string[]): Promise<unknown> {
  const program = new Command()
  registerTurnCommands(program)
  return program.parseAsync(['node', 'factory', ...args])
}

/** Runs a command that is expected to call process.exit, and returns the code. */
function exitOf(...args: string[]): Promise<number> {
  return run(...args).then(
    () => -1,
    (e: Exit) => Number(e.message),
  )
}

function lines(spy: ReturnType<typeof vi.spyOn>): string[] {
  return spy.mock.calls.map((call: unknown[]) => String(call[0]))
}

function summary(value: string | undefined): void {
  vi.mocked(jira.getIssue).mockResolvedValue({ key: 'DF-1', fields: { summary: value } } as never)
}

describe('gather and prepare-branch', () => {
  it('gather parses the stage and the PR number', async () => {
    vi.mocked(gather).mockResolvedValue({ key: 'DF-1', stage: 'build', turn: 3 } as never)
    await run('gather', 'DF-1', '--stage', 'build', '--pr', '42')
    expect(gather).toHaveBeenCalledWith({ key: 'DF-1', stage: 'build', pr: 42 })
    expect(lines(log)).toEqual(['gather: DF-1 stage=build turn=3'])
  })

  it('gather refuses a stage that is not design or build', async () => {
    await expect(run('gather', 'DF-1', '--stage', 'ship')).rejects.toThrow(
      '--stage must be "design" or "build", got "ship"',
    )
    expect(gather).not.toHaveBeenCalled()
  })

  it("prepare-branch names the branch after the card's summary, or its key", async () => {
    vi.mocked(prepareBranch).mockReturnValue('card/DF-1-x')
    summary('Add a thing')
    await run('prepare-branch', 'DF-1')
    summary(undefined)
    await run('prepare-branch', 'DF-1')
    expect(vi.mocked(prepareBranch).mock.calls).toEqual([
      ['DF-1', 'Add a thing'],
      ['DF-1', 'DF-1'],
    ])
    expect(lines(log)).toEqual(['card/DF-1-x', 'card/DF-1-x'])
  })
})

describe('merge-begin', () => {
  it('merge-begin records the attempt on the current branch', async () => {
    summary('Add a thing')
    vi.mocked(currentBranch).mockReturnValue('card/DF-1-x')
    vi.mocked(attemptMerge).mockReturnValue({ state: 'merged' } as never)
    await run('merge-begin', 'DF-1')
    expect(attemptMerge).toHaveBeenCalledWith('card/DF-1-x')
    expect(recordMerge).toHaveBeenCalledWith({ state: 'merged' }, 'DF-1', 'Add a thing')
  })
})

describe('merge-finish', () => {
  it('merge-finish has nothing to do when main was already in', async () => {
    for (const state of ['up-to-date', 'merged']) {
      vi.mocked(readMergeState).mockReturnValue({ state } as never)
      await run('merge-finish')
    }
    expect(lines(log)).toEqual([
      'merge-finish: nothing to finish (up-to-date).',
      'merge-finish: nothing to finish (merged).',
    ])
    expect(readMergeResult).not.toHaveBeenCalled()
  })

  it('merge-finish records the new base when the resolution commits', async () => {
    vi.mocked(readMergeState).mockReturnValue({ state: 'conflicted' } as never)
    vi.mocked(readMergeResult).mockReturnValue({ resolved: true } as never)
    vi.mocked(finishMerge).mockReturnValue({ ok: true, problems: [], sha: 'a'.repeat(40) })
    await run('merge-finish')
    expect(finishMerge).toHaveBeenCalledWith({ state: 'conflicted' }, { resolved: true })
    expect(updateMeta).toHaveBeenCalledWith({ base_sha: 'a'.repeat(40) })
    expect(lines(log)).toEqual(['merge-finish: merged as aaaaaaaaaaaa.'])
    expect(abortMerge).not.toHaveBeenCalled()
  })

  it('merge-finish aborts, writes the question, and exits 5 when it does not', async () => {
    vi.mocked(readMergeState).mockReturnValue({ state: 'conflicted' } as never)
    vi.mocked(readMergeResult).mockReturnValue({ resolved: false } as never)
    vi.mocked(finishMerge).mockReturnValue({ ok: false, problems: ['p1', 'p2'], sha: null })
    vi.mocked(mergeQuestionResult).mockReturnValue({ status: 'blocked' } as never)
    expect(await exitOf('merge-finish')).toBe(5)
    expect(abortMerge).toHaveBeenCalled()
    expect(mergeQuestionResult).toHaveBeenCalledWith({ state: 'conflicted' }, ['p1', 'p2'], {
      resolved: false,
    })
    expect(writeFileEnsuringDir).toHaveBeenCalledWith(
      RESULT_PATH,
      `${JSON.stringify({ status: 'blocked' }, null, 2)}\n`,
    )
    expect(lines(error)).toEqual([
      'merge-finish: the merge from main was not resolved.',
      '  - p1',
      '  - p2',
    ])
  })

  it('merge-finish turns a refused merge into a question without reading a result', async () => {
    const state = { state: 'refused', denied: ['factory/x.ts', '.github/y.yml'] }
    vi.mocked(readMergeState).mockReturnValue(state as never)
    expect(await exitOf('merge-finish')).toBe(5)
    expect(readMergeResult).not.toHaveBeenCalled()
    expect(finishMerge).not.toHaveBeenCalled()
    expect(mergeQuestionResult).toHaveBeenCalledWith(
      state,
      ['The conflict is in factory/x.ts, .github/y.yml.'],
      null,
    )
  })
})

describe('refresh-plan and refresh', () => {
  it('refresh-plan normalises the exclusions and prints the targets as JSON', async () => {
    vi.mocked(refreshTargets).mockResolvedValue([{ key: 'DF-2' }] as never)
    await run('refresh-plan', '--exclude', ' df-1, ,DF-3')
    expect(refreshTargets).toHaveBeenCalledWith(CFG, 'DF', ['DF-1', 'DF-3'])
    expect(lines(log)).toEqual(['[{"key":"DF-2"}]'])
  })

  it('refresh-plan excludes nothing by default', async () => {
    vi.mocked(refreshTargets).mockResolvedValue([])
    await run('refresh-plan')
    expect(refreshTargets).toHaveBeenCalledWith(CFG, 'DF', [])
  })

  it('refresh passes the PR that set it off', async () => {
    vi.mocked(refresh).mockResolvedValue({ state: 'merged', detail: 'clean' } as never)
    await run('refresh', 'DF-2', '--because-pr', '9', '--because-title', 'Ship it', '--dry-run')
    expect(refresh).toHaveBeenCalledWith({
      key: 'DF-2',
      because: { number: 9, title: 'Ship it' },
      cfg: CFG,
      dryRun: true,
    })
    expect(lines(log)).toEqual(['refresh: merged — clean'])
  })
})

describe('validate and publish', () => {
  it("validate diffs against the turn's base unless told otherwise", async () => {
    const ok = { ok: true, result: { status: 'ready_for_review' }, problems: [] }
    vi.mocked(validate).mockReturnValue(ok as never)
    await run('validate', '--stage', 'design')
    await run('validate', '--stage', 'build', '--base', 'origin/main')
    expect(vi.mocked(validate).mock.calls).toEqual([
      ['design', 'base-sha'],
      ['build', 'origin/main'],
    ])
    expect(turnBase).toHaveBeenCalledTimes(1)
    expect(lines(log)).toEqual([
      'validate: ok (status "ready_for_review")',
      'validate: ok (status "ready_for_review")',
    ])
  })

  it('validate lists the problems and exits 4 on a rejection', async () => {
    vi.mocked(validate).mockReturnValue({ ok: false, problems: ['out of scope'] } as never)
    expect(await exitOf('validate', '--stage', 'build')).toBe(4)
    expect(lines(error)).toEqual(['validate: REJECTED', '  - out of scope'])
  })

  it("publish reads the card's summary, falling back to its key", async () => {
    vi.mocked(readMeta).mockReturnValue({ key: 'DF-1' } as never)
    summary('Add a thing')
    await run('publish', '--stage', 'build', '--dry-run')
    summary(undefined)
    await run('publish', '--stage', 'design')
    expect(jira.getIssue).toHaveBeenCalledWith(CFG, 'DF-1')
    expect(vi.mocked(publish).mock.calls).toEqual([
      [{ stage: 'build', cardSummary: 'Add a thing', dryRun: true }],
      [{ stage: 'design', cardSummary: 'DF-1', dryRun: false }],
    ])
  })
})
