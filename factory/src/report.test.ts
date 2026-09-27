import { afterEach, describe, expect, it } from 'vitest'
import { prUrl } from './env.ts'
import { buildComment, targetStatus } from './report.ts'
import { STATUS_TRANSITIONS, type Criterion, type Result } from './schema.ts'
import { slugify, branchName } from './branch.ts'

/** Two criteria with unequal step counts, so a flattened render is visible. */
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
    summary: 'Wrote the design.',
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
}

/** Walks an ADF tree collecting every text node, so assertions read plainly. */
function textOf(node: unknown): string {
  if (node === null || typeof node !== 'object') return ''
  const n = node as Record<string, unknown>
  const own = typeof n['text'] === 'string' ? (n['text'] as string) : ''
  const kids = Array.isArray(n['content']) ? (n['content'] as unknown[]) : []
  return own + kids.map(textOf).join(' ')
}

function hrefs(node: unknown): string[] {
  if (node === null || typeof node !== 'object') return []
  const n = node as Record<string, unknown>
  const marks = Array.isArray(n['marks']) ? (n['marks'] as Array<Record<string, unknown>>) : []
  const own = marks
    .filter((m) => m['type'] === 'link')
    .map((m) => (m['attrs'] as Record<string, unknown>)['href'] as string)
  const kids = Array.isArray(n['content']) ? (n['content'] as unknown[]) : []
  return [...own, ...kids.flatMap(hrefs)]
}

