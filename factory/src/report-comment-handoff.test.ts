import { describe, expect, it } from 'vitest'
import { buildComment, fallbackComment } from './report-comment.ts'
import { textOf } from './jira.stub.ts'
import { CRITERIA, NO_LINKS, result } from './report-comment.stub.ts'

/**
 * The end of the comment, where it hands the card to the reviewer: the evidence
 * they can check the steps against, what they should do next, and the plain
 * comment that goes on the card when Jira refuses the real one.
 */

describe('buildComment: evidence', () => {
  it('marks only the steps the walkthrough actually shows', () => {
    const doc = buildComment('build', result({ acceptance_criteria: CRITERIA }), {
      ...NO_LINKS,
      evidence: { video: 'att-1', proved: [1, 3] },
    })
    const numbered = doc.content.filter((n) => n.type === 'orderedList')
    const items = (numbered[0]?.['content'] as unknown[]).map((node) => textOf(node))
    expect(items[0]).toContain('(in the walkthrough)')
    expect(items[1]).not.toContain('(in the walkthrough)')
    expect(textOf(numbered[1])).toContain('(in the walkthrough)')
  })

  // Jira refuses a media node built from an attachment id — see the note at
  // the top of `adf.ts`. The comment therefore sends the reviewer to the
  // Attachments panel, and has to name the file they will find there.
  it('names the walkthrough file rather than trying to embed it', () => {
    const doc = buildComment('build', result({ acceptance_criteria: CRITERIA }), {
      ...NO_LINKS,
      evidence: { video: 'att-1', proved: [1] },
    })
    expect(textOf(doc)).toContain('uat-slides.mp4')
  })

  // The regression that stranded DF-9 in "Building". Any media node at all is
  // a 400 from the comment API, and a 400 here used to cost the hand-off.
  it('puts no media node in the comment at all', () => {
    const doc = buildComment('build', result({ acceptance_criteria: CRITERIA }), {
      ...NO_LINKS,
      evidence: { video: 'att-1', proved: [1, 2, 3] },
    })
    const types = JSON.stringify(doc)
    expect(types).not.toContain('"mediaSingle"')
    expect(types).not.toContain('"mediaGroup"')
    expect(types).not.toContain('"media"')
  })

  // Evidence is an enrichment. Without it the comment is the comment it always
  // was, and nothing in it promises a video that is not there.
  it('says nothing about a walkthrough when there is none', () => {
    const doc = buildComment('build', result({ acceptance_criteria: CRITERIA }), {
      ...NO_LINKS,
      evidence: { video: null, proved: [1, 2, 3] },
    })
    expect(textOf(doc)).not.toContain('walkthrough')
    expect(textOf(doc)).not.toContain('uat-slides.mp4')
  })
})

describe('buildComment: what happens next', () => {
  // The board has no "Ready for deploy": a build is accepted by merging, and
  // the factory sets Done itself. Telling a reviewer otherwise sends them to
  // look for a column that does not exist.
  it('tells a build reviewer to merge, not to drag the card', () => {
    const text = textOf(buildComment('build', result({ acceptance_criteria: CRITERIA }), NO_LINKS))
    expect(text).toContain('What happens next')
    expect(text).toContain('approve and merge the pull request')
    expect(text).not.toContain('Ready for deploy')
  })

  it('tells a design reviewer which column moves it on', () => {
    const text = textOf(buildComment('design', result({ acceptance_criteria: CRITERIA }), NO_LINKS))
    expect(text).toContain('"Ready for build"')
  })

  it('asks for a reply on the card when it is waiting on an answer', () => {
    for (const status of ['blocked', 'question', 'failed'] as const) {
      const text = textOf(buildComment('build', result({ status, reason: 'x' }), NO_LINKS))
      expect(text).toContain('Reply on this card with the answer')
    }
  })

  // A continue design turn leaves the card in a status the poller does not
  // watch, so an invitation to reply there is an invitation into a void.
  it('says nothing to do when there is nothing the reader can do', () => {
    const text = textOf(buildComment('design', result({ status: 'continue' }), NO_LINKS))
    expect(text).not.toContain('What happens next')
  })

  it('points a continuing build turn at the pull request', () => {
    const text = textOf(buildComment('build', result({ status: 'continue' }), NO_LINKS))
    expect(text).toContain('Comment on the pull request to grant the next turn')
  })
})

/**
 * The comment of last resort. It runs only after Jira has already refused
 * something, so what matters is that it cannot be refused for the same class
 * of reason: no headings, no lists, no marks, no media — paragraphs of text.
 */
describe('fallbackComment', () => {
  const plain = fallbackComment(
    'build',
    result({ status: 'ready_for_review', summary: 'Deals can be edited.' }),
    'https://github.com/o/r/pull/34',
  )

  it('uses paragraphs of text and nothing else', () => {
    expect(plain.content.every((n) => n.type === 'paragraph')).toBe(true)
    const marks = JSON.stringify(plain)
    expect(marks).not.toContain('"marks"')
    expect(marks).not.toContain('"heading"')
    expect(marks).not.toContain('"media"')
    expect(marks).not.toContain('"bulletList"')
    expect(marks).not.toContain('"orderedList"')
  })

  // A reviewer reading this needs to know the shortfall is in the comment and
  // not in the work, or the sensible reaction is to distrust the turn.
  it('says the work is unaffected and the evidence is still on the card', () => {
    const text = textOf(plain)
    expect(text).toContain('nothing about the work itself has changed')
    expect(text).toContain('Attachments panel')
  })

  it('carries the summary and the pull request through', () => {
    const text = textOf(plain)
    expect(text).toContain('Deals can be edited.')
    expect(text).toContain('https://github.com/o/r/pull/34')
  })

  it('leaves the pull request line out when there is none', () => {
    expect(textOf(fallbackComment('design', result(), null))).not.toContain('Pull request:')
  })
})
