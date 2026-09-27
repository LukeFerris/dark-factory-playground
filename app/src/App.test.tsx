import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { App } from './App'

function column(stage: string) {
  return within(screen.getByRole('region', { name: stage }))
}

describe('App', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('shows the deal pipeline instead of the greeting', () => {
    render(<App />)
    expect(screen.getByRole('heading', { level: 1, name: 'Deal Pipeline' })).toBeInTheDocument()
    expect(screen.queryByText(/Hello, world/)).not.toBeInTheDocument()
    expect(screen.getByText('4 active deals · £210m in pipeline')).toBeInTheDocument()
  })

  it('adds a deal to Sourcing, then moves it and passes on it', async () => {
    const user = userEvent.setup()
    render(<App />)

    await user.type(screen.getByLabelText('Company'), 'Acme Logistics')
    await user.type(screen.getByLabelText('Sector'), 'Industrials')
    await user.type(screen.getByLabelText('Deal size (£m)'), '45')
    await user.type(screen.getByLabelText('Owner'), 'Sam Patel')
    await user.click(screen.getByRole('button', { name: 'Add deal' }))

    expect(column('Sourcing').getByRole('article', { name: 'Acme Logistics' })).toBeInTheDocument()
    expect(screen.getByText('5 active deals · £255m in pipeline')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Added Acme Logistics to Sourcing')

    const stage = () => screen.getByRole('combobox', { name: 'Stage for Acme Logistics' })
    await user.selectOptions(stage(), 'Due diligence')
    expect(column('Due diligence').getByRole('article', { name: 'Acme Logistics' })).toBeInTheDocument()
    expect(column('Sourcing').queryByRole('article', { name: 'Acme Logistics' })).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Moved Acme Logistics to Due diligence')
    expect(stage()).toHaveFocus()

    await user.selectOptions(stage(), 'Passed')
    expect(column('Passed').getByRole('article', { name: 'Acme Logistics' })).toBeInTheDocument()
    expect(screen.getByText('4 active deals · £210m in pipeline')).toBeInTheDocument()
  })

  it('keeps deals after a reload', async () => {
    const user = userEvent.setup()
    const { unmount } = render(<App />)
    await user.type(screen.getByLabelText('Company'), 'Reload Test Ltd')
    await user.click(screen.getByRole('button', { name: 'Add deal' }))
    unmount()

    render(<App />)
    expect(column('Sourcing').getByRole('article', { name: 'Reload Test Ltd' })).toBeInTheDocument()
  })
})
