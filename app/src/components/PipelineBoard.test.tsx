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
    render(<PipelineBoard deals={deals} onMove={vi.fn()} />)
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
    render(<PipelineBoard deals={deals} onMove={vi.fn()} />)
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
    render(<PipelineBoard deals={deals} onMove={vi.fn()} />)
    expect(within(screen.getByRole('region', { name: 'Screening' })).getByText('No deals')).toBeInTheDocument()
    expect(within(screen.getByRole('region', { name: 'Sourcing' })).queryByText('No deals')).not.toBeInTheDocument()
  })

  it('offers every stage in each card\'s stage picker', () => {
    render(<PipelineBoard deals={SEED_DEALS} onMove={vi.fn()} />)
    const select = screen.getByRole('combobox', { name: 'Stage for Northwind Analytics' })
    expect(within(select).getAllByRole('option').map((option) => option.textContent)).toEqual([...STAGES])
    expect(select).toHaveValue('Sourcing')
  })

  it('calls onMove with the deal and the chosen stage', async () => {
    const onMove = vi.fn()
    const user = userEvent.setup()
    render(<PipelineBoard deals={deals} onMove={onMove} />)
    await user.selectOptions(screen.getByRole('combobox', { name: 'Stage for Beta Health' }), 'Due diligence')
    expect(onMove).toHaveBeenCalledWith('b', 'Due diligence')
  })
})
