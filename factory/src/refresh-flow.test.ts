import { spawnSync } from 'node:child_process'
import type * as childProcess from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { currentBranch, git } from './git.ts'
import { setRunner } from './github.ts'
import { abortMerge, attemptMerge } from './merge.ts'
import { npmChecks, refresh, type Checks, type RefreshOptions } from './refresh.ts'
import { BASE, cfg, server, useFakes } from './jira.stub.ts'
import { mergeState } from './merge.stub.ts'

/**
 * `refresh` itself: what happens to one card in review for each thing the merge
 * can turn out to be.
 *
 * The merge is stubbed — it is tested against a real repository in
 * `merge-git.test.ts` — and so is the push. Jira is answered over HTTP and `gh`
 * by a runner that remembers its calls, because the question here is what the
 * card and the pull request end up being told, and in what order.
 */

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof childProcess>()),
  spawnSync: vi.fn(() => ({ status: 0 })),
}))
vi.mock('./git.ts', () => ({ currentBranch: vi.fn(), git: vi.fn(() => '') }))
vi.mock('./merge.ts', () => ({ attemptMerge: vi.fn(), abortMerge: vi.fn() }))

const BRANCH = 'card/DF-5-add-a-greeting'

useFakes()

/** What Jira was asked to do, in order: `move <status>` and `comment`. */
let jiraDid: string[] = []

/** A card whose only transitions are to the statuses given. */
function card(statuses: string[], commentStatus = 201): void {
  server.use(
    http.get(`${BASE}/rest/api/3/issue/DF-5/transitions`, () =>
      HttpResponse.json({
        transitions: statuses.map((name, i) => ({ id: String(i), name, to: { name } })),
      }),
    ),
    http.post(`${BASE}/rest/api/3/issue/DF-5/transitions`, async ({ request }) => {
      const { transition } = (await request.json()) as { transition: { id: string } }
      jiraDid.push(`move ${statuses[Number(transition.id)]}`)
      return new HttpResponse(null, { status: 204 })
    }),
    http.post(`${BASE}/rest/api/3/issue/DF-5/comment`, () => {
      jiraDid.push('comment')
      return HttpResponse.json({}, { status: commentStatus })
    }),
  )
}

let gh: string[][] = []

/** GitHub with DF-5's pull request open, and a dispatch that may fail. */
function github(open = true, dispatchFails = false): void {
  setRunner((args) => {
    gh.push(args)
    if (args[0] === 'workflow' && dispatchFails) return { status: 1, stdout: '', stderr: 'nope' }
    const prs = open ? [{ number: 19, headRefName: BRANCH, url: '', body: '', isDraft: false }] : []
    return { status: 0, stdout: args[1] === 'list' ? JSON.stringify(prs) : '', stderr: '' }
  })
}

const green: Checks = () => ({ ok: true, failed: null })
const red: Checks = () => ({ ok: false, failed: 'npm run test' })

function options(over: Partial<RefreshOptions> = {}): RefreshOptions {
  return {
    key: 'DF-5',
    because: { number: 21, title: 'Paint it blue' },
    cfg,
    checks: green,
    ...over,
  }
}

const dispatched = (): boolean => gh.some((args) => args[0] === 'workflow')
const pushed = (): boolean => vi.mocked(git).mock.calls.some(([args]) => args[0] === 'push')

