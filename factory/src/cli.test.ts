import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as jira from './jira.ts'
import { triagePass } from './triage.ts'
import { releaseOrphans, stop, takeCard } from './lock.ts'
import { findPrForCard } from './github.ts'
import { claimCard, sentInBy } from './progress.ts'
import { buildProgram, isEntryPoint, main } from './cli.ts'

const CFG: jira.JiraConfig = { base: 'https://example.atlassian.net', user: 'u', token: 't' }

// The command modules are the boundary. What is tested here is that each
// command reads its arguments and options and hands them to the right function.
vi.mock('./jira.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof jira>()),
  configFromEnv: vi.fn(() => CFG),
  search: vi.fn(),
  transitionTo: vi.fn(),
}))
vi.mock('./triage.ts', () => ({ triagePass: vi.fn() }))
vi.mock('./lock.ts', () => ({ releaseOrphans: vi.fn(), stop: vi.fn(), takeCard: vi.fn() }))
vi.mock('./github.ts', () => ({ findPrForCard: vi.fn() }))
vi.mock('./progress.ts', () => ({ claimCard: vi.fn(), sentInBy: vi.fn() }))

let log: ReturnType<typeof vi.spyOn>
let error: ReturnType<typeof vi.spyOn>
const previousProject = process.env['JIRA_PROJECT_KEY']

beforeEach(() => {
  vi.clearAllMocks()
  log = vi.spyOn(console, 'log').mockImplementation(() => {})
  error = vi.spyOn(console, 'error').mockImplementation(() => {})
  process.env['JIRA_PROJECT_KEY'] = 'DF'
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.mocked(jira.search).mockReset()
  if (previousProject === undefined) delete process.env['JIRA_PROJECT_KEY']
  else process.env['JIRA_PROJECT_KEY'] = previousProject
})

function run(...args: string[]): Promise<unknown> {
  return buildProgram().parseAsync(['node', 'factory', ...args])
}

function logged(): string[] {
  return log.mock.calls.map((call: unknown[]) => String(call[0]))
}

describe('buildProgram', () => {
  it('registers every command, in the order help lists them', () => {
    expect(buildProgram().commands.map((c) => c.name())).toEqual([
      'jira-search',
      'triage',
      'stop',
      'release-orphans',
      'jira-take',
      'card-pr',
      'jira-transition',
      'jira-claim',
      'gather',
      'prepare-branch',
      'merge-begin',
      'merge-finish',
      'refresh-plan',
      'refresh',
      'validate',
      'publish',
      'evidence-slides',
      'announce',
      'report',
      'preview-up',
      'preview-down',
      'production-up',
      'ship',
      'kickoff',
      'emit-schema',
      'meta',
    ])
  })
})

describe('main', () => {
  class Exit extends Error {}
  function exitCode(): Promise<unknown> {
    vi.spyOn(process, 'exit').mockImplementation(((code: number) => {
      throw new Exit(String(code))
    }) as never)
    return main(['node', 'factory', 'jira-search', 'x']).catch((e: Exit) => Number(e.message))
  }

  it('exits 2 on a Jira auth failure, with its message', async () => {
    vi.mocked(jira.search).mockRejectedValue(new jira.JiraAuthError('bad token'))
    expect(await exitCode()).toBe(2)
    expect(error).toHaveBeenCalledWith('bad token')
  })

  it('exits 3 when there is no such transition', async () => {
    vi.mocked(jira.search).mockRejectedValue(new jira.JiraTransitionError('no way there'))
    expect(await exitCode()).toBe(3)
    expect(error).toHaveBeenCalledWith('no way there')
  })

  it('exits 1 on anything else', async () => {
    vi.mocked(jira.search).mockRejectedValue(new Error('boom'))
    expect(await exitCode()).toBe(1)
    expect(error).toHaveBeenCalledWith('boom')
  })

  it('returns normally when the command succeeds', async () => {
    vi.mocked(jira.search).mockResolvedValue([])
    expect(await exitCode()).toBeUndefined()
  })
})

