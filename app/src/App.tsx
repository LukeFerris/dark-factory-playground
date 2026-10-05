import { useState } from 'react'
import { AddDealForm } from './components/AddDealForm'
import { PipelineBoard } from './components/PipelineBoard'
import { PipelineSummary } from './components/PipelineSummary'
import { useDeals } from './crm/useDeals'
import type { NewDeal, Stage } from './crm/types'

export function App() {
  const { deals, addDeal, moveDeal, updateDeal } = useDeals()
  const [announcement, setAnnouncement] = useState('')

  function handleAdd(deal: NewDeal) {
    addDeal(deal)
    setAnnouncement(`Added ${deal.company} to Sourcing`)
  }

  function handleMove(id: string, stage: Stage) {
    const deal = deals.find((candidate) => candidate.id === id)
    moveDeal(id, stage)
    if (deal) setAnnouncement(`Moved ${deal.company} to ${stage}`)
  }

  function handleUpdate(id: string, changes: NewDeal) {
    updateDeal(id, changes)
    setAnnouncement(`Saved changes to ${changes.company}`)
  }

  return (
    <main className="app">
      <header className="app__header">
        <h1 className="app__title">
          <svg
            className="app__icon"
            viewBox="0 0 24 24"
            aria-hidden="true"
            focusable="false"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="3" y="7" width="18" height="13" rx="2" />
            <path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            <path d="M3 13h18" />
          </svg>
          Deal CRM!
        </h1>
        <PipelineSummary deals={deals} />
      </header>
      <AddDealForm onAdd={handleAdd} />
      <PipelineBoard deals={deals} onMove={handleMove} onUpdate={handleUpdate} />
      <p className="visually-hidden" role="status" aria-live="polite">
        {announcement}
      </p>
    </main>
  )
}
