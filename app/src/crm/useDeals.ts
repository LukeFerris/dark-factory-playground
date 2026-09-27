import { useCallback, useEffect, useState } from 'react'
import { SEED_DEALS } from './seed'
import type { Deal, NewDeal, Stage } from './types'

export const STORAGE_KEY = 'df-crm.deals.v1'

/**
 * Reads the saved deals. An absent key means a first visit, so the board is
 * seeded; a value that is not a JSON list also falls back to the seed rather
 * than leaving the app unable to render.
 */
function loadDeals(): Deal[] {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (raw === null) return SEED_DEALS
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as Deal[]) : SEED_DEALS
  } catch {
    return SEED_DEALS
  }
}

/** Owns the deal list and keeps `localStorage` in step with it. */
export function useDeals() {
  const [deals, setDeals] = useState<Deal[]>(loadDeals)

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(deals))
  }, [deals])

  const addDeal = useCallback((deal: NewDeal) => {
    setDeals((current) => [
      ...current,
      { ...deal, id: crypto.randomUUID(), company: deal.company.trim(), stage: 'Sourcing' },
    ])
  }, [])

  const moveDeal = useCallback((id: string, stage: Stage) => {
    setDeals((current) => current.map((deal) => (deal.id === id ? { ...deal, stage } : deal)))
  }, [])

  return { deals, addDeal, moveDeal }
}
