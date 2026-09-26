import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { greetingPrefix, useGreeting } from './useGreeting'

/** A fixed date whose local hour is `hour`, so the tests hold in any time zone. */
function localTimeAt(hour: number): Date {
  return new Date(2026, 0, 15, hour, 30, 0)
}

describe('greetingPrefix', () => {
  it('greets the morning from 05:00 to 11:59', () => {
    expect(greetingPrefix(5)).toBe('Good morning')
    expect(greetingPrefix(11)).toBe('Good morning')
  })

  it('greets the afternoon from 12:00 to 17:59', () => {
    expect(greetingPrefix(12)).toBe('Good afternoon')
    expect(greetingPrefix(17)).toBe('Good afternoon')
  })

  it('greets the evening from 18:00 to 23:59', () => {
    expect(greetingPrefix(18)).toBe('Good evening')
    expect(greetingPrefix(23)).toBe('Good evening')
  })

  it('keeps greeting the evening through midnight to 04:59', () => {
    expect(greetingPrefix(0)).toBe('Good evening')
    expect(greetingPrefix(4)).toBe('Good evening')
  })

  it('returns one of the three prefixes for every hour of the day', () => {
    for (let hour = 0; hour <= 23; hour += 1) {
      expect(greetingPrefix(hour)).toBeOneOf(['Good morning', 'Good afternoon', 'Good evening'])
    }
  })
})

describe('useGreeting', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('greets the name it is given for the current period', () => {
    vi.setSystemTime(localTimeAt(9))
    expect(useGreeting('Ada')).toBe('Good morning, Ada')
  })

  it('chooses the period independently of the name', () => {
    vi.setSystemTime(localTimeAt(20))
    expect(useGreeting('Ada')).toBe('Good evening, Ada')
  })

  it('falls back to "world" when the name is whitespace only', () => {
    vi.setSystemTime(localTimeAt(9))
    expect(useGreeting('   ')).toBe('Good morning, world')
  })

  it('falls back to "world" when the name is empty', () => {
    vi.setSystemTime(localTimeAt(9))
    expect(useGreeting('')).toBe('Good morning, world')
  })
})
