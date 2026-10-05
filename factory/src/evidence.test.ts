import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildSlides,
  capturedSteps,
  flattenSteps,
  holdSeconds,
  planSlides,
  wrap,
} from './evidence.ts'
import type { Criterion, Result } from './schema.ts'

const CRITERIA: Criterion[] = [
  {
    criterion: 'The greeting names whoever you typed.',
    steps: ['Type "Ada" into the field labelled "Your name".', 'The heading reads "Hello, Ada".'],
  },
  {
    criterion: 'An empty field falls back to "Hello, there".',
    steps: ['Clear the field. The heading reads "Hello, there".'],
  },
]

function result(over: Partial<Result> = {}): Result {
  return {
    status: 'ready_for_review',
    summary: 'Built the greeting.',
    context: '',
    acceptance_criteria: CRITERIA,
    out_of_scope: [],
    answers: [],
    artifacts: [],
    questions: [],
    assumptions: [],
    reason: '',
    ...over,
  }
}

const dirs: string[] = []

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'evidence-test-'))
  dirs.push(dir)
  return dir
}

/** A real PNG, made by ffmpeg, so the render test has something to scale. */
function shot(dir: string, n: number, width = 1600, height = 900): void {
  const path = join(dir, `step-${String(n).padStart(2, '0')}.png`)
  const made = spawnSync(
    'ffmpeg',
    ['-y', '-f', 'lavfi', '-i', `color=c=0x3B82F6:s=${width}x${height}`, '-frames:v', '1', path],
    { encoding: 'utf8' },
  )
  if (made.status !== 0) throw new Error(`could not make a fixture screenshot: ${made.stderr}`)
}

/** An empty file is enough for anything that only looks at names. */
function stub(dir: string, n: number): void {
  writeFileSync(join(dir, `step-${String(n).padStart(2, '0')}.png`), '')
}

/** Enough ffmpeg to make a screenshot. */
const canShoot = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' }).status === 0

/**
 * Enough ffmpeg to make a slide.
 *
 * `drawtext` needs a freetype build — Debian's package has one, Homebrew's
 * bottle does not — so the render tests skip on a machine that cannot draw
 * text rather than failing there. CI installs ffmpeg from apt precisely so
 * this is true in the one place it has to be, and the assertions below are
 * what prove it when it runs.
 */
const canRender =
  canShoot &&
  /\bdrawtext\b/.test(
    spawnSync('ffmpeg', ['-hide_banner', '-filters'], { encoding: 'utf8' }).stdout ?? '',
  )

/** The width and height of a video's first stream, as ffprobe prints them. */
function canvasOf(video: string): string {
  const probe = spawnSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=width,height',
      '-of',
      'csv=p=0',
      video,
    ],
    { encoding: 'utf8' },
  )
  return probe.stdout.trim()
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

describe('flattenSteps', () => {
  it('numbers straight through the card, not per criterion', () => {
    expect(flattenSteps(result()).map((s) => s.n)).toEqual([1, 2, 3])
  })

  it('carries each step its own criterion', () => {
    const steps = flattenSteps(result())
    expect(steps[2]?.criterion).toBe('An empty field falls back to "Hello, there".')
    expect(steps[2]?.action).toBe('Clear the field. The heading reads "Hello, there".')
  })

  it('is empty when the card states no criteria', () => {
    expect(flattenSteps(result({ acceptance_criteria: [] }))).toEqual([])
  })
})

describe('capturedSteps', () => {
  it('reads the numbers off the filenames, in order', () => {
    const dir = scratch()
    stub(dir, 3)
    stub(dir, 1)
    stub(dir, 12)
    expect(capturedSteps(dir)).toEqual([1, 3, 12])
  })

  it('ignores anything that is not a step screenshot', () => {
    const dir = scratch()
    stub(dir, 1)
    writeFileSync(join(dir, 'uat-slides.mp4'), '')
    writeFileSync(join(dir, 'step-one.png'), '')
    expect(capturedSteps(dir)).toEqual([1])
  })

  it('treats a directory that was never written as no evidence', () => {
    expect(capturedSteps(join(scratch(), 'never'))).toEqual([])
  })
})

describe('wrap', () => {
  it('breaks on words, not mid-word', () => {
    expect(wrap('the quick brown fox jumps', 12, 3)).toEqual(['the quick', 'brown fox', 'jumps'])
  })

  it('elides when the text outruns the lines it is given', () => {
    const lines = wrap('one two three four five six seven eight nine ten', 10, 2)
    expect(lines).toHaveLength(2)
    expect(lines[1]?.endsWith('…')).toBe(true)
  })

  it('does not elide when everything fits', () => {
    expect(wrap('short enough', 40, 2)).toEqual(['short enough'])
  })

  it('hard-breaks a single word longer than the line', () => {
    expect(wrap('supercalifragilistic', 8, 2)[0]).toBe('supercal')
  })

  it('returns nothing for nothing', () => {
    expect(wrap('   ', 40, 2)).toEqual([])
  })
})

