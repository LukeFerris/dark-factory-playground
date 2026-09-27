import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Hello } from './Hello'

/** A fixed date whose local hour is `hour`, so the tests hold in any time zone. */
function localTimeAt(hour: number): Date {
  return new Date(2026, 0, 15, hour, 30, 0)
}

describe('Hello', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('greets the name it is given in the morning', () => {
    vi.setSystemTime(localTimeAt(9))
    render(<Hello name="Ada" />)
    expect(screen.getByText('Good morning, Ada')).toBeInTheDocument()
  })

  it('greets the name it is given in the afternoon', () => {
    vi.setSystemTime(localTimeAt(14))
    render(<Hello name="Ada" />)
    expect(screen.getByText('Good afternoon, Ada')).toBeInTheDocument()
  })

  it('greets the name it is given in the evening', () => {
    vi.setSystemTime(localTimeAt(20))
    render(<Hello name="Ada" />)
    expect(screen.getByText('Good evening, Ada')).toBeInTheDocument()
  })

  it('falls back to "world" when the name is blank', () => {
    vi.setSystemTime(localTimeAt(9))
    render(<Hello name="   " />)
    expect(screen.getByText('Good morning, world')).toBeInTheDocument()
  })
})
