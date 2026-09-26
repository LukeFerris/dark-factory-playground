import { describe, expect, it } from 'vitest'
import { isStartComment, startComment } from './announce.ts'
import { adfToText } from './jira.ts'
import type { Meta } from './meta.ts'

function meta(patch: Partial<Meta> = {}): Meta {
  return {
    key: 'DF-7',
    stage: 'build',
    turn: 1,
    branch: 'card/DF-7-a-thing',
    base_sha: 'abc1234',
    pr: null,
    preview_url: null,
    ...patch,
  }
}

describe('the start comment', () => {
  /**
   * The whole reason this exists. A card claimed by the poller sits in
   * "Designing" or "Building" with nothing on it until `report` runs, and a
   * status change notifies nobody — so from the ticket's point of view the
   * factory looks idle for exactly as long as it is busiest.
   */
  it('names the stage and the turn, so a card in flight says so', () => {
    expect(adfToText(startComment(meta({ stage: 'design', turn: 1 }), null))).toContain(
      'design turn 1 started',
    )
    expect(adfToText(startComment(meta({ stage: 'build', turn: 3 }), null))).toContain(
      'build turn 3 started',
    )
  })

  /**
   * The audience is whoever wrote the card, who may not be an engineer. The
   * useful content is "something is happening and you need do nothing", not a
   * description of the pipeline.
   */
  it('says what is being done and that nothing is expected of the reader', () => {
    const first = adfToText(startComment(meta({ stage: 'design', turn: 1 }), null))
    expect(first).toContain('design document')
    expect(first).toContain('Nothing is expected of you')
  })

  /** A later turn is picking up an answer or a review, not starting fresh. */
  it('distinguishes a first turn from a continuation', () => {
    const design = adfToText(startComment(meta({ stage: 'design', turn: 2 }), null))
    expect(design).toContain('answers left on this card')

    const build = adfToText(startComment(meta({ stage: 'build', turn: 2 }), null))
    expect(build).toContain('review comments')
    expect(build).not.toContain('Implementing the approved design')
  })

  /**
   * Turn 1 of a design has no branch and no pull request — `prepare-branch`
   * has not run and `publish` is a long way off. Linking one anyway would put
   * a dead link on the card at the exact moment someone is most likely to
   * click it.
   */
  it('links the run always and the pull request only once there is one', () => {
    // Hrefs live in mark attributes, which adfToText flattens away, so these
    // assertions have to read the document rather than its text.
    const early = JSON.stringify(startComment(meta({ pr: null }), 'https://run/1'))
    expect(early).toContain('https://run/1')
    expect(early).not.toContain('/pull/')

    const previous = process.env['GITHUB_REPOSITORY']
    process.env['GITHUB_REPOSITORY'] = 'o/r'
    try {
      const later = JSON.stringify(startComment(meta({ pr: 20, turn: 2 }), 'https://run/2'))
      expect(later).toContain('https://github.com/o/r/pull/20')
      expect(later).toContain('https://run/2')
    } finally {
      if (previous === undefined) delete process.env['GITHUB_REPOSITORY']
      else process.env['GITHUB_REPOSITORY'] = previous
    }
  })

  /**
   * It is posted before the agent has done anything, so it has nothing to
   * report and must not imply otherwise. Promising an outcome here is how a
   * progress ping turns into a lie.
   */
  it('claims no result, because the turn has not run yet', () => {
    const flat = adfToText(startComment(meta({ stage: 'build', turn: 1 }), 'https://run'))
    for (const word of ['finished', 'ready for review', 'Acceptance criteria']) {
      expect(flat).not.toContain(word)
    }
  })
})

/**
 * `gather` counts a design card's rounds by counting the factory's own
 * comments on it. One extra factory comment per turn would have made every
 * design round count double — turn 1, then 3, then 5 — and told the agent it
 * had asked questions it never asked.
 *
 * So the recogniser and the comment it recognises are pinned to each other
 * here. Change one without the other and this fails rather than the turn
 * counter quietly drifting.
 */
describe('telling a start comment from the factory’s real output', () => {
  it('recognises every start comment it writes', () => {
    for (const stage of ['design', 'build'] as const) {
      for (const turn of [1, 2, 11]) {
        expect(isStartComment(adfToText(startComment(meta({ stage, turn }), 'https://run')))).toBe(
          true,
        )
      }
    }
  })

  /** The other things the factory says on a card must all still count. */
  it('does not mistake a finished turn, a shipped card or a human for one', () => {
    for (const body of [
      'build turn finished — ready for review\nSummary\nIt works.',
      'design turn paused — needs an answer\nQuestions',
      'DF-6 — shipped\nThe pull request for this card is merged.',
      'Started on this, will report back.',
      '',
    ]) {
      expect(isStartComment(body)).toBe(false)
    }
  })
})
