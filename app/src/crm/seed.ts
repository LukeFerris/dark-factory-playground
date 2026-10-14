import type { Deal } from './types'

/** Fictional sample deals shown on a first visit, one in each stage. */
export const SEED_DEALS: Deal[] = [
  {
    id: 'seed-1',
    company: 'Northwind Analytics',
    sector: 'Software',
    stage: 'Sourcing',
    size: 40,
    owner: 'Priya Shah',
  },
  {
    id: 'seed-2',
    company: 'Harbour Dental Group',
    sector: 'Healthcare',
    stage: 'Screening',
    size: 25,
    owner: 'Tom Okafor',
  },
  {
    id: 'seed-3',
    company: 'Brightline Packaging',
    sector: 'Industrials',
    stage: 'Due diligence',
    size: 60,
    owner: 'Priya Shah',
  },
  {
    id: 'seed-4',
    company: 'Kestrel Energy Services',
    sector: 'Energy',
    stage: 'Investment committee',
    size: 85,
    owner: 'Elena Rossi',
  },
  {
    id: 'seed-5',
    company: 'Meridian Foods',
    sector: 'Consumer',
    stage: 'Closed',
    size: 120,
    owner: 'Tom Okafor',
  },
  {
    id: 'seed-6',
    company: 'Atlas Freight Tech',
    sector: 'Logistics',
    stage: 'Passed',
    size: 30,
    owner: 'Elena Rossi',
  },
]
