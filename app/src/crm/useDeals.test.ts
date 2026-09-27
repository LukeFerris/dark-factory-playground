import { beforeEach, describe, expect, it } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { STORAGE_KEY, useDeals } from './useDeals'
import { SEED_DEALS } from './seed'
import type { Deal } from './types'

function stored(): Deal[] {
  return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Deal[]
}

describe('useDeals', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('seeds the sample deals when storage is empty', () => {
    const { result } = renderHook(() => useDeals())
    expect(result.current.deals).toEqual(SEED_DEALS)
  })

  it('loads stored deals when present', () => {
    const saved: Deal[] = [{ id: 'a', company: 'Saved Co', sector: '', stage: 'Closed', owner: '' }]
    localStorage.setItem(STORAGE_KEY, JSON.stringify(saved))
    const { result } = renderHook(() => useDeals())
    expect(result.current.deals).toEqual(saved)
  })

  it('falls back to the seed when storage cannot be parsed', () => {
    localStorage.setItem(STORAGE_KEY, '{not json')
    const { result } = renderHook(() => useDeals())
    expect(result.current.deals).toEqual(SEED_DEALS)
  })

  it('falls back to the seed when storage does not hold a list', () => {
    localStorage.setItem(STORAGE_KEY, '{"company":"x"}')
    const { result } = renderHook(() => useDeals())
    expect(result.current.deals).toEqual(SEED_DEALS)
  })

  it('adds a deal in Sourcing with a trimmed company and a fresh id', () => {
    const { result } = renderHook(() => useDeals())
    act(() => {
      result.current.addDeal({ company: '  Acme Logistics  ', sector: 'Industrials', size: 45, owner: 'Sam Patel' })
    })
    const added = result.current.deals.at(-1)
    expect(added).toMatchObject({
      company: 'Acme Logistics',
      sector: 'Industrials',
      stage: 'Sourcing',
      size: 45,
      owner: 'Sam Patel',
    })
    expect(added?.id).toMatch(/.+/)
    expect(SEED_DEALS.map((deal) => deal.id)).not.toContain(added?.id)
  })

  it('moves only the target deal', () => {
    const { result } = renderHook(() => useDeals())
    act(() => {
      result.current.moveDeal('seed-1', 'Passed')
    })
    expect(result.current.deals.find((deal) => deal.id === 'seed-1')?.stage).toBe('Passed')
    expect(result.current.deals.filter((deal) => deal.id !== 'seed-1')).toEqual(SEED_DEALS.slice(1))
  })

  it('writes every change back to storage', () => {
    const { result } = renderHook(() => useDeals())
    expect(stored()).toEqual(SEED_DEALS)
    act(() => {
      result.current.addDeal({ company: 'Reload Test Ltd', sector: '', owner: '' })
    })
    expect(stored().at(-1)?.company).toBe('Reload Test Ltd')
    act(() => {
      result.current.moveDeal('seed-2', 'Closed')
    })
    expect(stored().find((deal) => deal.id === 'seed-2')?.stage).toBe('Closed')
  })
})
