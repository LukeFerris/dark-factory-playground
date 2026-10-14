import type { MergeState } from './merge.ts'

/**
 * A merge attempt's recorded state, for tests that need one without driving git.
 *
 * Not a test file itself, so the tests that use it are what cover it. Only a
 * type is imported from `merge.ts`, so a test that mocks that module can still
 * use this.
 */

/** A card branch that took two commits from main cleanly, unless `over` says otherwise. */
export const mergeState = (over: Partial<MergeState> = {}): MergeState => ({
  branch: 'card/DF-5-add-a-greeting',
  state: 'merged',
  behind: 2,
  conflicts: [],
  denied: [],
  before: 'a'.repeat(40),
  main: 'b'.repeat(40),
  incoming: [],
  ...over,
})
