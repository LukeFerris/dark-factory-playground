const FALLBACK_NAME = 'world'

/**
 * Builds the greeting shown by `<Hello />`.
 *
 * Blank or whitespace-only names fall back to "world" so the greeting is never
 * left dangling mid-sentence while someone is clearing the input.
 */
export function useGreeting(name: string): string {
  const trimmed = name.trim()
  return `Hello, ${trimmed === '' ? FALLBACK_NAME : trimmed}`
}