describe('buildComment', () => {
  it('always links the Actions run that produced it', () => {
    const doc = buildComment('design', result(), 'https://gh/pr/1', null, 'https://gh/run/9')
    expect(hrefs(doc)).toContain('https://gh/run/9')
  })

  it('links the PR and the preview when both are known', () => {
    const doc = buildComment('build', result(), 'https://gh/pr/2', 'https://ghcr/pkg', null)
    expect(hrefs(doc)).toEqual(['https://gh/pr/2', 'https://ghcr/pkg'])
  })

  it('renders questions when the turn is blocked', () => {
    const doc = buildComment(
      'design',
      result({
        status: 'blocked',
        questions: [{ question: 'Debounce the input?', context: 'Perf', options: ['yes', 'no'] }],
      }),
      null,
      null,
      null,
    )
    const text = textOf(doc)
    expect(text).toContain('Debounce the input?')
    expect(text).toContain('Perf')
    expect(text).toContain('yes / no')
  })

  it('renders the failure reason in a code block when the turn failed', () => {
    const doc = buildComment('build', result({ status: 'failed', reason: 'out of scope' }), null, null, null)
    expect(textOf(doc)).toContain('out of scope')
  })

  // The whole card is one shape, read top to bottom: what happened, what was
  // asked and answered, what to check, what was left out, and what to do now.
  it('follows the ticket template, every section in its place', () => {
    const doc = buildComment(
      'design',
      result({
        context: 'Smallest change that satisfies the card.',
        acceptance_criteria: CRITERIA,
        answers: [{ question: 'Which date format?', answer: 'Day-month-year.' }],
        out_of_scope: ['Editing a deal after it is saved.'],
      }),
      null,
      null,
      null,
    )
    const headings = doc.content
      .filter((n) => n.type === 'heading' && (n['attrs'] as { level: number }).level === 4)
      .map(textOf)
    expect(headings).toEqual([
      'Summary',
      'Context',
      'Answers to your questions',
      'Acceptance criteria',
      'Proving it',
      'Not in this change',
      'What happens next',
    ])
  })

  it('omits Context when the agent left it empty', () => {
    const doc = buildComment('design', result({ acceptance_criteria: CRITERIA }), null, null, null)
    expect(textOf(doc)).not.toContain('Context')
  })

  // The whole point of the split: the criteria say what "done" means, the steps
  // say how you find out. A single numbered list cannot do both.
  it('bullets the criteria and numbers each criterion\'s steps separately', () => {
    const doc = buildComment('build', result({ acceptance_criteria: CRITERIA }), null, null, null)

    const bullets = doc.content.filter((n) => n.type === 'bulletList')
    expect(bullets).toHaveLength(1)
    expect((bullets[0]?.['content'] as unknown[]).length).toBe(2)
    expect(textOf(bullets[0])).toContain('The greeting names whoever you typed.')
    expect(textOf(bullets[0])).not.toContain('Type "Ada"')

    // One numbered list per criterion, not one for the lot.
    const numbered = doc.content.filter((n) => n.type === 'orderedList')
    expect(numbered).toHaveLength(2)
    expect((numbered[0]?.['content'] as unknown[]).length).toBe(2)
    expect((numbered[1]?.['content'] as unknown[]).length).toBe(1)
    expect(textOf(numbered[0])).toContain('The heading reads "Hello, Ada".')
  })

  it('heads each group of steps with the criterion they prove', () => {
    const doc = buildComment('build', result({ acceptance_criteria: CRITERIA }), null, null, null)
    const bold = doc.content
      .filter((n) => n.type === 'paragraph')
      .flatMap((n) => (n['content'] as Array<Record<string, unknown>>) ?? [])
      .filter((n) => Array.isArray(n['marks']) && (n['marks'] as Array<{ type: string }>)[0]?.type === 'strong')
      .map((n) => n['text'])
    expect(bold).toEqual(CRITERIA.map((c) => c.criterion))
  })

  it('says a design turn has not built the thing yet, and a build turn has', () => {
    const criteria = { acceptance_criteria: CRITERIA }
    const design = textOf(buildComment('design', result(criteria), null, null, null))
    expect(design).toContain('What the build has to make true')
    expect(design).toContain('Once the build lands')

    const build = textOf(buildComment('build', result(criteria), null, null, null))
    expect(build).not.toContain('What the build has to make true')
    expect(build).toContain('With the app open in a browser')
  })

  // A reviewer holding the video beside the comment has to be able to find
  // step 3 in it. Per-criterion numbering restarting at 1 gives them two step
  // 1s and no step 3 at all.
  it('numbers the steps straight through the card, across criteria', () => {
    const doc = buildComment('build', result({ acceptance_criteria: CRITERIA }), null, null, null)
    const numbered = doc.content.filter((n) => n.type === 'orderedList')
    expect((numbered[0]?.['attrs'] as { order: number }).order).toBe(1)
    expect((numbered[1]?.['attrs'] as { order: number }).order).toBe(3)
  })

  it('marks only the steps the walkthrough actually shows', () => {
    const doc = buildComment('build', result({ acceptance_criteria: CRITERIA }), null, null, null, {
      video: 'att-1',
      proved: [1, 3],
    })
    const numbered = doc.content.filter((n) => n.type === 'orderedList')
    const items = (numbered[0]?.['content'] as unknown[]).map(textOf)
    expect(items[0]).toContain('(in the walkthrough)')
    expect(items[1]).not.toContain('(in the walkthrough)')
    expect(textOf(numbered[1])).toContain('(in the walkthrough)')
  })

  it('embeds the walkthrough by the attachment id Jira gave back', () => {
    const doc = buildComment('build', result({ acceptance_criteria: CRITERIA }), null, null, null, {
      video: 'att-1',
      proved: [1],
    })
    const media = doc.content.filter((n) => n.type === 'mediaSingle')
    expect(media).toHaveLength(1)
    const inner = (media[0]?.['content'] as Array<Record<string, unknown>>)[0]
    expect(inner?.['type']).toBe('media')
    expect((inner?.['attrs'] as { id: string }).id).toBe('att-1')
  })

  // Evidence is an enrichment. Without it the comment is the comment it always
  // was, and nothing in it promises a video that is not there.
  it('says nothing about a walkthrough when there is none', () => {
    const doc = buildComment('build', result({ acceptance_criteria: CRITERIA }), null, null, null, {
      video: null,
      proved: [1, 2, 3],
    })
    expect(doc.content.filter((n) => n.type === 'mediaSingle')).toHaveLength(0)
    expect(textOf(doc)).not.toContain('walkthrough')
  })

  // The reader of an answer is the person who wrote the reply it answers, and
  // they are scanning for their own words rather than reading top to bottom.
  it('puts the answers above the work they produced', () => {
    const doc = buildComment(
      'design',
      result({
        acceptance_criteria: CRITERIA,
        answers: [{ question: 'Which date format?', answer: 'Day-month-year, as you asked.' }],
      }),
      null,
      null,
      null,
    )
    const at = (type: string): number => doc.content.findIndex((n) => n.type === type)
    const heads = doc.content.filter((n) => n.type === 'heading').map(textOf)
    expect(heads).toContain('Answers to your questions')
    // textOf joins sibling nodes with a space, so assert on the two halves.
    expect(textOf(doc)).toContain('Which date format?')
    expect(textOf(doc)).toContain('— Day-month-year, as you asked.')
    expect(at('bulletList')).toBeLessThan(at('orderedList'))
  })

  it('omits the answers section when nothing was answered', () => {
    const doc = buildComment('design', result(), null, null, null)
    expect(textOf(doc)).not.toContain('Answers to your questions')
  })

  it('lists what was deliberately left out', () => {
    const doc = buildComment(
      'build',
      result({ out_of_scope: ['Editing a deal after it is saved.'] }),
      null,
      null,
      null,
    )
    expect(textOf(doc)).toContain('Not in this change')
    expect(textOf(doc)).toContain('Editing a deal after it is saved.')
  })

  it('omits "Not in this change" rather than printing an empty heading', () => {
    expect(textOf(buildComment('build', result(), null, null, null))).not.toContain(
      'Not in this change',
    )
  })

  // The board has no "Ready for deploy": a build is accepted by merging, and
  // the factory sets Done itself. Telling a reviewer otherwise sends them to
  // look for a column that does not exist.
  it('tells a build reviewer to merge, not to drag the card', () => {
    const text = textOf(buildComment('build', result({ acceptance_criteria: CRITERIA }), null, null, null))
    expect(text).toContain('What happens next')
    expect(text).toContain('approve and merge the pull request')
    expect(text).not.toContain('Ready for deploy')
  })

  it('tells a design reviewer which column moves it on', () => {
    const text = textOf(buildComment('design', result({ acceptance_criteria: CRITERIA }), null, null, null))
    expect(text).toContain('"Ready for build"')
  })

  it('asks for a reply on the card when it is waiting on an answer', () => {
    for (const status of ['blocked', 'question', 'failed'] as const) {
      const text = textOf(buildComment('build', result({ status, reason: 'x' }), null, null, null))
      expect(text).toContain('Reply on this card with the answer')
    }
  })

  // A continue design turn leaves the card in a status the poller does not
  // watch, so an invitation to reply there is an invitation into a void.
  it('says nothing to do when there is nothing the reader can do', () => {
    const text = textOf(buildComment('design', result({ status: 'continue' }), null, null, null))
    expect(text).not.toContain('What happens next')
  })

  it('points a continuing build turn at the pull request', () => {
    const text = textOf(buildComment('build', result({ status: 'continue' }), null, null, null))
    expect(text).toContain('Comment on the pull request to grant the next turn')
  })

  it('produces a valid ADF doc envelope', () => {
    const doc = buildComment('design', result(), null, null, null)
    expect(doc.type).toBe('doc')
    expect(doc.version).toBe(1)
    expect(Array.isArray(doc.content)).toBe(true)
  })
})

