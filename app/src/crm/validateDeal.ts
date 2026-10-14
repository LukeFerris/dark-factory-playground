import type { NewDeal } from './types'

/** The deal form's fields as typed, before any checking. */
export interface DealFields {
  company: string
  sector: string
  employees: string
  size: string
  owner: string
}

export interface DealErrors {
  company?: string
  employees?: string
  size?: string
}

/** Blank is allowed; anything else must be a number above 0. */
export function parseSize(value: string): number | undefined | null {
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  const size = Number(trimmed)
  return Number.isFinite(size) && size > 0 ? size : null
}

/** Blank is allowed; anything else must be a whole number of 1 or more, commas allowed. */
export function parseEmployees(value: string): number | undefined | null {
  const digits = value.trim().replaceAll(',', '')
  if (digits === '') return undefined
  if (!/^\d+$/.test(digits)) return null
  const employees = Number(digits)
  return Number.isInteger(employees) && employees >= 1 ? employees : null
}

/**
 * The one set of rules for a deal's details, shared by adding and editing so
 * the two forms cannot drift apart.
 */
export function validateDeal(fields: DealFields): { deal: NewDeal } | { errors: DealErrors } {
  const employees = parseEmployees(fields.employees)
  const size = parseSize(fields.size)
  const errors: DealErrors = {}
  if (fields.company.trim() === '') errors.company = 'Enter a company name'
  if (employees === null) errors.employees = 'Enter a whole number above 0'
  if (size === null) errors.size = 'Enter a size above 0'
  if (errors.company || employees === null || size === null) return { errors }

  return {
    deal: {
      company: fields.company.trim(),
      sector: fields.sector.trim(),
      employees,
      size,
      owner: fields.owner.trim(),
    },
  }
}
