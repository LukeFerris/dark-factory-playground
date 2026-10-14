import { existsSync, readFileSync } from 'node:fs'
import { z } from 'zod'
import type { Stage } from './schema.ts'
import { configPath } from './statuses.ts'

/**
 * What each stage may write, and what no stage may.
 *
 * Validation fails a turn that touches anything outside its stage's allow
 * list. Each pattern is a glob relative to the repo root; see `matchesGlob` in
 * validate.ts for the syntax. A path must be matched by the allow list *and* by
 * nothing on the deny list.
 *
 * The lists depend on how the repository is laid out, so a repository can set
 * its own in `enki.json`:
 *
 *   { "paths": { "design": ["docs/design/**"], "build": ["src/**"], "denied": ["vite.config.ts"] } }
 *
 * `design` and `build` replace the defaults below outright; `denied` replaces
 * the repository's own deny list. None of it touches `CORE_DENIED`, which is
 * the factory guarding itself and is not a repository's to relax. Without a
 * `paths` key, as in this repository, the defaults apply.
 */

/** Never writable by any stage, in any repository, whatever `enki.json` says. */
export const CORE_DENIED: readonly string[] = [
  '.github/**',
  '.agent/**',
  'factory/**',
  'bootstrap/**',
  // Pins the board's status ids and these very lists. An agent that rewrote it
  // could send cards to statuses the locks don't cover, or widen its own scope.
  'enki.json',
]

export interface Paths {
  design: readonly string[]
  build: readonly string[]
  /** The repository's own deny list, on top of `CORE_DENIED`. */
  denied: readonly string[]
}

/**
 * The deny list on top of `CORE_DENIED` is not strictly necessary — anything
 * not on an allow list is already rejected — but it is spelled out so the
 * intent is legible to a human reading the file, and so a careless widening of
 * an allow list still trips over it.
 */
export const DEFAULT_PATHS: Paths = {
  design: ['docs/design/**', 'docs/adr/**'],
  build: [
    'app/src/**',
    'app/public/**',
    // The walkthrough the reviewer is handed is written here, by the same turn
    // that writes the feature: a build agent that changes what the app does
    // changes the spec that proves it, or the evidence stops matching the card.
    'app/e2e/**',
    'app/index.html',
    'app/package.json',
    'package-lock.json',
    'docs/design/*/build-log.md',
    '.preview/env.yaml',
  ],
  denied: [
    'package.json',
    'tsconfig*.json',
    'app/tsconfig.json',
    'app/eslint.config.js',
    'app/vite.config.ts',
    // The agent writes the walkthrough but not the terms it is captured under.
    // Viewport, base URL and whether screenshots are taken at all decide what
    // the evidence shows, so they are the reviewer's guarantee, not the agent's
    // to relax when a step will not go green.
    'app/playwright.config.ts',
  ],
}

const Globs = z.array(
  z
    .string()
    .min(1)
    .refine((g) => !g.startsWith('/'), 'a path is relative to the repo root'),
)

const ConfigSchema = z
  .object({
    paths: z
      .object({
        design: Globs.min(1),
        build: Globs.min(1),
        denied: Globs.default([]),
      })
      .strict()
      .optional(),
  })
  .passthrough()

/**
 * The lists from `file`: its `paths`, or the defaults when it has none.
 *
 * A file that has `paths` but gets them wrong is refused rather than patched
 * with defaults. Half of one repository's lists and half of another's would
 * allow paths nobody chose.
 */
export function readPaths(file: string = configPath()): Paths {
  if (!existsSync(file)) return DEFAULT_PATHS
  const parsed = ConfigSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')))
  if (!parsed.success) {
    throw new Error(
      `${file}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    )
  }
  return parsed.data.paths ?? DEFAULT_PATHS
}

let cached: Paths | undefined

function paths(): Paths {
  if (cached === undefined) cached = readPaths()
  return cached
}

/** Forgets what was read, so a test can point `ENKI_CONFIG` somewhere else. */
export function resetPaths(): void {
  cached = undefined
}

/** The globs `stage` may write. */
export function allowedPaths(stage: Stage): readonly string[] {
  return paths()[stage]
}

/** The globs no stage may write: the factory's own, then the repository's. */
export function deniedPaths(): readonly string[] {
  return [...CORE_DENIED, ...paths().denied]
}