describe('prUrl', () => {
  const saved = { ...process.env }
  afterEach(() => {
    process.env = { ...saved }
  })

  it('builds the URL from the repository it is running in', () => {
    process.env['GITHUB_REPOSITORY'] = 'LukeFerris/dark-factory-playground'
    delete process.env['GITHUB_SERVER_URL']
    expect(prUrl(8)).toBe('https://github.com/LukeFerris/dark-factory-playground/pull/8')
  })

  it('honours a self-hosted server URL', () => {
    process.env['GITHUB_REPOSITORY'] = 'acme/widgets'
    process.env['GITHUB_SERVER_URL'] = 'https://ghe.acme.internal'
    expect(prUrl(3)).toBe('https://ghe.acme.internal/acme/widgets/pull/3')
  })

  it('returns null when there is no PR yet, or no repository to build one from', () => {
    process.env['GITHUB_REPOSITORY'] = 'acme/widgets'
    expect(prUrl(null)).toBeNull()
    delete process.env['GITHUB_REPOSITORY']
    expect(prUrl(8)).toBeNull()
  })
})

describe('status -> Jira status mapping', () => {
  it('sends a finished design to Design review and a finished build to In review', () => {
    expect(targetStatus('design', result({ status: 'ready_for_review' }))).toBe('Design review')
    expect(targetStatus('build', result({ status: 'ready_for_review' }))).toBe('In review')
  })

  it('routes blocked and question to the stage-appropriate blocked status', () => {
    expect(targetStatus('design', result({ status: 'blocked' }))).toBe('Blocked on architect')
    expect(targetStatus('build', result({ status: 'question' }))).toBe('Blocked on engineer')
  })

  it('leaves the card alone on continue', () => {
    expect(targetStatus('build', result({ status: 'continue' }))).toBeNull()
  })

  it('covers every result status for both stages', () => {
    for (const stage of ['design', 'build'] as const) {
      for (const status of Object.keys(STATUS_TRANSITIONS[stage])) {
        expect(STATUS_TRANSITIONS[stage]).toHaveProperty(status)
      }
    }
  })
})

describe('branch naming', () => {
  it('slugifies a card summary', () => {
    expect(slugify('Let the user type their name!')).toBe('let-the-user-type-their-name')
  })

  it('truncates without leaving a trailing dash', () => {
    expect(slugify('a'.repeat(60))).toHaveLength(48)
    expect(slugify('word '.repeat(30)).endsWith('-')).toBe(false)
  })

  // The stage used to be in here, which gave a card two branches and two pull
  // requests. One branch per card is what puts the design document in the
  // build turn's tree without anything having to merge it to main first.
  it('names the branch after the card, not the stage', () => {
    expect(branchName('DF-1', 'Type a name')).toBe('card/DF-1-type-a-name')
  })
})
