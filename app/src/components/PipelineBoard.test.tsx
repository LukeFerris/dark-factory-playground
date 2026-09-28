import { describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PipelineBoard } from './PipelineBoard'
import { SEED_DEALS } from '../crm/seed'
import { STAGES, type Deal } from '../crm/types'

const deals: Deal[] = [
  { id: 'a', company: 'Acme Logistics', sector: 'Industrials', stage: 'Sourcing', size: 45, owner: 'Sam Patel' },
  { id: 'b', company: 'Beta Health', sector: 'Healthcare', stage: 'Sourcing', size: 12.5, owner: 'Jo Lee' },
  { id: 'c', company: 'Gamma Retail', sector: '', stage: 'Closed', owner: '' },
]

describe('PipelineBoard', () => {
  it('renders the six stages in order with their counts', () => {
    render(<PipelineBoard deals={deals} onMove={vi.fn()} onUpdate={vi.fn()} />)
    expect(screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent)).toEqual([
      'Sourcing2',
      'Screening0',
      'Due diligence0',
      'Investment committee0',
      'Closed1',
      'Passed0',
    ])
  })

  it('places each deal under its stage with its details', () => {
    render(<PipelineBoard deals={deals} onMove={vi.fn()} onUpdate={vi.fn()} />)
    const sourcing = within(screen.getByRole('region', { name: 'Sourcing' }))
    const acme = within(sourcing.getByRole('article', { name: 'Acme Logistics' }))
    expect(acme.getByText('Industrials')).toBeInTheDocument()
    expect(acme.getByText('£45m')).toBeInTheDocument()
    expect(acme.getByText('Sam Patel')).toBeInTheDocument()
    expect(sourcing.getByText('£12.5m')).toBeInTheDocument()

    const closed = within(screen.getByRole('region', { name: 'Closed' }))
    expect(closed.getByRole('article', { name: 'Gamma Retail' })).toBeInTheDocument()
    expect(closed.queryByText(/£/)).not.toBeInTheDocument()
  })

  it('says an empty stage has no deals', () => {
    render(<PipelineBoard deals={deals} onMove={vi.fn()} onUpdate={vi.fn()} />)
    expect(within(screen.getByRole('region', { name: 'Screening' })).getByText('No deals')).toBeInTheDocument()
    expect(within(screen.getByRole('region', { name: 'Sourcing' })).queryByText('No deals')).not.toBeInTheDocument()
  })

  it('offers every stage in each card\'s stage picker', () => {
    render(<PipelineBoard deals={SEED_DEALS} onMove={vi.fn()} onUpdate={vi.fn()} />)
    const select = screen.getByRole('combobox', { name: 'Stage for Northwind Analytics' })
    expect(within(select).getAllByRole('option').map((option) => option.textContent)).toEqual([...STAGES])
    expect(select).toHaveValue('Sourcing')
  })

  it('calls onMove with the deal and the chosen stage', async () => {
    const onMove = vi.fn()
    const user = userEvent.setup()
    render(<PipelineBoard deals={deals} onMove={onMove} onUpdate={vi.fn()} />)
    await user.selectOptions(screen.getByRole('combobox', { name: 'Stage for Beta Health' }), 'Due diligence')
    expect(onMove).toHaveBeenCalledWith('b', 'Due diligence')
  })

  it('gives each card an Edit button named for its deal', () => {
    render(<PipelineBoard deals={deals} onMove={vi.fn()} onUpdate={vi.fn()} />)
    expect(screen.getAllByRole('button', { name: /^Edit / }).map((button) => button.textContent)).toEqual([
      'Edit Acme Logistics',
      'Edit Beta Health',
      'Edit Gamma Retail',
    ])
  })

  it('opens the form on that card only', async () => {
    const user = userEvent.setup()
    render(<PipelineBoard deals={deals} onMove={vi.fn()} onUpdate={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: 'Edit Beta Health' }))
    const card = within(screen.getByRole('article', { name: 'Beta Health' }))
    expect(card.getByRole('form', { name: 'Edit Beta Health' })).toBeInTheDocument()
    expect(card.queryByRole('combobox')).not.toBeInTheDocument()
    expect(screen.getAllByRole('form')).toHaveLength(1)
    expect(screen.getByRole('combobox', { name: 'Stage for Acme Logistics' })).toBeInTheDocument()
  })

  it('saves through onUpdate, closes the form and returns focus to Edit', async () => {
    const onUpdate = vi.fn()
    const user = userEvent.setup()
    render(<PipelineBoard deals={deals} onMove={vi.fn()} onUpdate={onUpdate} />)
    await user.click(screen.getByRole('button', { name: 'Edit Beta Health' }))
    const form = within(screen.getByRole('form', { name: 'Edit Beta Health' }))
    await user.clear(form.getByLabelText('Owner'))
    await user.type(form.getByLabelText('Owner'), 'Ann Wu')
    await user.click(form.getByRole('button', { name: 'Save' }))

    expect(onUpdate).toHaveBeenCalledWith('b', { company: 'Beta Health', sector: 'Healthcare', size: 12.5, owner: 'Ann Wu' })
    expect(screen.queryByRole('form')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Edit Beta Health' })).toHaveFocus()
  })

  it('cancels without calling onUpdate and returns focus to Edit', async () => {
    const onUpdate = vi.fn()
    const user = userEvent.setup()
    render(<PipelineBoard deals={deals} onMove={vi.fn()} onUpdate={onUpdate} />)
    await user.click(screen.getByRole('button', { name: 'Edit Acme Logistics' }))
    await user.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(onUpdate).not.toHaveBeenCalled()
    expect(screen.queryByRole('form')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Edit Acme Logistics' })).toHaveFocus()
  })
})
