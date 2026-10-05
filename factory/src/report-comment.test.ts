import { describe, expect, it } from 'vitest'
import type * as adf from './adf.ts'
import { addressedTo, buildComment } from './report-comment.ts'
import { textOf } from './jira.stub.ts'
import { CRITERIA, NO_LINKS, result } from './report-comment.stub.ts'

/** The level-4 headings, which are the comment's sections. */
function sectionHeadings(doc: adf.AdfDoc): string[] {
  return doc.content
    .filter((n) => n.type === 'heading' && (n['attrs'] as { level: number }).level === 4)
    .map((node) => textOf(node))
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

/**
 * The hand-back is when the card becomes somebody's again, and a mention is the
 * one thing Jira always notifies on — so the person it goes back to hears about
 * it even when they are not watching the card.
 */
describe('addressedTo', () => {
  const comment = buildComment('design', result(), NO_LINKS)

  it('opens the comment with a mention of who the card goes back to', () => {
    const doc = addressedTo(comment, '557058:human')
    expect(doc.content[0]).toEqual({
      type: 'paragraph',
      content: [
        { type: 'mention', attrs: { id: '557058:human' } },
        { type: 'text', text: ' — this card is back with you.' },
      ],
    })
    expect(doc.content.slice(1)).toEqual(comment.content)
  })

  it('leaves the comment alone when there is nobody to hand it back to', () => {
    expect(addressedTo(comment, '')).toBe(comment)
  })
})

describe('buildComment: links, questions and failures', () => {
  it('always links the Actions run that produced it', () => {
    const doc = buildComment('design', result(), {
      ...NO_LINKS,
      prUrl: 'https://gh/pr/1',
      run: 'https://gh/run/9',
    })
    expect(hrefs(doc)).toContain('https://gh/run/9')
  })

  it('links the PR and the preview when both are known', () => {
    const doc = buildComment('build', result(), {
      ...NO_LINKS,
      prUrl: 'https://gh/pr/2',
      previewUrl: 'https://ghcr/pkg',
    })
    expect(hrefs(doc)).toEqual(['https://gh/pr/2', 'https://ghcr/pkg'])
  })

  it('renders questions when the turn is blocked', () => {
    const doc = buildComment(
      'design',
      result({
        status: 'blocked',
        questions: [{ question: 'Debounce the input?', context: 'Perf', options: ['yes', 'no'] }],
      }),
      NO_LINKS,
    )
    const text = textOf(doc)
    expect(text).toContain('Debounce the input?')
    expect(text).toContain('Perf')
    expect(text).toContain('yes / no')
  })

  it('renders the failure reason in a code block when the turn failed', () => {
    const doc = buildComment(
      'build',
      result({ status: 'failed', reason: 'out of scope' }),
      NO_LINKS,
    )
    expect(textOf(doc)).toContain('out of scope')
  })

  it('produces a valid ADF doc envelope', () => {
    const doc = buildComment('design', result(), NO_LINKS)
    expect(doc.type).toBe('doc')
    expect(doc.version).toBe(1)
    expect(Array.isArray(doc.content)).toBe(true)
  })

  it('lists the assumptions the turn made, and omits the heading when there are none', () => {
    const doc = buildComment('build', result({ assumptions: ['Dates are UK format.'] }), NO_LINKS)
    expect(textOf(doc)).toContain('Assumptions')
    expect(textOf(doc)).toContain('Dates are UK format.')
    expect(textOf(buildComment('build', result(), NO_LINKS))).not.toContain('Assumptions')
  })
})

describe('buildComment: the ticket template', () => {
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
      NO_LINKS,
    )
    expect(sectionHeadings(doc)).toEqual([
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
    const doc = buildComment('design', result({ acceptance_criteria: CRITERIA }), NO_LINKS)
    expect(textOf(doc)).not.toContain('Context')
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
      NO_LINKS,
    )
    const at = (type: string): number => doc.content.findIndex((n) => n.type === type)
    const heads = doc.content.filter((n) => n.type === 'heading').map((node) => textOf(node))
    expect(heads).toContain('Answers to your questions')
    // textOf joins sibling nodes with a space, so assert on the two halves.
    expect(textOf(doc)).toContain('Which date format?')
    expect(textOf(doc)).toContain('— Day-month-year, as you asked.')
    expect(at('bulletList')).toBeLessThan(at('orderedList'))
  })

  it('omits the answers section when nothing was answered', () => {
    const doc = buildComment('design', result(), NO_LINKS)
    expect(textOf(doc)).not.toContain('Answers to your questions')
  })

  it('lists what was deliberately left out', () => {
    const doc = buildComment(
      'build',
      result({ out_of_scope: ['Editing a deal after it is saved.'] }),
      NO_LINKS,
    )
    expect(textOf(doc)).toContain('Not in this change')
    expect(textOf(doc)).toContain('Editing a deal after it is saved.')
  })

  it('omits "Not in this change" rather than printing an empty heading', () => {
    expect(textOf(buildComment('build', result(), NO_LINKS))).not.toContain('Not in this change')
  })
})

describe('buildComment: criteria and the steps that prove them', () => {
  // The whole point of the split: the criteria say what "done" means, the steps
  // say how you find out. A single numbered list cannot do both.
  it("bullets the criteria and numbers each criterion's steps separately", () => {
    const doc = buildComment('build', result({ acceptance_criteria: CRITERIA }), NO_LINKS)

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
    const doc = buildComment('build', result({ acceptance_criteria: CRITERIA }), NO_LINKS)
    const bold = doc.content
      .filter((n) => n.type === 'paragraph')
      .flatMap((n) => (n['content'] as Array<Record<string, unknown>>) ?? [])
      .filter(
        (n) =>
          Array.isArray(n['marks']) &&
          (n['marks'] as Array<{ type: string }>)[0]?.type === 'strong',
      )
      .map((n) => n['text'])
    expect(bold).toEqual(CRITERIA.map((c) => c.criterion))
  })

  it('says a design turn has not built the thing yet, and a build turn has', () => {
    const criteria = { acceptance_criteria: CRITERIA }
    const design = textOf(buildComment('design', result(criteria), NO_LINKS))
    expect(design).toContain('What the build has to make true')
    expect(design).toContain('Once the build lands')

    const build = textOf(buildComment('build', result(criteria), NO_LINKS))
    expect(build).not.toContain('What the build has to make true')
    expect(build).toContain('With the app open in a browser')
  })

  // A reviewer holding the video beside the comment has to be able to find
  // step 3 in it. Per-criterion numbering restarting at 1 gives them two step
  // 1s and no step 3 at all.
  it('numbers the steps straight through the card, across criteria', () => {
    const doc = buildComment('build', result({ acceptance_criteria: CRITERIA }), NO_LINKS)
    const numbered = doc.content.filter((n) => n.type === 'orderedList')
    expect((numbered[0]?.['attrs'] as { order: number }).order).toBe(1)
    expect((numbered[1]?.['attrs'] as { order: number }).order).toBe(3)
  })
})
