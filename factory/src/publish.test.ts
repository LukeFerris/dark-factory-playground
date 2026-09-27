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