describe('holdSeconds', () => {
  it('never drops below four seconds', () => {
    expect(holdSeconds(['ok'])).toBe(4)
  })

  it('never climbs above twelve', () => {
    expect(holdSeconds([Array.from({ length: 200 }, () => 'word').join(' ')])).toBe(12)
  })

  it('grows with the caption in between', () => {
    expect(holdSeconds([Array.from({ length: 20 }, () => 'word').join(' ')])).toBe(8)
  })
})

describe('planSlides', () => {
  it('plans a slide per captured step and labels it against the whole card', () => {
    const dir = scratch()
    stub(dir, 1)
    stub(dir, 2)
    stub(dir, 3)
    const plan = planSlides(result(), dir)
    expect(plan.slides.map((s) => s.label)).toEqual(['Step 1 of 3', 'Step 2 of 3', 'Step 3 of 3'])
    expect(plan.missing).toEqual([])
    expect(plan.orphans).toEqual([])
  })

  it('reports the steps the reviewer must walk themselves', () => {
    const dir = scratch()
    stub(dir, 1)
    const plan = planSlides(result(), dir)
    expect(plan.slides).toHaveLength(1)
    expect(plan.missing).toEqual([2, 3])
  })

  it('drops a screenshot that matches no step, and says which', () => {
    const dir = scratch()
    stub(dir, 1)
    stub(dir, 9)
    const plan = planSlides(result(), dir)
    expect(plan.slides.map((s) => s.step.n)).toEqual([1])
    expect(plan.orphans).toEqual([9])
  })

  it('captions each slide with its own criterion and step', () => {
    const dir = scratch()
    stub(dir, 3)
    const slide = planSlides(result(), dir).slides[0]
    expect(slide?.criterion.join(' ')).toBe('An empty field falls back to "Hello, there".')
    expect(slide?.action.join(' ')).toBe('Clear the field. The heading reads "Hello, there".')
  })
})

describe('buildSlides', () => {
  it('returns a reason rather than throwing when nothing was captured', () => {
    const outcome = buildSlides({ result: result(), dir: scratch(), out: join(scratch(), 'x.mp4') })
    expect(outcome.ok).toBe(false)
    expect(outcome.video).toBeNull()
    expect(outcome.reason).toBe('no step screenshots were captured')
  })

  it('returns a reason when the card states no criteria at all', () => {
    const dir = scratch()
    stub(dir, 1)
    const outcome = buildSlides({
      result: result({ acceptance_criteria: [] }),
      dir,
      out: join(dir, 'x.mp4'),
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.orphans).toEqual([1])
  })

  // The complement of the render tests: on a machine that cannot draw text,
  // the thing to prove is that it says so plainly instead of leaking a filter
  // graph error, so one of the two always runs wherever this suite is run.
  it.skipIf(canRender || !canShoot)(
    'names the missing capability rather than the filter',
    () => {
      const dir = scratch()
      shot(dir, 1)
      const outcome = buildSlides({ result: result(), dir, out: join(dir, 'x.mp4') })
      expect(outcome.ok).toBe(false)
      expect(outcome.reason).toBe('this ffmpeg was built without drawtext')
    },
    60_000,
  )
})

describe('buildSlides, rendering for real', () => {
  it.skipIf(!canRender)(
    'renders one video from the screenshots it has',
    () => {
      const dir = scratch()
      shot(dir, 1)
      shot(dir, 2)
      const out = join(dir, 'uat-slides.mp4')

      const outcome = buildSlides({ result: result(), dir, out })

      expect(outcome.reason).toBe('')
      expect(outcome.ok).toBe(true)
      expect(outcome.video).toBe(out)
      expect(outcome.slides).toBe(2)
      expect(outcome.missing).toEqual([3])

      // The canvas is fixed, and the concat demuxer only copies streams, so what
      // comes out is what every slide was padded to.
      expect(canvasOf(out)).toBe('1280,980')
    },
    120_000,
  )

  it.skipIf(!canRender)(
    'pads a screenshot of any shape onto the same canvas',
    () => {
      const dir = scratch()
      shot(dir, 1, 600, 1400)
      const out = join(dir, 'uat-slides.mp4')

      expect(buildSlides({ result: result(), dir, out }).ok).toBe(true)

      expect(canvasOf(out)).toBe('1280,980')
    },
    120_000,
  )

  it.skipIf(!canRender)(
    'refuses a video over the cap rather than attaching it',
    () => {
      const dir = scratch()
      shot(dir, 1)
      const outcome = buildSlides({ result: result(), dir, out: join(dir, 'x.mp4'), maxKb: 0 })
      expect(outcome.ok).toBe(false)
      expect(outcome.reason).toMatch(/over the 0 KB cap/)
    },
    120_000,
  )

  it.skipIf(!canRender)(
    'survives a caption full of ffmpeg metacharacters',
    () => {
      const dir = scratch()
      shot(dir, 1)
      const nasty = "Totals read £45m — 20% up: 'quarter' over \\last, x=1,y=2 [ok]"
      const outcome = buildSlides({
        result: result({ acceptance_criteria: [{ criterion: nasty, steps: [nasty] }] }),
        dir,
        out: join(dir, 'x.mp4'),
      })
      expect(outcome.reason).toBe('')
      expect(outcome.ok).toBe(true)
    },
    120_000,
  )
})
