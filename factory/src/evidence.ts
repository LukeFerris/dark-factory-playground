import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { AGENT_OUT } from './meta.ts'
import type { Result } from './schema.ts'

/**
 * The slides a reviewer watches before they open the preview.
 *
 * A build turn writes `acceptance_criteria`, each criterion paired with the
 * browser steps that prove it. The end-to-end suite drives whichever of those
 * steps it can and leaves `step-NN.png` per step. This turns the two into one
 * video: a captioned slide per captured step, with the criterion and the step
 * printed under the screen exactly as the card states them, so the video cannot
 * say anything the card does not.
 *
 * Deterministic — the same screenshots and the same result give the same video
 * — so it can be rebuilt after any step is re-run.
 *
 * **It never fails the pipeline.** Every outcome below that is not a finished
 * video is a reason, returned and logged, and the turn reports without it. The
 * evidence exists to make a hand-off better; a hand-off that cannot happen
 * because the evidence would not render is strictly worse than no evidence.
 */

/** Where a capture run writes, and where the video lands beside it. */
export const EVIDENCE_DIR = resolve(AGENT_OUT, 'evidence')
export const SLIDES_PATH = resolve(EVIDENCE_DIR, 'uat-slides.mp4')

/**
 * The name the reviewer looks for in the Attachments panel.
 *
 * Derived from the path rather than written out twice: the comment tells them
 * what the file is called, and a rename that missed the comment would send
 * them looking for something that is not there.
 */
export const SLIDES_FILENAME = basename(SLIDES_PATH)

/** The canvas. Fixed, because the concat demuxer needs every slide identical. */
const WIDTH = 1280
const SHOT_HEIGHT = 720
const BAND_HEIGHT = 260
const HEIGHT = SHOT_HEIGHT + BAND_HEIGHT

const BAND_BG = '0x111827'
const LETTERBOX_BG = '0xE5E7EB'
const LABEL_FG = '0x9CA3AF'
const CRITERION_FG = '0xA7F3D0'
const ACTION_FG = '0xFFFFFF'

const LABEL_SIZE = 20
const CRITERION_SIZE = 22
const ACTION_SIZE = 26

/** Two lines for the criterion, three for the step. Past that the band lies. */
const CRITERION_LINES = 2
const ACTION_LINES = 3

/**
 * Fonts, in the order they are tried. No path here contains a space: an
 * ffmpeg filter argument is a colon-separated list inside a comma-separated
 * graph, and quoting a path through both layers is a source of bugs rather
 * than a feature. A bold face is deliberately not used for the same reason —
 * the macOS one is "Arial Bold.ttf".
 */
const FONTS = [
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
  '/System/Library/Fonts/Supplemental/Arial.ttf',
]

const SHOT_RE = /^step-(\d+)\.png$/i

export interface Step {
  /** 1-based, across the whole card: the number the reviewer sees. */
  n: number
  /** The criterion this step sits under. */
  criterion: string
  /** The action or observation itself. */
  action: string
}

/**
 * The card's steps, flattened and numbered as the Jira comment numbers them.
 *
 * "Proving it" prints each criterion followed by its own ordered list, but the
 * numbering the spec captures against runs straight through the card — step 4
 * is the fourth step of the whole walkthrough, whichever criterion it belongs
 * to. Keeping that in one function is what stops the comment and the spec
 * disagreeing about which screenshot is which.
 */
export function flattenSteps(result: Result): Step[] {
  const steps: Step[] = []
  for (const criterion of result.acceptance_criteria) {
    for (const action of criterion.steps) {
      steps.push({ n: steps.length + 1, criterion: criterion.criterion, action })
    }
  }
  return steps
}

/** Step numbers with a screenshot in `dir`, ascending. */
export function capturedSteps(dir: string): number[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .map((name) => SHOT_RE.exec(name))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => Number.parseInt(m[1] as string, 10))
    .sort((a, b) => a - b)
}

/**
 * Greedy word wrap to `max` characters, capped at `lines`.
 *
 * Character counting rather than measurement: the band is sized for the worst
 * case and the fonts above are close enough in width that a line which fits
 * one fits the others. An overflowing last line is elided rather than dropped,
 * so a reviewer can see that there was more and go and read the card.
 */
export function wrap(text: string, max: number, lines: number): string[] {
  const words = text
    .trim()
    .split(/\s+/)
    .filter((w) => w !== '')
  if (words.length === 0) return []

  const out: string[] = []
  let current = ''
  for (const word of words) {
    const candidate = current === '' ? word : `${current} ${word}`
    if (candidate.length <= max) {
      current = candidate
      continue
    }
    out.push(current === '' ? word.slice(0, max) : current)
    current = current === '' ? '' : word
    if (out.length === lines) break
  }
  if (out.length < lines && current !== '') out.push(current)

  const used = out
    .join(' ')
    .split(/\s+/)
    .filter((w) => w !== '').length
  if (used < words.length) {
    const last = out[lines - 1] ?? ''
    out[lines - 1] = `${last.slice(0, Math.max(0, max - 1)).trimEnd()}…`
  }
  return out
}

