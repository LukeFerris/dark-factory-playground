import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { App } from './App'
import { STAGES } from './crm/types'

function column(stage: string) {
  return within(screen.getByRole('region', { name: stage }))
}

// A column's heading is its name followed by its count, e.g. "Sourcing1".
// Takes one count per column, in STAGES order.
function expectCounts(...expected: number[]) {
  const headings = STAGES.map((stage) => column(stage).getByRole('heading', { level: 2 }).textContent)
  expect(headings).toEqual(STAGES.map((stage, index) => `${stage}${expected[index]}`))
}

function dragHarbourDentalToPassed() {
  // jsdom has no DataTransfer; the handlers only write to it.
  const dataTransfer = { setData: () => undefined, effectAllowed: '', dropEffect: '' }
  const passed = screen.getByRole('region', { name: 'Passed' })
  fireEvent.dragStart(
    column('Screening').getByRole('article', { name: 'Harbour Dental Group' }),
    { dataTransfer },
  )
  fireEvent.dragOver(passed, { dataTransfer })
  fireEvent.drop(passed, { dataTransfer })
}

beforeEach(() => {
  localStorage.clear()
})

describe('App', () => {
  it('shows the deal pipeline instead of the greeting', () => {
    render(<App />)
    const heading = screen.getByRole('heading', { level: 1, name: 'Deal CRM!' })
    expect(heading).toHaveTextContent(/^Deal CRM!$/)
    const icon = heading.querySelector('svg')
    expect(icon).toHaveAttribute('aria-hidden', 'true')
    expect(heading.firstChild).toBe(icon)
    expect(screen.queryByText(/Deal Pipeline/)).not.toBeInTheDocument()
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
    expect(
      column('Due diligence').getByRole('article', { name: 'Acme Logistics' }),
    ).toBeInTheDocument()
    expect(
      column('Sourcing').queryByRole('article', { name: 'Acme Logistics' }),
    ).not.toBeInTheDocument()
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

describe('App editing', () => {
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

    expect(
      column('Screening').getByRole('article', { name: 'Harbour Dental Group' }),
    ).toBeInTheDocument()
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

describe('App dragging', () => {
  it('moves a deal dropped on another column, announces it and keeps it after a reload', () => {
    const { unmount } = render(<App />)
    dragHarbourDentalToPassed()

    expect(
      column('Passed').getByRole('article', { name: 'Harbour Dental Group' }),
    ).toBeInTheDocument()
    expect(column('Screening').getByText('No deals')).toBeInTheDocument()
    expect(screen.getByText('3 active deals · £185m in pipeline')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Moved Harbour Dental Group to Passed')
    unmount()

    render(<App />)
    expect(
      column('Passed').getByRole('article', { name: 'Harbour Dental Group' }),
    ).toBeInTheDocument()
  })
})

describe('App column counts', () => {
  it('shows one deal in every column on a first visit', () => {
    render(<App />)
    expectCounts(1, 1, 1, 1, 1, 1)
  })

  it('counts a deal added to Sourcing straight away, and nothing else', async () => {
    const user = userEvent.setup()
    render(<App />)
    await user.type(screen.getByLabelText('Company'), 'Acme Logistics')
    await user.click(screen.getByRole('button', { name: 'Add deal' }))

    expectCounts(2, 1, 1, 1, 1, 1)
  })

  it('moves the count with a deal moved by its stage picker, and shows 0 for the emptied column', async () => {
    const user = userEvent.setup()
    render(<App />)
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Stage for Harbour Dental Group' }),
      'Due diligence',
    )

    expectCounts(1, 0, 2, 1, 1, 1)
    expect(column('Screening').getByText('No deals')).toBeInTheDocument()
  })

  it('moves the count with a deal passed on', async () => {
    const user = userEvent.setup()
    render(<App />)
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Stage for Kestrel Energy Services' }),
      'Passed',
    )

    expectCounts(1, 1, 1, 0, 1, 2)
  })

  it('moves the count with a deal dropped on another column', () => {
    render(<App />)
    dragHarbourDentalToPassed()

    expectCounts(1, 0, 1, 1, 1, 2)
    expect(column('Screening').getByText('No deals')).toBeInTheDocument()
  })
})
