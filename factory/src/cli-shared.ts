import { Stage } from './schema.ts'

/**
 * Exit codes are part of the contract with the workflows:
 *   0 ok · 1 unexpected · 2 Jira auth · 3 no such transition · 4 validation failed
 *   5 the merge from main could not be resolved · 6 no preview slot is free
 */
export const EXIT = {
  OK: 0,
  ERROR: 1,
  AUTH: 2,
  TRANSITION: 3,
  VALIDATION: 4,
  MERGE: 5,
  NO_SLOT: 6,
} as const

export function parseStage(value: string): Stage {
  const parsed = Stage.safeParse(value)
  if (!parsed.success) throw new Error(`--stage must be "design" or "build", got "${value}"`)
  return parsed.data
}

/** Commander's parser for a numeric argument or option, e.g. a PR number. */
export function parseNumber(value: string): number {
  return Number.parseInt(value, 10)
}

/** Commander's parser for `--retry`: how many automatic turns came before. */
export function parseRetry(value: string): number {
  const n = Number.parseInt(value, 10)
  if (!Number.isInteger(n) || n < 0)
    throw new Error(`--retry must be a whole number, got "${value}"`)
  return n
}
