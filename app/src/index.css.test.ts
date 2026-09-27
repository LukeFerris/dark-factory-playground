import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// The rendered colour is not assertable here: vite.config.ts sets `test.css: false`
// and jsdom does not apply an external stylesheet's cascade, so these read the
// source files as text and guard the declarations rather than the paint.

function source(file: string): string {
  return readFileSync(new URL(file, import.meta.url), 'utf8')
}

describe('index.css', () => {
  it('pins the blue background and the black text it was chosen against', () => {
    const css = source('./index.css')
    expect(css).toMatch(/body\s*\{[^}]*background-color:\s*#93c5fd\s*;/)
    expect(css).toMatch(/body\s*\{[^}]*color:\s*#000000\s*;/)
  })

  it('is imported by the app entry point', () => {
    expect(source('./main.tsx')).toMatch(/^import '\.\/index\.css'$/m)
  })
})
