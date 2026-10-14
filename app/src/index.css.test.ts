import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// The rendered colour is not assertable here: vite.config.ts sets `test.css: false`
// and jsdom does not apply an external stylesheet's cascade, so these read the
// source files as text and guard the declarations rather than the paint.

function source(file: string): string {
  return readFileSync(new URL(file, import.meta.url), 'utf8')
}

describe('index.css', () => {
  it('pins the off-white background and the near-black text it was chosen against', () => {
    const css = source('./index.css')
    expect(css).toMatch(/body\s*\{[^}]*background-color:\s*#f7f7f5\s*;/)
    expect(css).toMatch(/body\s*\{[^}]*color:\s*#1c1c1a\s*;/)
  })

  it('shows each column count as a grey pill beside the column name, not at the far end', () => {
    const css = source('./index.css')
    const title = css.match(/\.column__title\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(title).not.toMatch(/justify-content:\s*space-between/)
    expect(title).not.toMatch(/display:\s*flex/)
    const count = css.match(/\.column__count\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(count).toMatch(/display:\s*inline-block\s*;/)
    expect(count).toMatch(/margin-left:\s*8px\s*;/)
    expect(count).toMatch(/background:\s*var\(--pill\)\s*;/)
    expect(count).toMatch(/border:\s*1px solid var\(--pill-edge\)\s*;/)
    expect(count).toMatch(/border-radius:\s*999px\s*;/)
  })

  it('is imported by the app entry point', () => {
    expect(source('./main.tsx')).toMatch(/^import '\.\/index\.css'$/m)
  })
})
