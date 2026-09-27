const FALLBACK_NAME = 'world'

/**
 * Picks the greeting for a local hour, 0–23.
 *
 * Morning runs 05:00–11:59 and afternoon 12:00–17:59; the evening takes
 * everything else, running through midnight to 04:59, because greeting someone
 * browsing at 2am with "Good morning" reads as a bug. There is deliberately no
 * fourth "Good night" period.
 */
export function greetingPrefix(hour: number): string {
  if (hour >= 5 && hour < 12) return 'Good morning'
  if (hour >= 12 && hour < 18) return 'Good afternoon'
  return 'Good evening'
}

/**
 * Builds the greeting shown by `<Hello />`.
 *
 * The period is read from the visitor's own clock, once, as the page renders —
 * so a page left open across a boundary keeps its greeting until it is
 * reloaded.
 *
 * Blank or whitespace-only names fall back to "world" so the greeting is never
 * left dangling mid-sentence while someone is clearing the input.
 */
export function useGreeting(name: string): string {
  const trimmed = name.trim()
  const who = trimmed === '' ? FALLBACK_NAME : trimmed
  return `${greetingPrefix(new Date().getHours())}, ${who}`
}
