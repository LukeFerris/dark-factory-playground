import { describe, expect, it } from 'vitest'
import { cardOf } from './jira.stub.ts'

/**
 * The fake board's one rule of its own: a route about a card it does not have
 * is a broken test, and says so, rather than answering as if the card were
 * empty.
 */
describe('the fake Jira board', () => {
  it('refuses a card it does not have', () => {
    expect(() => cardOf({ 'DF-1': { status: 'Building' } }, { key: 'DF-2' })).toThrow(
      'DF-2 is not on the fake board',
    )
  })
})
