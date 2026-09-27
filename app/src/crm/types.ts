export const STAGES = [
  'Sourcing',
  'Screening',
  'Due diligence',
  'Investment committee',
  'Closed',
  'Passed',
] as const

export type Stage = (typeof STAGES)[number]

/** Stages that no longer count towards the active pipeline. */
export const TERMINAL_STAGES: readonly Stage[] = ['Closed', 'Passed']

export interface Deal {
  id: string
  company: string
  sector: string
  stage: Stage
  /** Deal size in £m. Absent when not known. */
  size?: number
  owner: string
}

/** What the "Add deal" form hands over; the id and stage are assigned on add. */
export type NewDeal = Omit<Deal, 'id' | 'stage'>

export function isActive(deal: Deal): boolean {
  return !TERMINAL_STAGES.includes(deal.stage)
}

/** Formats a size in £m, e.g. 45 → "£45m", 12.5 → "£12.5m". */
export function formatSize(size: number): string {
  return `£${Math.round(size * 100) / 100}m`
}
