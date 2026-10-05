import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildSlides } from './evidence.ts'
import type { Result } from './schema.ts'
import type * as Fs from 'node:fs'

/**
 * buildSlides with ffmpeg replaced, so what it asks ffmpeg to do — and what it
 * makes of each way ffmpeg can answer — is tested on any machine, not only one
 * whose ffmpeg can draw text. The render tests in evidence.test.ts prove the
 * real thing where they can run.
 */

vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }))
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof Fs>()
  return { ...real, existsSync: vi.fn(real.existsSync) }
})

const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
const OTHER_FONTS = [
  '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
  '/System/Library/Fonts/Supplemental/Arial.ttf',
]

interface Call {
  args: string[]
  /** What each drawtext textfile held at the moment ffmpeg was asked. */
  texts: string[]
}

interface Fake {
  version?: number
  filters?: string
  render?: { status: number; stderr: string }
  join?: { status: number; stderr: string }
  /** Bytes the joined video is given. */
  size?: number
  /** Rendering a slide throws an error with no message, rather than failing. */
  throws?: boolean
}

const calls: Call[] = []
const dirs: string[] = []
let realExists: (path: Fs.PathLike) => boolean

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'evidence-render-test-'))
  dirs.push(dir)
  return dir
}

function result(over: Partial<Result> = {}): Result {
  return {
    status: 'ready_for_review',
    summary: 'Built the greeting.',
    context: '',
    acceptance_criteria: [
      {
        criterion: 'The greeting names whoever you typed.',
        steps: ['Type "Ada" into the field.', 'The heading reads "Hello, Ada".'],
      },
      { criterion: 'An empty field says "Hello, there".', steps: ['Clear the field.'] },
    ],
    out_of_scope: [],
    answers: [],
    artifacts: [],
    questions: [],
    assumptions: [],
    reason: '',
    ...over,
  }
}

function textsIn(args: string[]): string[] {
  const graph = args[args.indexOf('-vf') + 1] ?? ''
  return [...graph.matchAll(/textfile=([^:]+):/g)].map((m) => readFileSync(m[1] as string, 'utf8'))
}

/** Answers each kind of ffmpeg call buildSlides makes the way `fake` says. */
function fakeFfmpeg(fake: Fake = {}): void {
  vi.mocked(spawnSync).mockImplementation(((_bin: string, args: string[]) => {
    if (args[0] === '-version') return { status: fake.version ?? 0, stdout: '', stderr: '' }
    if (args[1] === '-filters') {
      return { status: 0, stdout: fake.filters ?? ' T.. drawtext  V->V  Draw text', stderr: '' }
    }
    if (args.includes('concat')) {
      calls.push({ args, texts: [readFileSync(args[args.indexOf('-i') + 1] as string, 'utf8')] })
      const answer = fake.join ?? { status: 0, stderr: '' }
      if (answer.status === 0) writeFileSync(args.at(-1) as string, Buffer.alloc(fake.size ?? 10))
      return { ...answer, stdout: '' }
    }
    calls.push({ args, texts: textsIn(args) })
    if (fake.throws === true) throw new Error('')
    return { ...(fake.render ?? { status: 0, stderr: '' }), stdout: '' }
  }) as unknown as typeof spawnSync)
}

