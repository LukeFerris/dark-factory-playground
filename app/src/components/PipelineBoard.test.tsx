import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PipelineBoard } from './PipelineBoard'
import { SEED_DEALS } from '../crm/seed'
import { STAGES, type Deal } from '../crm/types'

const deals: Deal[] = [
  {
    id: 'a',
    company: 'Acme Logistics',
    sector: 'Industrials',
    stage: 'Sourcing',
    size: 45,
    owner: 'Sam Patel',
  },
  {
    id: 'b',
    company: 'Beta Health',
    sector: 'Healthcare',
    stage: 'Sourcing',
    size: 12.5,
    owner: 'Jo Lee',
  },
  { id: 'c', company: 'Gamma Retail', sector: '', stage: 'Closed', owner: '' },
]

// jsdom has no DataTransfer, so drag events carry a stub the handlers can write to.
function dataTransfer() {
  return { setData: vi.fn(), effectAllowed: '', dropEffect: '' }
}

// Nor DragEvent, so fireEvent.dragLeave falls back to a plain Event and loses
// relatedTarget. A MouseEvent carries it, and React handles it by its type.
function dragLeave(element: Element, relatedTarget: Element) {
  fireEvent(element, new MouseEvent('dragleave', { bubbles: true, relatedTarget }))
}

function column(stage: string) {
  return screen.getByRole('region', { name: stage })
}

function highlighted() {
  return screen
    .getAllByRole('region')
    .filter((section) => section.classList.contains('column--drop-target'))
}

