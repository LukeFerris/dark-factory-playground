import type { CommentOptions } from './report-comment.ts'
import type { Criterion, Result } from './schema.ts'

/**
 * A turn's result, and how to read the comment built from it, for the tests of
 * `report-comment.ts`.
 *
 * Not a test file itself, so the tests that use it are what cover it.
 */

/** Two criteria with unequal step counts, so a flattened render is visible. */
export const CRITERIA: Criterion[] = [
  {
    criterion: 'The greeting names whoever you typed.',
    steps: ['Type "Ada" into the field labelled "Your name".', 'The heading reads "Hello, Ada".'],
  },
  {
    criterion: 'An empty field falls back to "Hello, there".',
    steps: ['Clear the field. The heading reads "Hello, there".'],
  },
]

export function result(over: Partial<Result> = {}): Result {
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

/** A comment with nothing to link to: no pull request, no preview and no run. */
export const NO_LINKS: CommentOptions = { prUrl: null, previewUrl: null, run: null }
