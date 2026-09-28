import { describe, expect, it } from 'vitest'
import { parseSize, validateDeal } from './validateDeal'

const valid = { company: 'Acme Logistics', sector: 'Industrials', size: '45', owner: 'Sam Patel' }

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

describe('validateDeal', () => {
  it('returns a trimmed deal with a numeric size', () => {
    expect(
      validateDeal({ company: '  Acme Logistics ', sector: ' Industrials ', size: ' 45 ', owner: ' Sam Patel ' }),
    ).toEqual({ deal: { company: 'Acme Logistics', sector: 'Industrials', size: 45, owner: 'Sam Patel' } })
  })

  it('gives no size for a blank size', () => {
    const result = validateDeal({ ...valid, size: '' })
    expect(result).toEqual({ deal: { company: 'Acme Logistics', sector: 'Industrials', size: undefined, owner: 'Sam Patel' } })
  })

  it.each(['', '   '])('rejects a company of %j', (company) => {
    expect(validateDeal({ ...valid, company })).toEqual({ errors: { company: 'Enter a company name' } })
  })

  it.each(['0', '-5', 'abc'])('rejects a size of %j', (size) => {
    expect(validateDeal({ ...valid, size })).toEqual({ errors: { size: 'Enter a size above 0' } })
  })

  it('reports both errors together', () => {
    expect(validateDeal({ ...valid, company: '', size: '0' })).toEqual({
      errors: { company: 'Enter a company name', size: 'Enter a size above 0' },
    })
  })
})