describe('PipelineBoard', () => {
  it('renders the six stages in order with their counts', () => {
    render(<PipelineBoard deals={deals} onMove={vi.fn()} onUpdate={vi.fn()} />)
    expect(
      screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent),
    ).toEqual([
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
    expect(
      within(screen.getByRole('region', { name: 'Screening' })).getByText('No deals'),
    ).toBeInTheDocument()
    expect(
      within(screen.getByRole('region', { name: 'Sourcing' })).queryByText('No deals'),
    ).not.toBeInTheDocument()
  })

  it("offers every stage in each card's stage picker", () => {
    render(<PipelineBoard deals={SEED_DEALS} onMove={vi.fn()} onUpdate={vi.fn()} />)
    const select = screen.getByRole('combobox', { name: 'Stage for Northwind Analytics' })
    expect(
      within(select)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual([...STAGES])
    expect(select).toHaveValue('Sourcing')
  })

  it('calls onMove with the deal and the chosen stage', async () => {
    const onMove = vi.fn()
    const user = userEvent.setup()
    render(<PipelineBoard deals={deals} onMove={onMove} onUpdate={vi.fn()} />)
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Stage for Beta Health' }),
      'Due diligence',
    )
    expect(onMove).toHaveBeenCalledWith('b', 'Due diligence')
  })

  it('gives each card an Edit button named for its deal', () => {
    render(<PipelineBoard deals={deals} onMove={vi.fn()} onUpdate={vi.fn()} />)
    expect(
      screen.getAllByRole('button', { name: /^Edit / }).map((button) => button.textContent),
    ).toEqual(['Edit Acme Logistics', 'Edit Beta Health', 'Edit Gamma Retail'])
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

    expect(onUpdate).toHaveBeenCalledWith('b', {
      company: 'Beta Health',
      sector: 'Healthcare',
      size: 12.5,
      owner: 'Ann Wu',
    })
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

  describe('drag and drop', () => {
    it('makes every card draggable except one whose edit form is open', async () => {
      const user = userEvent.setup()
      render(<PipelineBoard deals={deals} onMove={vi.fn()} onUpdate={vi.fn()} />)
      await user.click(screen.getByRole('button', { name: 'Edit Beta Health' }))
      expect(screen.getByRole('article', { name: 'Acme Logistics' })).toHaveAttribute(
        'draggable',
        'true',
      )
      expect(screen.getByRole('article', { name: 'Gamma Retail' })).toHaveAttribute(
        'draggable',
        'true',
      )
      expect(screen.getByRole('article', { name: 'Beta Health' })).not.toHaveAttribute(
        'draggable',
        'true',
      )
    })

    it('marks the drag as a move and gives it data, so every browser starts it', () => {
      render(<PipelineBoard deals={deals} onMove={vi.fn()} onUpdate={vi.fn()} />)
      const transfer = dataTransfer()
      fireEvent.dragStart(screen.getByRole('article', { name: 'Beta Health' }), {
        dataTransfer: transfer,
      })
      expect(transfer.setData).toHaveBeenCalledWith('text/plain', 'b')
      expect(transfer.effectAllowed).toBe('move')
    })

    it('moves a card dropped on another column', () => {
      const onMove = vi.fn()
      render(<PipelineBoard deals={deals} onMove={onMove} onUpdate={vi.fn()} />)
      fireEvent.dragStart(screen.getByRole('article', { name: 'Beta Health' }), {
        dataTransfer: dataTransfer(),
      })
      const transfer = dataTransfer()
      expect(fireEvent.dragOver(column('Screening'), { dataTransfer: transfer })).toBe(false)
      expect(transfer.dropEffect).toBe('move')
      fireEvent.drop(column('Screening'), { dataTransfer: dataTransfer() })
      expect(onMove).toHaveBeenCalledTimes(1)
      expect(onMove).toHaveBeenCalledWith('b', 'Screening')
    })

    it('does nothing when a card is dropped on its own column', () => {
      const onMove = vi.fn()
      render(<PipelineBoard deals={deals} onMove={onMove} onUpdate={vi.fn()} />)
      fireEvent.dragStart(screen.getByRole('article', { name: 'Beta Health' }), {
        dataTransfer: dataTransfer(),
      })
      expect(fireEvent.dragOver(column('Sourcing'), { dataTransfer: dataTransfer() })).toBe(true)
      expect(highlighted()).toEqual([])
      fireEvent.drop(column('Sourcing'), { dataTransfer: dataTransfer() })
      expect(onMove).not.toHaveBeenCalled()
    })

    it('ignores drags that did not start on a card', () => {
      const onMove = vi.fn()
      render(<PipelineBoard deals={deals} onMove={onMove} onUpdate={vi.fn()} />)
      expect(fireEvent.dragOver(column('Screening'), { dataTransfer: dataTransfer() })).toBe(true)
      expect(highlighted()).toEqual([])
      fireEvent.drop(column('Screening'), { dataTransfer: dataTransfer() })
      expect(onMove).not.toHaveBeenCalled()
    })

    it('moves nothing when a drag ends without a drop', () => {
      const onMove = vi.fn()
      render(<PipelineBoard deals={deals} onMove={onMove} onUpdate={vi.fn()} />)
      const card = screen.getByRole('article', { name: 'Beta Health' })
      fireEvent.dragStart(card, { dataTransfer: dataTransfer() })
      fireEvent.dragEnd(card, { dataTransfer: dataTransfer() })
      fireEvent.drop(column('Screening'), { dataTransfer: dataTransfer() })
      expect(onMove).not.toHaveBeenCalled()
    })

    it('highlights only the column under the card', () => {
      render(<PipelineBoard deals={deals} onMove={vi.fn()} onUpdate={vi.fn()} />)
      fireEvent.dragStart(screen.getByRole('article', { name: 'Beta Health' }), {
        dataTransfer: dataTransfer(),
      })
      fireEvent.dragOver(column('Screening'), { dataTransfer: dataTransfer() })
      expect(highlighted()).toEqual([column('Screening')])
      fireEvent.dragOver(column('Closed'), { dataTransfer: dataTransfer() })
      expect(highlighted()).toEqual([column('Closed')])
    })

    it('keeps the highlight while moving over a card inside the column', () => {
      render(<PipelineBoard deals={deals} onMove={vi.fn()} onUpdate={vi.fn()} />)
      fireEvent.dragStart(screen.getByRole('article', { name: 'Beta Health' }), {
        dataTransfer: dataTransfer(),
      })
      fireEvent.dragOver(column('Closed'), { dataTransfer: dataTransfer() })
      dragLeave(column('Closed'), screen.getByRole('article', { name: 'Gamma Retail' }))
      expect(highlighted()).toEqual([column('Closed')])
    })

    it('clears the highlight when the card leaves the column', () => {
      render(<PipelineBoard deals={deals} onMove={vi.fn()} onUpdate={vi.fn()} />)
      fireEvent.dragStart(screen.getByRole('article', { name: 'Beta Health' }), {
        dataTransfer: dataTransfer(),
      })
      fireEvent.dragOver(column('Screening'), { dataTransfer: dataTransfer() })
      dragLeave(column('Screening'), document.body)
      expect(highlighted()).toEqual([])
    })

    it('clears the highlight after a drop', () => {
      render(<PipelineBoard deals={deals} onMove={vi.fn()} onUpdate={vi.fn()} />)
      fireEvent.dragStart(screen.getByRole('article', { name: 'Beta Health' }), {
        dataTransfer: dataTransfer(),
      })
      fireEvent.dragOver(column('Screening'), { dataTransfer: dataTransfer() })
      fireEvent.drop(column('Screening'), { dataTransfer: dataTransfer() })
      expect(highlighted()).toEqual([])
    })

    it('clears the highlight when the drag ends', () => {
      render(<PipelineBoard deals={deals} onMove={vi.fn()} onUpdate={vi.fn()} />)
      const card = screen.getByRole('article', { name: 'Beta Health' })
      fireEvent.dragStart(card, { dataTransfer: dataTransfer() })
      fireEvent.dragOver(column('Screening'), { dataTransfer: dataTransfer() })
      fireEvent.dragEnd(card, { dataTransfer: dataTransfer() })
      expect(highlighted()).toEqual([])
    })

    it('does not move focus to the moved card after a drop', () => {
      const moved = deals.map((deal) =>
        deal.id === 'b' ? { ...deal, stage: 'Screening' as const } : deal,
      )
      const { rerender } = render(
        <PipelineBoard deals={deals} onMove={vi.fn()} onUpdate={vi.fn()} />,
      )
      fireEvent.dragStart(screen.getByRole('article', { name: 'Beta Health' }), {
        dataTransfer: dataTransfer(),
      })
      fireEvent.dragOver(column('Screening'), { dataTransfer: dataTransfer() })
      fireEvent.drop(column('Screening'), { dataTransfer: dataTransfer() })
      rerender(<PipelineBoard deals={moved} onMove={vi.fn()} onUpdate={vi.fn()} />)
      expect(screen.getByRole('combobox', { name: 'Stage for Beta Health' })).not.toHaveFocus()
      expect(document.body).toHaveFocus()
    })
  })
})
