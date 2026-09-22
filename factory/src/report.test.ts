import { describe, expect, it } from 'vitest'
import { buildComment, targetStatus } from './report.ts'
import { STATUS_TRANSITIONS, type Result } from './schema.ts'
import { slugify, branchName } from './branch.ts'

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

  it('follows the ticket template: Summary, then Context, then Acceptance criteria', () => {
    const doc = buildComment(
      'design',
      result({ context: 'Smallest change that satisfies the card.', acceptance_criteria: ['Type Ada.'] }),
      null,
      null,
      null,
    )
    const headings = doc.content
      .filter((n) => n.type === 'heading' && (n['attrs'] as { level: number }).level === 4)
      .map(textOf)
    expect(headings).toEqual(['Summary', 'Context', 'Acceptance criteria'])
  })

  it('omits Context when the agent left it empty', () => {
    const doc = buildComment('design', result({ acceptance_criteria: ['Type Ada.'] }), null, null, null)
    expect(textOf(doc)).not.toContain('Context')
  })

  it('numbers the acceptance criteria, because they are steps in order', () => {
    const doc = buildComment(
      'build',
      result({ acceptance_criteria: ['Type Ada.', 'The heading reads Hello, Ada.'] }),
      null,
      null,
      null,
    )
    const list = doc.content.find((n) => n.type === 'orderedList')
    expect(list).toBeDefined()
    expect((list?.['content'] as unknown[]).length).toBe(2)
    expect(textOf(list)).toContain('The heading reads Hello, Ada.')
  })

  it('says a design turn has not built the thing yet, and a build turn has', () => {
    const steps = { acceptance_criteria: ['Type Ada.'] }
    expect(textOf(buildComment('design', result(steps), null, null, null))).toContain(
      'What the build has to make true',
    )
    expect(textOf(buildComment('build', result(steps), null, null, null))).not.toContain(
      'What the build has to make true',
    )
  })

  it('produces a valid ADF doc envelope', () => {
    const doc = buildComment('design', result(), null, null, null)
    expect(doc.type).toBe('doc')
    expect(doc.version).toBe(1)
    expect(Array.isArray(doc.content)).toBe(true)
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
