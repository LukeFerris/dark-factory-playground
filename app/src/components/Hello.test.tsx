import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Hello } from './Hello'

describe('Hello', () => {
  it('greets the name it is given', () => {
    render(<Hello name="Ada" />)
    expect(screen.getByText('Hello, Ada')).toBeInTheDocument()
  })

  it('falls back to "world" when the name is blank', () => {
    render(<Hello name="   " />)
    expect(screen.getByText('Hello, world')).toBeInTheDocument()
  })
})
