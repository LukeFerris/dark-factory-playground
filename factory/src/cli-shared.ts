import { Stage } from './schema.ts'

/**
 * Exit codes are part of the contract with the workflows:
 *   0 ok · 1 unexpected · 2 Jira auth · 3 no such transition · 4 validation failed
 *   5 the merge from main could not be resolved
 */
export const EXIT = { OK: 0, ERROR: 1, AUTH: 2, TRANSITION: 3, VALIDATION: 4, MERGE: 5 } as const

export function parseStage(value: string): Stage {
  const parsed = Stage.safeParse(value)
  if (!parsed.success) throw new Error(`--stage must be "design" or "build", got "${value}"`)
  return parsed.data
}

/** Commander's parser for a numeric argument or option, e.g. a PR number. */
export function parseNumber(value: string): number {
  return Number.parseInt(value, 10)
}
