import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { App } from './App'

/** A fixed date whose local hour is `hour`, so the tests hold in any time zone. */
function localTimeAt(hour: number): Date {
  return new Date(2026, 0, 15, hour, 30, 0)
}

describe('App', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders the morning greeting', () => {
    vi.setSystemTime(localTimeAt(9))
    render(<App />)
    expect(screen.getByRole('heading', { name: 'Dark Factory Playground' })).toBeInTheDocument()
    expect(screen.getByText('Good morning, world')).toBeInTheDocument()
  })

  it('renders the evening greeting', () => {
    vi.setSystemTime(localTimeAt(20))
    render(<App />)
    expect(screen.getByText('Good evening, world')).toBeInTheDocument()
  })

  it('never says "Hello"', () => {
    vi.setSystemTime(localTimeAt(9))
    const { container } = render(<App />)
    expect(container.textContent).not.toContain('Hello')
  })
})