beforeEach(() => {
  jiraDid = []
  gh = []
  github()
  card(['Building', 'Blocked on engineer'])
  vi.mocked(currentBranch).mockReturnValue(BRANCH)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

describe('a card whose branch has nothing to take', () => {
  it('says nothing to anyone', async () => {
    vi.mocked(attemptMerge).mockReturnValue(mergeState({ state: 'up-to-date', behind: 0 }))

    expect(await refresh(options())).toEqual({
      state: 'up-to-date',
      detail: 'DF-5 already had main; nothing to do.',
    })
    expect(jiraDid).toEqual([])
    expect(pushed()).toBe(false)
  })

  it('cannot be refreshed without a pull request', async () => {
    github(false)
    await expect(refresh(options())).rejects.toThrow('DF-5 has no open pull request to refresh.')
  })
})

describe('a card whose branch merges and still passes', () => {
  it('pushes the merge to the branch and tells the card', async () => {
    vi.mocked(attemptMerge).mockReturnValue(mergeState())

    const outcome = await refresh(options())

    expect(outcome).toEqual({ state: 'refreshed', detail: 'DF-5 took 2 commit(s) from main.' })
    expect(git).toHaveBeenCalledWith(['push', 'origin', `HEAD:refs/heads/${BRANCH}`])
    expect(jiraDid).toEqual(['comment'])
  })

  // The push is what mattered; a card that missed hearing about it is not a
  // reason to fail this leg of the fan-out.
  it('only warns when the comment cannot be posted', async () => {
    card([], 500)
    vi.mocked(attemptMerge).mockReturnValue(mergeState())

    expect((await refresh(options())).state).toBe('refreshed')
    expect(console.error).toHaveBeenCalledWith(
      expect.stringMatching(/^::warning::could not comment on DF-5: /),
    )
  })

  it('pushes nothing and says nothing on a dry run', async () => {
    vi.mocked(attemptMerge).mockReturnValue(mergeState())

    const outcome = await refresh(options({ dryRun: true }))

    expect(outcome).toEqual({ state: 'refreshed', detail: 'DF-5 would be refreshed (dry run).' })
    expect(pushed()).toBe(false)
    expect(jiraDid).toEqual([])
  })
})

describe('a card whose branch merges and then fails', () => {
  it('puts the branch back, and hands the card to the build agent', async () => {
    vi.mocked(attemptMerge).mockReturnValue(mergeState())

    const outcome = await refresh(options({ checks: red }))

    expect(outcome).toEqual({
      state: 'handed-to-build',
      detail: 'DF-5 merged clean but npm run test failed.',
    })
    expect(git).toHaveBeenCalledWith(['reset', '--hard', 'a'.repeat(40)])
    expect(pushed()).toBe(false)
    expect(jiraDid).toEqual(['move Building', 'comment'])
    expect(gh).toContainEqual([
      'workflow',
      'run',
      'build-turn.yml',
      '--repo',
      'acme/dark-factory-playground',
      '-f',
      'key=DF-5',
    ])
  })
})

describe('a card whose branch conflicts with main', () => {
  beforeEach(() => {
    vi.mocked(attemptMerge).mockReturnValue(
      mergeState({ state: 'conflicted', conflicts: ['app/src/index.css'] }),
    )
  })

  it('backs the merge out and hands the card to the build agent', async () => {
    const outcome = await refresh(options())

    expect(outcome).toEqual({
      state: 'handed-to-build',
      detail: 'DF-5 conflicts in app/src/index.css.',
    })
    expect(abortMerge).toHaveBeenCalled()
    expect(jiraDid).toEqual(['move Building', 'comment'])
    expect(dispatched()).toBe(true)
  })

  // Failing the move before anything is said leaves a card that is merely
  // unchanged, rather than one whose comment claims a move that did not happen.
  it('says nothing and starts nothing when the card cannot be moved', async () => {
    card(['Done'])

    await refresh(options())

    expect(jiraDid).toEqual([])
    expect(dispatched()).toBe(false)
    expect(console.error).toHaveBeenCalledWith(
      expect.stringMatching(/^::warning::could not move DF-5 to Building: /),
    )
  })

  it('shouts when the turn cannot be started, because nothing else will start it', async () => {
    github(true, true)

    await refresh(options())

    expect(jiraDid).toEqual(['move Building', 'comment'])
    expect(console.error).toHaveBeenCalledWith(
      expect.stringMatching(
        /^::error::DF-5 was moved to Building but build-turn\.yml could not be dispatched \(.*\); re-run it by hand$/,
      ),
    )
  })

  it('only describes the hand-over on a dry run', async () => {
    await refresh(options({ dryRun: true }))

    expect(jiraDid).toEqual([])
    expect(dispatched()).toBe(false)
    expect(console.log).toHaveBeenCalledWith(
      'refresh --dry-run: would move DF-5 to Building — Merging main into this branch conflicts in app/src/index.css.',
    )
  })
})

describe('a card whose conflict is in the machinery', () => {
  beforeEach(() => {
    vi.mocked(attemptMerge).mockReturnValue(
      mergeState({
        state: 'refused',
        conflicts: ['factory/src/validate.ts'],
        denied: ['factory/src/validate.ts'],
      }),
    )
  })

  it('goes to a person, with no build turn', async () => {
    const outcome = await refresh(options())

    expect(outcome).toEqual({
      state: 'refused',
      detail: 'DF-5 conflicts in factory/src/validate.ts; a human has it.',
    })
    expect(jiraDid).toEqual(['move Blocked on engineer', 'comment'])
    expect(dispatched()).toBe(false)
  })

  // The comment is the part a person needs; a board missing the status should
  // not stop them hearing about it.
  it('still comments when the card cannot be moved', async () => {
    card(['Building'])

    await refresh(options())

    expect(jiraDid).toEqual(['comment'])
    expect(console.error).toHaveBeenCalledWith(
      expect.stringMatching(/^::warning::could not move DF-5 to Blocked on engineer: /),
    )
  })

  it('only describes it on a dry run', async () => {
    await refresh(options({ dryRun: true }))

    expect(jiraDid).toEqual([])
    expect(console.log).toHaveBeenCalledWith(
      'refresh --dry-run: would move DF-5 to Blocked on engineer and comment',
    )
  })
})

describe('the checks run on the merged tree', () => {
  const npm = vi.mocked(spawnSync)
  const ran = (): string[] => npm.mock.calls.map((call) => (call[1] ?? []).join(' '))

  it('installs from the lockfile first, then runs what ci.yml runs, in order', () => {
    expect(npmChecks()).toEqual({ ok: true, failed: null })
    expect(ran()).toEqual(['ci', 'run lint', 'run typecheck', 'run test', 'run build'])
  })

  it('stops at the first failure and names it', () => {
    npm
      .mockReturnValueOnce({ status: 0 } as ReturnType<typeof spawnSync>)
      .mockReturnValueOnce({ status: 0 } as ReturnType<typeof spawnSync>)
      .mockReturnValueOnce({ status: 2 } as ReturnType<typeof spawnSync>)

    expect(npmChecks()).toEqual({ ok: false, failed: 'npm run typecheck' })
    expect(ran()).toEqual(['ci', 'run lint', 'run typecheck'])
  })

  it('does not run the scripts against a tree npm could not install', () => {
    npm.mockReturnValueOnce({ status: 1 } as ReturnType<typeof spawnSync>)
    expect(npmChecks()).toEqual({ ok: false, failed: 'npm ci' })
    expect(ran()).toEqual(['ci'])
  })
})
