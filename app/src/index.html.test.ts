import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// jsdom never loads index.html, so this reads it as text, the way
// index.css.test.ts reads the stylesheet. The path is joined rather than
// written as `new URL('../index.html', import.meta.url)`, which Vite rewrites
// into an asset URL.

const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'index.html'), 'utf8')

describe('index.html', () => {
  it('titles the tab with the app name', () => {
    expect(html).toContain('<title>Deal CRM</title>')
    expect(html).not.toContain('Deal Pipeline')
  })
})
