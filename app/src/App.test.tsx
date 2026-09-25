import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { App } from './App'

describe('App', () => {
  it('renders the default greeting', () => {
    render(<App />)
    expect(screen.getByRole('heading', { name: 'Dark Factory Playground' })).toBeInTheDocument()
    expect(screen.getByText('Hello, world')).toBeInTheDocument()
  })

  // index.css centres the page by selecting the `main` element by name, so the
  // layout quietly breaks if this wrapper is ever renamed or removed.
  it('keeps the heading and the greeting inside a single main landmark', () => {
    render(<App />)
    const main = screen.getByRole('main')
    expect(main).toContainElement(screen.getByRole('heading', { name: 'Dark Factory Playground' }))
    expect(main).toContainElement(screen.getByText('Hello, world'))
  })
})
