import { useEffect, useRef } from 'react'
import { STAGES, formatSize, type Deal, type Stage } from '../crm/types'

export interface PipelineBoardProps {
  deals: Deal[]
  onMove: (id: string, stage: Stage) => void
}

function stageSelectId(dealId: string): string {
  return `deal-stage-${dealId}`
}

export function PipelineBoard({ deals, onMove }: PipelineBoardProps) {
  // A moved card is re-mounted in its new column, which drops focus. Remember
  // which card moved and put focus back on its select once it has rendered.
  const movedId = useRef<string | null>(null)
  useEffect(() => {
    if (movedId.current === null) return
    document.getElementById(stageSelectId(movedId.current))?.focus()
    movedId.current = null
  }, [deals])

  function handleMove(id: string, stage: Stage) {
    movedId.current = id
    onMove(id, stage)
  }

  return (
    <div className="board">
      {STAGES.map((stage) => {
        const stageDeals = deals.filter((deal) => deal.stage === stage)
        return (
          <section key={stage} className="column" aria-label={stage}>
            <h2 className="column__title">
              {stage}
              <span className="column__count">{stageDeals.length}</span>
            </h2>
            {stageDeals.length === 0 ? (
              <p className="column__empty">No deals</p>
            ) : (
              stageDeals.map((deal) => (
                <DealCard key={deal.id} deal={deal} onMove={handleMove} />
              ))
            )}
          </section>
        )
      })}
    </div>
  )
}

interface DealCardProps {
  deal: Deal
  onMove: (id: string, stage: Stage) => void
}

function DealCard({ deal, onMove }: DealCardProps) {
  const headingId = `deal-${deal.id}`
  const selectId = stageSelectId(deal.id)
  return (
    <article className="deal" aria-labelledby={headingId}>
      <div className="deal__header">
        <h3 id={headingId} className="deal__company">
          {deal.company}
        </h3>
        {deal.size !== undefined && <span className="deal__size">{formatSize(deal.size)}</span>}
      </div>
      {deal.sector && <p className="deal__sector">{deal.sector}</p>}
      {deal.owner && <p className="deal__owner">{deal.owner}</p>}
      <label className="deal__stage-label" htmlFor={selectId}>
        <span aria-hidden="true">Stage</span>
        <span className="visually-hidden">Stage for {deal.company}</span>
      </label>
      <select
        id={selectId}
        className="deal__stage"
        value={deal.stage}
        onChange={(event) => onMove(deal.id, event.target.value as Stage)}
      >
        {STAGES.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </article>
  )
}