export interface Slide {
  step: Step
  shot: string
  label: string
  criterion: string[]
  action: string[]
  /** How long it holds, in seconds: long enough to read the caption. */
  seconds: number
}

/** About two and a half words a second, between four and twelve. */
export function holdSeconds(lines: string[]): number {
  const words = lines
    .join(' ')
    .split(/\s+/)
    .filter((w) => w !== '').length
  return Math.min(12, Math.max(4, Math.ceil(words / 2.5)))
}

export interface Plan {
  slides: Slide[]
  /** Steps with no screenshot: the reviewer walks these themselves. */
  missing: number[]
  /** Screenshots matching no step. Dropped, and said so. */
  orphans: number[]
}

export function planSlides(result: Result, dir: string): Plan {
  const steps = flattenSteps(result)
  const captured = new Set(capturedSteps(dir))
  const total = steps.length

  const slides: Slide[] = []
  const missing: number[] = []
  for (const step of steps) {
    if (!captured.has(step.n)) {
      missing.push(step.n)
      continue
    }
    const criterion = wrap(step.criterion, 92, CRITERION_LINES)
    const action = wrap(step.action, 78, ACTION_LINES)
    slides.push({
      step,
      shot: join(dir, `step-${String(step.n).padStart(2, '0')}.png`),
      label: `Step ${step.n} of ${total}`,
      criterion,
      action,
      seconds: holdSeconds([...criterion, ...action]),
    })
  }

  const known = new Set(steps.map((s) => s.n))
  const orphans = [...captured].filter((n) => !known.has(n))

  return { slides, missing, orphans }
}

function firstFont(): string | null {
  return FONTS.find((f) => existsSync(f)) ?? null
}

function have(binary: string): boolean {
  return spawnSync(binary, ['-version'], { encoding: 'utf8' }).status === 0
}

/**
 * Whether this ffmpeg can draw text.
 *
 * `drawtext` needs libfreetype, which is a build option rather than a given —
 * Homebrew's bottle ships without it, Debian's package with it. An ffmpeg that
 * cannot draw text would fail one slide at a time deep inside the filter
 * graph, so it is asked up front and reported as the one thing it is.
 */
function hasDrawtext(): boolean {
  const filters = spawnSync('ffmpeg', ['-hide_banner', '-filters'], { encoding: 'utf8' })
  return filters.status === 0 && /\bdrawtext\b/.test(filters.stdout ?? '')
}

/** One line of the caption band: what it says, and how it is drawn. */
interface Caption {
  /** The file holding the text — see drawtext for why it is a file. */
  file: string
  font: string
  size: number
  colour: string
  y: number
}

/**
 * One drawtext clause.
 *
 * The text goes through a file rather than the filter string, and `expansion`
 * is off: a step reads "The total reads £45m — 20% up", and `%`, `:` and `'`
 * all mean something to ffmpeg's own expander. Through a file with expansion
 * disabled they mean nothing at all, which is the only way to be sure the
 * video says what the card says.
 */
function drawtext({ file, font, size, colour, y }: Caption): string {
  return [
    'drawtext=',
    `textfile=${file}`,
    ':expansion=none',
    `:fontfile=${font}`,
    `:fontsize=${size}`,
    `:fontcolor=${colour}`,
    ':x=40',
    `:y=${y}`,
    `:line_spacing=${Math.round(size * 0.35)}`,
  ].join('')
}

/** The last few lines of what ffmpeg said, which is where it says what went wrong. */
function ffmpegTail(stderr: string | null | undefined): string {
  return (stderr ?? '').trim().split('\n').slice(-3).join(' ')
}

export interface SlidesOutcome {
  ok: boolean
  /** Absolute path, when one was produced. */
  video: string | null
  slides: number
  missing: number[]
  orphans: number[]
  /** Why there is no video. Empty when there is one. */
  reason: string
}

export interface SlidesOptions {
  result: Result
  dir?: string
  out?: string
  /** Refuse a video larger than this. Jira's own limit is well above it. */
  maxKb?: number
}

/**
 * The font to draw with, or why there is nothing to draw — checked in the
 * order a reviewer would want to be told: nothing to show, then no ffmpeg, then
 * an ffmpeg that cannot do the job, then nothing to write with.
 */
function readiness(plan: Plan): { font: string } | { reason: string } {
  if (plan.slides.length === 0) return { reason: 'no step screenshots were captured' }
  if (!have('ffmpeg')) return { reason: 'ffmpeg is not installed' }
  if (!hasDrawtext()) return { reason: 'this ffmpeg was built without drawtext' }
  const font = firstFont()
  if (font === null) return { reason: 'no usable font was found' }
  return { font }
}

/**
 * The filter graph for one slide, with its three caption files written beside
 * `stem`: the screenshot scaled to fit, letterboxed onto a light ground, padded
 * with the caption band and drawn into.
 */
