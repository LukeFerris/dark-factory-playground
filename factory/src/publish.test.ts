import { describe, expect, it } from 'vitest'
import { prBody } from './publish.ts'
import type { Result } from './schema.ts'

function result(over: Partial<Result> = {}): Result {
  return {
    status: 'ready_for_review',
    summary: 'Added the close date.',
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

/**
 * The PR body and the card comment answer to two different readers, and only
 * the card one is covered elsewhere. What is pinned here is the part they
 * share: a reviewer who finds something missing should already have been told
 * it was deliberate, whichever of the two they are reading.
 */
describe('prBody', () => {
  it('says what was deliberately left out', () => {
    const body = prBody(
      'DF-9',
      'Add a close date',
      result({ out_of_scope: ['Editing a deal after it is saved.'] }),
      null,
    )
    expect(body).toContain('### Not in this change')
    expect(body).toContain('- Editing a deal after it is saved.')
  })

  it('omits the heading rather than printing an empty one', () => {
    expect(prBody('DF-9', 'Add a close date', result(), null)).not.toContain('Not in this change')
  })

  it('keeps it below the steps and above the assumptions, as on the card', () => {
    const body = prBody(
      'DF-9',
      'Add a close date',
      result({
        acceptance_criteria: [{ criterion: 'A deal has a close date.', steps: ['Open the app.'] }],
        out_of_scope: ['Editing a saved deal.'],
        assumptions: ['Assumed dates are shown day-first.'],
      }),
      null,
    )
    expect(body.indexOf('### Proving it')).toBeLessThan(body.indexOf('### Not in this change'))
    expect(body.indexOf('### Not in this change')).toBeLessThan(body.indexOf('### Assumptions'))
  })
})

describe('prBody, section by section', () => {
  it('puts the preview above the steps, so the reviewer has somewhere to follow them', () => {
    const body = prBody(
      'DF-9',
      'Add a close date',
      result({
        context: '  See the design doc.  ',
        acceptance_criteria: [{ criterion: 'A deal has a close date.', steps: ['Open', 'Look'] }],
      }),
      'https://pr-9.preview.example',
    )
    expect(body).toContain('### Context\n\nSee the design doc.\n')
    expect(body).toContain('**Preview:** https://pr-9.preview.example')
    expect(body.indexOf('**Preview:**')).toBeLessThan(body.indexOf('### Proving it'))
    expect(body).toContain('**A deal has a close date.**\n\n1. Open\n2. Look\n')
  })

  it('leaves out an empty preview URL and an empty context', () => {
    const body = prBody('DF-9', 'Add a close date', result(), '')
    expect(body).not.toContain('**Preview:**')
    expect(body).not.toContain('### Context')
  })

  it('lists open questions with whatever context and options they came with', () => {
    const body = prBody(
      'DF-9',
      'Add a close date',
      result({
        questions: [
          { question: 'Which format?', context: 'Two markets.', options: ['ISO', 'Local'] },
          { question: 'Required?', context: '', options: [] },
        ],
      }),
      null,
    )
    expect(body).toContain(
      '### Open questions\n\n- **Which format?**\n  - Context: Two markets.\n  - Options: ISO / Local\n- **Required?**\n\n',
    )
  })

  it('lists the files as code, and always ends with the note about the block', () => {
    const body = prBody(
      'DF-9',
      'Add a close date',
      result({ artifacts: ['app/src/Deal.tsx'] }),
      null,
    )
    expect(body).toContain('### Files\n\n- `app/src/Deal.tsx`\n')
    expect(body.endsWith('leave it alone._\n')).toBe(true)
  })
})
