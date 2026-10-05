import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, screen } from '@testing-library/react'

// main.tsx does its work on import, so each test imports a fresh copy against
// whatever page it has set up.
async function loadEntryPoint() {
  vi.resetModules()
  await act(async () => {
    await import('./main')
  })
}

describe('main', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('mounts the app into #root', async () => {
    const root = document.createElement('div')
    root.id = 'root'
    document.body.append(root)

    await loadEntryPoint()

    expect(screen.getByRole('heading', { level: 1, name: 'Deal CRM!' })).toBeInTheDocument()
    expect(root).toContainElement(screen.getByRole('main'))
  })

  it('says so when the page has no #root', async () => {
    await expect(loadEntryPoint()).rejects.toThrow('Root element #root is missing from index.html')
  })
})