function slideFilters(slide: Slide, stem: string, font: string): string {
  const labelFile = `${stem}.label.txt`
  const criterionFile = `${stem}.criterion.txt`
  const actionFile = `${stem}.action.txt`
  writeFileSync(labelFile, slide.label)
  writeFileSync(criterionFile, slide.criterion.join('\n'))
  writeFileSync(actionFile, slide.action.join('\n'))

  return [
    `scale=${WIDTH}:${SHOT_HEIGHT}:force_original_aspect_ratio=decrease`,
    `pad=${WIDTH}:${SHOT_HEIGHT}:(ow-iw)/2:(oh-ih)/2:color=${LETTERBOX_BG}`,
    `pad=${WIDTH}:${HEIGHT}:0:0:color=${BAND_BG}`,
    drawtext({ file: labelFile, font, size: LABEL_SIZE, colour: LABEL_FG, y: SHOT_HEIGHT + 24 }),
    drawtext({
      file: criterionFile,
      font,
      size: CRITERION_SIZE,
      colour: CRITERION_FG,
      y: SHOT_HEIGHT + 60,
    }),
    drawtext({
      file: actionFile,
      font,
      size: ACTION_SIZE,
      colour: ACTION_FG,
      y: SHOT_HEIGHT + 136,
    }),
  ].join(',')
}

/** Renders one slide to its own clip in `stem`'s directory. Throws if ffmpeg will not. */
function renderSlide(slide: Slide, stem: string, font: string): string {
  const clip = `${stem}.mp4`
  const rendered = spawnSync(
    'ffmpeg',
    [
      '-y',
      '-loop',
      '1',
      '-t',
      String(slide.seconds),
      '-i',
      slide.shot,
      '-vf',
      slideFilters(slide, stem, font),
      '-r',
      '30',
      '-pix_fmt',
      'yuv420p',
      '-c:v',
      'libx264',
      clip,
    ],
    { encoding: 'utf8' },
  )
  if (rendered.status !== 0) {
    throw new Error(`ffmpeg could not render step ${slide.step.n}: ${ffmpegTail(rendered.stderr)}`)
  }
  return clip
}

/** Joins the clips into `out`. Returns why it could not, or null when it did. */
function joinClips(parts: string[], work: string, out: string): string | null {
  // Single quotes around each path, which the concat demuxer requires; the
  // paths are ours and hold none.
  const list = join(work, 'slides.txt')
  writeFileSync(list, `${parts.map((p) => `file '${p}'`).join('\n')}\n`)

  const joined = spawnSync(
    'ffmpeg',
    ['-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', out],
    { encoding: 'utf8' },
  )
  return joined.status === 0
    ? null
    : `ffmpeg could not join the slides: ${ffmpegTail(joined.stderr)}`
}

/** Removes a video over the cap. Returns why it went, or null when it stays. */
function enforceCap(out: string, maxKb: number): string | null {
  const kb = Math.ceil(statSync(out).size / 1024)
  if (kb <= maxKb) return null
  rmSync(out, { force: true })
  return `the video is ${kb} KB, over the ${maxKb} KB cap`
}

/**
 * Renders every slide, joins them and checks the size, in a work directory
 * that is gone afterwards whatever happened. Returns why there is no video, or
 * null when there is one — so even an error thrown with no message is a failure.
 */
function renderVideo(plan: Plan, font: string, out: string, maxKb: number): string | null {
  const work = mkdtempSync(join(tmpdir(), 'factory-slides-'))
  try {
    const parts = plan.slides.map((slide, index) =>
      renderSlide(slide, join(work, `slide-${String(index).padStart(3, '0')}`), font),
    )
    return joinClips(parts, work, out) ?? enforceCap(out, maxKb)
  } catch (error) {
    return (error as Error).message
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

/**
 * Renders the slides. Returns a reason instead of throwing, always.
 *
 * ffmpeg does the layout as well as the encoding: each screenshot is scaled to
 * fit the frame, letterboxed onto a light ground, padded with the caption band
 * and drawn into. Pulling in an image library to compose the band first would
 * be a dependency for something one filter graph already does.
 */
export function buildSlides(options: SlidesOptions): SlidesOutcome {
  const dir = options.dir ?? EVIDENCE_DIR
  const out = options.out ?? SLIDES_PATH
  const maxKb = options.maxKb ?? 8192

  const plan = planSlides(options.result, dir)
  const base: Omit<SlidesOutcome, 'ok' | 'video' | 'reason'> = {
    slides: plan.slides.length,
    missing: plan.missing,
    orphans: plan.orphans,
  }

  const ready = readiness(plan)
  const reason = 'reason' in ready ? ready.reason : renderVideo(plan, ready.font, out, maxKb)
  return reason === null
    ? { ...base, ok: true, video: out, reason: '' }
    : { ...base, ok: false, video: null, reason }
}
