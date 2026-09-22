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

  it('follows the ticket template: Summary, Context, Acceptance criteria, Proving it', () => {
    const doc = buildComment(
      'design',
      result({ context: 'Smallest change that satisfies the card.', acceptance_criteria: CRITERIA }),
      null,
      null,
      null,
    )
    const headings = doc.content
      .filter((n) => n.type === 'heading' && (n['attrs'] as { level: number }).level === 4)
      .map(textOf)
    expect(headings).toEqual(['Summary', 'Context', 'Acceptance criteria', 'Proving it'])
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

  it('prefixes with the stage', () => {
    expect(branchName('design', 'DF-1', 'Type a name')).toBe('design/DF-1-type-a-name')
    expect(branchName('build', 'DF-1', 'Type a name')).toBe('build/DF-1-type-a-name')
  })
})
