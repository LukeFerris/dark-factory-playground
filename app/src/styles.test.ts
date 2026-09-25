// Vitest runs with `css: false` (see vite.config.ts), so stylesheet rules are
// never applied to the jsdom document and the colour itself cannot be asserted.
// These read the sources as text instead, guarding the two ways the pink can
// silently disappear: the rule being edited away, and the stylesheet dropping
// out of the module graph.
//
// `css: false` also stubs `./index.css?raw` to an empty string, so the
// stylesheet is read from disk; `?raw` is untouched for TypeScript sources.
import { readFileSync } from 'node:fs'
import { cwd } from 'node:process'
import { describe, expect, it } from 'vitest'
import entry from './main.tsx?raw'

// Vitest runs with the app directory as its root, so `src/index.css` resolves
// from the working directory. `import.meta.url` is not a file URL here.
const css = readFileSync(`${cwd()}/src/index.css`, 'utf8')

describe('global stylesheet', () => {
  it('paints the page pink with dark text', () => {
    expect(css).toMatch(/body\s*\{[^}]*background-color:\s*pink\s*;/)
    expect(css).toMatch(/body\s*\{[^}]*\scolor:\s*#1a1a1a\s*;/)
    expect(css).toMatch(/:root\s*\{[^}]*color-scheme:\s*light\s*;/)
  })

  it('is loaded by the entry module', () => {
    expect(entry).toMatch(/^import '\.\/index\.css'$/m)
  })
})
