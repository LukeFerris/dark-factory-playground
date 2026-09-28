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

  it('edits a deal in place and announces it', async () => {
    const user = userEvent.setup()
    render(<App />)
    await user.click(screen.getByRole('button', { name: 'Edit Northwind Analytics' }))
    const form = within(screen.getByRole('form', { name: 'Edit Northwind Analytics' }))
    await user.clear(form.getByLabelText('Company'))
    await user.type(form.getByLabelText('Company'), 'Northwind Data')
    await user.clear(form.getByLabelText('Deal size (£m)'))
    await user.type(form.getByLabelText('Deal size (£m)'), '55')
    await user.click(form.getByRole('button', { name: 'Save' }))

    const card = within(column('Sourcing').getByRole('article', { name: 'Northwind Data' }))
    expect(card.getByText('£55m')).toBeInTheDocument()
    expect(card.getByText('Software')).toBeInTheDocument()
    expect(screen.getByText('4 active deals · £225m in pipeline')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Saved changes to Northwind Data')
  })

  it('keeps the old details when an edit is cancelled', async () => {
    const user = userEvent.setup()
    render(<App />)
    await user.click(screen.getByRole('button', { name: 'Edit Harbour Dental Group' }))
    const form = within(screen.getByRole('form', { name: 'Edit Harbour Dental Group' }))
    await user.clear(form.getByLabelText('Company'))
    await user.type(form.getByLabelText('Company'), 'Something Else')
    await user.click(form.getByRole('button', { name: 'Cancel' }))

    expect(column('Screening').getByRole('article', { name: 'Harbour Dental Group' })).toBeInTheDocument()
    expect(screen.queryByRole('article', { name: 'Something Else' })).not.toBeInTheDocument()
  })

  it('keeps edits after a reload', async () => {
    const user = userEvent.setup()
    const { unmount } = render(<App />)
    await user.click(screen.getByRole('button', { name: 'Edit Meridian Foods' }))
    const form = within(screen.getByRole('form', { name: 'Edit Meridian Foods' }))
    await user.clear(form.getByLabelText('Sector'))
    await user.type(form.getByLabelText('Sector'), 'Food & Drink')
    await user.click(form.getByRole('button', { name: 'Save' }))
    unmount()

    render(<App />)
    const card = within(column('Closed').getByRole('article', { name: 'Meridian Foods' }))
    expect(card.getByText('Food & Drink')).toBeInTheDocument()
  })
})
