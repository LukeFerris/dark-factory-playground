import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { REPO_ROOT } from './env.ts'
import { announce } from './announce.ts'
import { report } from './report.ts'
import { kickoff, previewDown, previewUp } from './preview.ts'
import { productionUp, ship } from './production.ts'
import type * as Evidence from './evidence.ts'
import { EVIDENCE_DIR, SLIDES_PATH, buildSlides } from './evidence.ts'
import type * as Meta from './meta.ts'
import { RESULT_PATH, readMeta, writeFileEnsuringDir } from './meta.ts'
import { toJsonSchema } from './schema.ts'
import { registerDeliverCommands } from './cli-deliver.ts'

vi.mock('./announce.ts', () => ({ announce: vi.fn() }))
vi.mock('./report.ts', () => ({ report: vi.fn() }))
vi.mock('./preview.ts', () => ({ kickoff: vi.fn(), previewDown: vi.fn(), previewUp: vi.fn() }))
vi.mock('./production.ts', () => ({ productionUp: vi.fn(), ship: vi.fn() }))
vi.mock('./evidence.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof Evidence>()),
  buildSlides: vi.fn(),
}))
// Replaced so that emit-schema never touches the repository's `.agent`.
vi.mock('./meta.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof Meta>()),
  readMeta: vi.fn(),
  writeFileEnsuringDir: vi.fn(),
}))

let log: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.clearAllMocks()
  log = vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(RESULT_PATH, { force: true })
})

function run(...args: string[]): Promise<unknown> {
  const program = new Command()
  registerDeliverCommands(program)
  return program.parseAsync(['node', 'factory', ...args])
}

function logged(): string[] {
  return log.mock.calls.map((call: unknown[]) => String(call[0]))
}

/** Writes the turn's result for evidence-slides to find. */
function result(contents: string): void {
  mkdirSync(dirname(RESULT_PATH), { recursive: true })
  writeFileSync(RESULT_PATH, contents)
}

describe('evidence-slides', () => {
  const ok = { ok: true, slides: 2, video: '/v.mp4', missing: [], orphans: [] }

  it('skips, without failing, when the turn wrote no result', async () => {
    await run('evidence-slides')
    expect(logged()).toEqual(['evidence-slides: skipped — the turn wrote no result'])
    expect(buildSlides).not.toHaveBeenCalled()
  })

  it('skips when the result does not parse', async () => {
    result('{"status":"nonsense"}')
    await run('evidence-slides')
    expect(logged()).toEqual(['evidence-slides: skipped — the result does not parse'])
  })

  it('builds from the default directory into the default video', async () => {
    result('{"status":"ready_for_review","summary":"Did it"}')
    vi.mocked(buildSlides).mockReturnValue(ok as never)
    await run('evidence-slides')
    expect(buildSlides).toHaveBeenCalledWith({
      result: expect.objectContaining({ status: 'ready_for_review', summary: 'Did it' }),
      dir: EVIDENCE_DIR,
      out: SLIDES_PATH,
    })
    expect(logged()).toEqual(['evidence-slides: 2 slide(s) → /v.mp4'])
  })

  it('reports missing and orphaned screenshots, and why there is no video', async () => {
    result('{"status":"ready_for_review","summary":"Did it"}')
    vi.mocked(buildSlides).mockReturnValue({
      ok: false,
      reason: 'ffmpeg is not installed',
      missing: [1, 3],
      orphans: [7],
    } as never)
    await run('evidence-slides', '--dir', '/shots', '--out', '/out.mp4')
    expect(buildSlides).toHaveBeenCalledWith(
      expect.objectContaining({ dir: '/shots', out: '/out.mp4' }),
    )
    expect(logged()).toEqual([
      'evidence-slides: no screenshot for step(s) 1, 3',
      '::warning::evidence-slides: dropped screenshot(s) for step(s) 7, which the card does not list',
      'evidence-slides: no video — ffmpeg is not installed',
    ])
  })
})

describe('announce and report', () => {
  it('announce passes dry run through', async () => {
    await run('announce', '--dry-run')
    await run('announce')
    expect(vi.mocked(announce).mock.calls).toEqual([[{ dryRun: true }], [{ dryRun: false }]])
  })

  it('report parses the stage and passes the PR URL', async () => {
    await run('report', '--stage', 'build', '--pr-url', 'https://pr/1')
    expect(report).toHaveBeenCalledWith({ stage: 'build', prUrl: 'https://pr/1', dryRun: false })
    await expect(run('report', '--stage', 'nope')).rejects.toThrow('--stage must be')
  })
})

describe('deployments', () => {
  it('preview-up prints what it did; preview-down and kickoff take the PR number', async () => {
    vi.mocked(previewUp).mockResolvedValue('preview: https://pr-5')
    await run('preview-up', '5', '--dry-run')
    await run('preview-down', '5')
    await run('kickoff', '6', '--dry-run')
    expect(previewUp).toHaveBeenCalledWith(5, true)
    expect(previewDown).toHaveBeenCalledWith(5, false)
    expect(kickoff).toHaveBeenCalledWith(6, true)
    expect(logged()).toEqual(['preview: https://pr-5'])
  })

  it('production-up prints what it did; ship takes the PR and URL', async () => {
    vi.mocked(productionUp).mockResolvedValue('live')
    await run('production-up', 'abc123')
    await run('ship', '7', '--url', 'https://prod', '--dry-run')
    expect(productionUp).toHaveBeenCalledWith('abc123', false)
    expect(ship).toHaveBeenCalledWith({ pr: 7, url: 'https://prod', dryRun: true })
    expect(logged()).toEqual(['live'])
  })
})

describe('debugging aids', () => {
  it('emit-schema writes the JSON schema and prints where', async () => {
    await run('emit-schema')
    const path = resolve(REPO_ROOT, '.agent/result.schema.json')
    expect(writeFileEnsuringDir).toHaveBeenCalledWith(
      path,
      `${JSON.stringify(toJsonSchema(), null, 2)}\n`,
    )
    expect(logged()).toEqual([path])
  })

  it('meta prints the turn metadata', async () => {
    vi.mocked(readMeta).mockReturnValue({ key: 'DF-1' } as never)
    await run('meta')
    expect(logged()).toEqual([JSON.stringify({ key: 'DF-1' }, null, 2)])
  })
})
