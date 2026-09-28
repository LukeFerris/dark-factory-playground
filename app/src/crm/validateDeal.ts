import type { NewDeal } from './types'

/** The deal form's fields as typed, before any checking. */
export interface DealFields {
  company: string
  sector: string
  size: string
  owner: string
}

export interface DealErrors {
  company?: string
  size?: string
}

/** Blank is allowed; anything else must be a number above 0. */
export function parseSize(value: string): number | undefined | null {
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  const size = Number(trimmed)
  return Number.isFinite(size) && size > 0 ? size : null
}

/**
 * The one set of rules for a deal's details, shared by adding and editing so
 * the two forms cannot drift apart.
 */
export function validateDeal(fields: DealFields): { deal: NewDeal } | { errors: DealErrors } {
  const size = parseSize(fields.size)
  const errors: DealErrors = {}
  if (fields.company.trim() === '') errors.company = 'Enter a company name'
  if (size === null) errors.size = 'Enter a size above 0'
  if (errors.company || size === null) return { errors }

  return {
    deal: { company: fields.company.trim(), sector: fields.sector.trim(), size, owner: fields.owner.trim() },
  }
}
