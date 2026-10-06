import { describe, expect, it } from 'vitest'
import { parseEmployees, parseSize, validateDeal } from './validateDeal'

const valid = { company: 'Acme Logistics', sector: 'Industrials', employees: '250', size: '45', owner: 'Sam Patel' }

describe('parseSize', () => {
  it('treats blank as no size', () => {
    expect(parseSize('')).toBeUndefined()
    expect(parseSize('   ')).toBeUndefined()
  })

  it('reads a number above 0, ignoring surrounding space', () => {
    expect(parseSize(' 12.5 ')).toBe(12.5)
  })

  it.each(['0', '-5', 'abc'])('rejects %j', (value) => {
    expect(parseSize(value)).toBeNull()
  })
})

describe('parseEmployees', () => {
  it('treats blank as not known', () => {
    expect(parseEmployees('')).toBeUndefined()
    expect(parseEmployees('   ')).toBeUndefined()
  })

  it.each([
    ['250', 250],
    [' 250 ', 250],
    ['1,200', 1200],
  ])('reads %j as %d', (value, expected) => {
    expect(parseEmployees(value)).toBe(expected)
  })

  it.each(['0', '-3', '12.5', 'abc', '1e3'])('rejects %j', (value) => {
    expect(parseEmployees(value)).toBeNull()
  })
})

describe('validateDeal', () => {
  it('returns a trimmed deal with a numeric size and employees', () => {
    expect(
      validateDeal({
        company: '  Acme Logistics ',
        sector: ' Industrials ',
        employees: ' 1,200 ',
        size: ' 45 ',
        owner: ' Sam Patel ',
      }),
    ).toEqual({ deal: { company: 'Acme Logistics', sector: 'Industrials', employees: 1200, size: 45, owner: 'Sam Patel' } })
  })

  it('gives no size for a blank size', () => {
    const result = validateDeal({ ...valid, size: '' })
    expect(result).toEqual({
      deal: { company: 'Acme Logistics', sector: 'Industrials', employees: 250, size: undefined, owner: 'Sam Patel' },
    })
  })

  it('gives no employees for a blank employees', () => {
    const result = validateDeal({ ...valid, employees: '' })
    expect(result).toEqual({
      deal: { company: 'Acme Logistics', sector: 'Industrials', employees: undefined, size: 45, owner: 'Sam Patel' },
    })
  })

  it.each(['', '   '])('rejects a company of %j', (company) => {
    expect(validateDeal({ ...valid, company })).toEqual({ errors: { company: 'Enter a company name' } })
  })

  it.each(['0', '-5', 'abc'])('rejects a size of %j', (size) => {
    expect(validateDeal({ ...valid, size })).toEqual({ errors: { size: 'Enter a size above 0' } })
  })

  it.each(['0', '12.5', 'abc'])('rejects employees of %j', (employees) => {
    expect(validateDeal({ ...valid, employees })).toEqual({ errors: { employees: 'Enter a whole number above 0' } })
  })

  it('reports every error together', () => {
    expect(validateDeal({ ...valid, company: '', employees: '0', size: '0' })).toEqual({
      errors: { company: 'Enter a company name', employees: 'Enter a whole number above 0', size: 'Enter a size above 0' },
    })
  })
})