/** The work directory is random; everything else about an argument is not. */
function normalised(): string[][] {
  return calls.map((c) => c.args.map((a) => a.replace(/\/[^,:' ]*factory-slides-[^/]+/g, '<work>')))
}

beforeEach(async () => {
  const real = await vi.importActual<typeof Fs>('node:fs')
  realExists = real.existsSync
  vi.mocked(existsSync).mockImplementation((p) => {
    if (p === FONT) return true
    if (OTHER_FONTS.includes(String(p))) return false
    return realExists(p)
  })
  calls.length = 0
})

afterEach(() => {
  vi.mocked(spawnSync).mockReset()
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

function captured(...steps: number[]): string {
  const dir = scratch()
  for (const n of steps) writeFileSync(join(dir, `step-${String(n).padStart(2, '0')}.png`), '')
  return dir
}

/**
 * The ffmpeg arguments for one slide, written out in full. A refactor of
 * buildSlides that changes any of this changes the video.
 */
function slideArgs(seconds: number, shot: string, index: string): string[] {
  const text = (part: string, style: string): string =>
    `drawtext=textfile=<work>/slide-${index}.${part}.txt:expansion=none:fontfile=${FONT}${style}`
  return [
    '-y',
    '-loop',
    '1',
    '-t',
    String(seconds),
    '-i',
    shot,
    '-vf',
    [
      'scale=1280:720:force_original_aspect_ratio=decrease',
      'pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=0xE5E7EB',
      'pad=1280:980:0:0:color=0x111827',
      text('label', ':fontsize=20:fontcolor=0x9CA3AF:x=40:y=744:line_spacing=7'),
      text('criterion', ':fontsize=22:fontcolor=0xA7F3D0:x=40:y=780:line_spacing=8'),
      text('action', ':fontsize=26:fontcolor=0xFFFFFF:x=40:y=856:line_spacing=9'),
    ].join(','),
    '-r',
    '30',
    '-pix_fmt',
    'yuv420p',
    '-c:v',
    'libx264',
    `<work>/slide-${index}.mp4`,
  ]
}

describe('buildSlides, with ffmpeg faked', () => {
  it('asks ffmpeg for exactly these slides and this join', () => {
    fakeFfmpeg()
    const dir = captured(1, 3)
    const out = join(dir, 'uat-slides.mp4')
    const outcome = buildSlides({ result: result(), dir, out })
    expect(outcome).toEqual({
      ok: true,
      video: out,
      slides: 2,
      missing: [2],
      orphans: [],
      reason: '',
    })
    expect(normalised()).toEqual([
      slideArgs(5, join(dir, 'step-01.png'), '000'),
      slideArgs(4, join(dir, 'step-03.png'), '001'),
      ['-y', '-f', 'concat', '-safe', '0', '-i', '<work>/slides.txt', '-c', 'copy', out],
    ])
  })

  it('draws the caption from files holding exactly what the card says', () => {
    fakeFfmpeg()
    const dir = captured(1, 3)
    buildSlides({ result: result(), dir, out: join(dir, 'x.mp4') })
    expect(calls[0]?.texts).toEqual([
      'Step 1 of 3',
      'The greeting names whoever you typed.',
      'Type "Ada" into the field.',
    ])
    expect(calls[1]?.texts).toEqual([
      'Step 3 of 3',
      'An empty field says "Hello, there".',
      'Clear the field.',
    ])
  })

  it('lists every clip for the concat demuxer, in order', () => {
    fakeFfmpeg()
    const dir = captured(1, 2)
    buildSlides({ result: result(), dir, out: join(dir, 'x.mp4') })
    const list = (calls[2]?.texts[0] ?? '').replace(/\/[^' ]*factory-slides-[^/]+/g, '<work>')
    expect(list).toBe("file '<work>/slide-000.mp4'\nfile '<work>/slide-001.mp4'\n")
  })

  it('leaves no work directory behind', () => {
    fakeFfmpeg()
    const dir = captured(1)
    buildSlides({ result: result(), dir, out: join(dir, 'x.mp4') })
    const work = (calls[0]?.args.at(-1) ?? '').replace(/\/slide-000\.mp4$/, '')
    expect(work).toMatch(/factory-slides-/)
    expect(realExists(work)).toBe(false)
  })
})

describe('buildSlides, when ffmpeg cannot be used', () => {
  it('says ffmpeg is not installed, and asks it nothing else', () => {
    fakeFfmpeg({ version: 127 })
    const dir = captured(1)
    const outcome = buildSlides({ result: result(), dir, out: join(dir, 'x.mp4') })
    expect(outcome).toMatchObject({ ok: false, video: null, reason: 'ffmpeg is not installed' })
    expect(calls).toEqual([])
  })

  it('says when this ffmpeg cannot draw text', () => {
    fakeFfmpeg({ filters: ' T.. scale  V->V  Scale the input video' })
    const dir = captured(1)
    const outcome = buildSlides({ result: result(), dir, out: join(dir, 'x.mp4') })
    expect(outcome.reason).toBe('this ffmpeg was built without drawtext')
  })

  it('says when no font it knows is installed', () => {
    fakeFfmpeg()
    vi.mocked(existsSync).mockImplementation((p) =>
      p === FONT || OTHER_FONTS.includes(String(p)) ? false : realExists(p),
    )
    const dir = captured(1)
    const outcome = buildSlides({ result: result(), dir, out: join(dir, 'x.mp4') })
    expect(outcome).toMatchObject({ ok: false, video: null, reason: 'no usable font was found' })
  })
})

describe('buildSlides, when ffmpeg fails part way', () => {
  it('names the step that would not render, with the end of what ffmpeg said', () => {
    fakeFfmpeg({ render: { status: 1, stderr: 'one\ntwo\nthree\nfour\n' } })
    const dir = captured(2)
    const outcome = buildSlides({ result: result(), dir, out: join(dir, 'x.mp4') })
    expect(outcome).toMatchObject({ ok: false, video: null, slides: 1 })
    expect(outcome.reason).toBe('ffmpeg could not render step 2: two three four')
  })

  // The reason is the only signal, and an empty one used to read as success.
  it('fails when rendering throws an error that says nothing', () => {
    fakeFfmpeg({ throws: true })
    const dir = captured(1)
    const outcome = buildSlides({ result: result(), dir, out: join(dir, 'x.mp4') })
    expect(outcome).toMatchObject({ ok: false, video: null, slides: 1 })
  })

  it('says when the slides would not join', () => {
    fakeFfmpeg({ join: { status: 1, stderr: 'Invalid data found\n' } })
    const dir = captured(1)
    const outcome = buildSlides({ result: result(), dir, out: join(dir, 'x.mp4') })
    expect(outcome).toMatchObject({ ok: false, video: null })
    expect(outcome.reason).toBe('ffmpeg could not join the slides: Invalid data found')
  })

  it('refuses, and removes, a video over the cap', () => {
    fakeFfmpeg({ size: 3000 })
    const dir = captured(1)
    const out = join(dir, 'x.mp4')
    const outcome = buildSlides({ result: result(), dir, out, maxKb: 2 })
    expect(outcome).toMatchObject({ ok: false, video: null })
    expect(outcome.reason).toBe('the video is 3 KB, over the 2 KB cap')
    expect(realExists(out)).toBe(false)
  })

  it('keeps a video at the cap', () => {
    fakeFfmpeg({ size: 2048 })
    const dir = captured(1)
    const out = join(dir, 'x.mp4')
    expect(buildSlides({ result: result(), dir, out, maxKb: 2 }).ok).toBe(true)
    expect(realExists(out)).toBe(true)
  })
})
