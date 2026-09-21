import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { App } from './App'

describe('App', () => {
  it('renders the default greeting', () => {
    render(<App />)
    expect(screen.getByRole('heading', { name: 'Dark Factory Playground' })).toBeInTheDocument()
    expect(screen.getByText('Hello, world')).toBeInTheDocument()
  })
})
