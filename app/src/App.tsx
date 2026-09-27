import { useState } from 'react'
import { AddDealForm } from './components/AddDealForm'
import { PipelineBoard } from './components/PipelineBoard'
import { PipelineSummary } from './components/PipelineSummary'
import { useDeals } from './crm/useDeals'
import type { NewDeal, Stage } from './crm/types'

export function App() {
  const { deals, addDeal, moveDeal } = useDeals()
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

  return (
    <main className="app">
      <header className="app__header">
        <h1>Deal Pipeline</h1>
        <PipelineSummary deals={deals} />
      </header>
      <AddDealForm onAdd={handleAdd} />
      <PipelineBoard deals={deals} onMove={handleMove} />
      <p className="visually-hidden" role="status" aria-live="polite">
        {announcement}
      </p>
    </main>
  )
}
