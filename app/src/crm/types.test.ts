import { describe, expect, it } from 'vitest'
import { formatEmployees } from './types'

describe('formatEmployees', () => {
  it.each([
    [1, '1 employee'],
    [75, '75 employees'],
    [1300, '1,300 employees'],
  ])('formats %d as %j', (count, expected) => {
    expect(formatEmployees(count)).toBe(expected)
  })
})
