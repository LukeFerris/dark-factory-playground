import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './env.ts'

/**
 * The one thing about the walkthrough that cannot be checked at run time.
 *
 * Every spec under `app/e2e` runs into a single evidence directory, and each
 * `uatStep(page, n, …)` writes `step-NN.png` from its own number. Two specs
 * that both number from 1 therefore overwrite each other's screenshots — and
 * the result is indistinguishable from a clean capture, because a gap in the
 * numbering is legitimate (a step nobody can drive in a browser simply has no
 * `uatStep`, and the comment asks the reviewer to take that one). The slide
 * builder cannot tell a collision from a step that was never captured, so the
 * card would carry a numbered walkthrough whose pictures belong to a different
 * flow.
 *
 * Nothing at run time catches it either: the agent's own `npm run e2e` has no
 * `FACTORY_UAT_EVIDENCE`, so it writes no files and collides with nothing. It
 * has to be read off the source, which is what this does.
 */

const E2E_DIR = resolve(REPO_ROOT, 'app/e2e')

/** `uatStep(page, 7, …)` -> 7, per spec file. */
function stepsByFile(): Map<string, number[]> {
  const specs = readdirSync(E2E_DIR).filter((f) => f.endsWith('.spec.ts'))
  const found = new Map<string, number[]>()
  for (const file of specs) {
    const source = readFileSync(resolve(E2E_DIR, file), 'utf8')
    const numbers = [...source.matchAll(/uatStep\(\s*[A-Za-z_$][\w$]*\s*,\s*(\d+)/g)].map((m) =>
      Number(m[1]),
    )
    found.set(file, numbers)
  }
  return found
}

describe('the walkthrough specs', () => {
  it('has at least one numbered step, or nothing is ever proved', () => {
    const all = [...stepsByFile().values()].flat()
    expect(all.length).toBeGreaterThan(0)
  })

  // The failure this file exists for. Kept as a message rather than a bare
  // boolean because whoever trips it is an agent reading test output, and
  // "expected true to be false" does not say what to renumber.
  it('never uses one step number twice, across every spec together', () => {
    const owners = new Map<number, string[]>()
    for (const [file, numbers] of stepsByFile()) {
      for (const n of numbers) owners.set(n, [...(owners.get(n) ?? []), file])
    }
    const clashes = [...owners.entries()]
      .filter(([, files]) => files.length > 1)
      .map(([n, files]) => `step ${n} is claimed by ${files.join(' and ')}`)
    expect(clashes, clashes.join('; ')).toEqual([])
  })

  // Step numbers are the flattened acceptance steps of one card, so they start
  // where that list starts. A spec numbering from 0 shifts every screenshot one
  // place against the comment.
  it('numbers steps from 1 upwards', () => {
    for (const [file, numbers] of stepsByFile()) {
      for (const n of numbers) {
        expect(n, `${file} uses step ${n}`).toBeGreaterThanOrEqual(1)
      }
    }
  })
})