describe('isEntryPoint', () => {
  it('is true for the same file, even through a symlink', () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-cli-'))
    try {
      const file = join(dir, 'cli.ts')
      writeFileSync(file, '')
      symlinkSync(file, join(dir, 'link.ts'))
      expect(isEntryPoint(file, file)).toBe(true)
      expect(isEntryPoint(join(dir, 'link.ts'), file)).toBe(true)
      expect(isEntryPoint(join(dir, 'missing.ts'), file)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('is false when nothing was run, or under the test runner', () => {
    expect(isEntryPoint(undefined)).toBe(false)
    expect(isEntryPoint()).toBe(false)
  })
})

describe('card commands', () => {
  it('jira-search prints one key per line', async () => {
    vi.mocked(jira.search).mockResolvedValue([{ key: 'DF-1' }, { key: 'DF-2' }] as never)
    await run('jira-search', 'project = DF')
    expect(jira.search).toHaveBeenCalledWith(CFG, 'project = DF')
    expect(logged()).toEqual(['DF-1', 'DF-2'])
  })

  it('triage says so when there is nothing to do', async () => {
    vi.mocked(triagePass).mockResolvedValue([])
    await run('triage', '--dry-run')
    expect(triagePass).toHaveBeenCalledWith({ cfg: CFG, projectKey: 'DF', dryRun: true })
    expect(logged()).toEqual(['triage: no new comments on any waiting card'])
  })

  it('triage prints each outcome', async () => {
    const base = { status: 'Blocked', reason: 'r' }
    vi.mocked(triagePass).mockResolvedValue([
      { ...base, key: 'DF-1', action: 'none', acted: false },
      { ...base, key: 'DF-2', action: 'build', acted: true },
      { ...base, key: 'DF-3', action: 'design', acted: false },
    ] as never)
    await run('triage')
    expect(triagePass).toHaveBeenCalledWith({ cfg: CFG, projectKey: 'DF', dryRun: false })
    expect(logged()).toEqual([
      'triage: DF-1 (Blocked) -> none [noted] — r',
      'triage: DF-2 (Blocked) -> build [dispatched] — r',
      'triage: DF-3 (Blocked) -> design [FAILED] — r',
    ])
  })

  it('stop passes the key and dry run through', async () => {
    vi.mocked(stop).mockResolvedValue('stopped' as never)
    await run('stop', 'DF-4', '--dry-run')
    expect(stop).toHaveBeenCalledWith({ cfg: CFG, key: 'DF-4', dryRun: true })
    expect(logged()).toEqual(['stop: DF-4 -> stopped'])
  })

  it('release-orphans names what it let go, or says none', async () => {
    vi.mocked(releaseOrphans).mockResolvedValueOnce([]).mockResolvedValueOnce(['DF-1', 'DF-2'])
    await run('release-orphans')
    await run('release-orphans', '--dry-run')
    expect(releaseOrphans).toHaveBeenLastCalledWith({ cfg: CFG, projectKey: 'DF', dryRun: true })
    expect(logged()).toEqual(['release-orphans: none', 'release-orphans: let go of DF-1, DF-2'])
  })

  it('jira-take and jira-transition pass key and status', async () => {
    await run('jira-take', 'DF-5', 'Building')
    await run('jira-transition', 'DF-5', 'Design review')
    expect(takeCard).toHaveBeenCalledWith(CFG, 'DF-5', 'Building')
    expect(jira.transitionTo).toHaveBeenCalledWith(CFG, 'DF-5', 'Design review')
    expect(logged()).toEqual(['DF-5 taken', 'DF-5 -> Design review'])
  })

  it("card-pr prints the PR number, and fails when there isn't one", async () => {
    vi.mocked(findPrForCard)
      .mockReturnValueOnce({ number: 12 } as never)
      .mockReturnValueOnce(null)
    await run('card-pr', 'DF-6')
    expect(logged()).toEqual(['12'])
    await expect(run('card-pr', 'DF-6')).rejects.toThrow(
      'No open pull request on a card/DF-6-* branch.',
    )
  })
})

describe('jira-claim', () => {
  it('claims without a hand-back when --from is not given', async () => {
    await run('jira-claim', 'DF-7')
    expect(sentInBy).not.toHaveBeenCalled()
    expect(claimCard).toHaveBeenCalledWith(CFG, 'DF-7', undefined)
    expect(logged()).toEqual(['DF-7 claimed'])
  })

  it('hands back to whoever moved it into --from', async () => {
    vi.mocked(sentInBy).mockResolvedValue('acct-luke')
    await run('jira-claim', 'DF-7', '--from', 'Ready to build')
    expect(sentInBy).toHaveBeenCalledWith(CFG, 'DF-7', 'Ready to build')
    expect(claimCard).toHaveBeenLastCalledWith(CFG, 'DF-7', 'acct-luke')
  })

  it('warns and claims anyway when the history cannot be read', async () => {
    vi.mocked(sentInBy).mockRejectedValue(new Error('500'))
    await run('jira-claim', 'DF-7', '--from', 'Ready to build')
    expect(error).toHaveBeenCalledWith('::warning::could not read who moved DF-7: 500')
    expect(claimCard).toHaveBeenLastCalledWith(CFG, 'DF-7', '')
  })
})
