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
        <h1>Deal Pipeline</h1>
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
