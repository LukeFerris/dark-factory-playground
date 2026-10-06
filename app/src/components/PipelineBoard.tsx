import { useEffect, useRef, useState, type DragEvent } from 'react'
import { STAGES, formatEmployees, formatSize, type Deal, type NewDeal, type Stage } from '../crm/types'
import { EditDealForm } from './EditDealForm'

export interface PipelineBoardProps {
  deals: Deal[]
  onMove: (id: string, stage: Stage) => void
  onUpdate: (id: string, changes: NewDeal) => void
}

function stageSelectId(dealId: string): string {
  return `deal-stage-${dealId}`
}

export function PipelineBoard({ deals, onMove, onUpdate }: PipelineBoardProps) {
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

  // The card being dragged is a ref because nothing renders from it; only the
  // highlighted column does. A drop calls onMove directly rather than
  // handleMove, so a mouse drop leaves focus where it was.
  const dragged = useRef<{ id: string; stage: Stage } | null>(null)
  const [dropTarget, setDropTarget] = useState<Stage | null>(null)

  function handleDragStart(deal: Deal) {
    dragged.current = { id: deal.id, stage: deal.stage }
  }

  function handleDragEnd() {
    dragged.current = null
    setDropTarget(null)
  }

  function handleDragOver(event: DragEvent<HTMLElement>, stage: Stage) {
    // Not preventing the default leaves the browser's "can't drop here" cursor:
    // for the card's own column, and for drags that did not start on a card.
    if (dragged.current === null || dragged.current.stage === stage) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    if (dropTarget !== stage) setDropTarget(stage)
  }

  function handleDragLeave(event: DragEvent<HTMLElement>) {
    // Moving onto a card inside the column fires dragleave too; only clear
    // once the pointer has left the column itself.
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return
    setDropTarget(null)
  }

  function handleDrop(event: DragEvent<HTMLElement>, stage: Stage) {
    const card = dragged.current
    handleDragEnd()
    if (card === null || card.stage === stage) return
    event.preventDefault()
    onMove(card.id, stage)
  }

  return (
    <div className="board">
      {STAGES.map((stage) => {
        const stageDeals = deals.filter((deal) => deal.stage === stage)
        return (
          <section
            key={stage}
            className={stage === dropTarget ? 'column column--drop-target' : 'column'}
            aria-label={stage}
            onDragOver={(event) => handleDragOver(event, stage)}
            onDragLeave={handleDragLeave}
            onDrop={(event) => handleDrop(event, stage)}
          >
            <h2 className="column__title">
              {stage}
              <span className="column__count">{stageDeals.length}</span>
            </h2>
            {stageDeals.length === 0 ? (
              <p className="column__empty">No deals</p>
            ) : (
              stageDeals.map((deal) => (
                <DealCard
                  key={deal.id}
                  deal={deal}
                  onMove={handleMove}
                  onUpdate={onUpdate}
                  onDragStart={handleDragStart}
                  onDragEnd={handleDragEnd}
                />
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
  onUpdate: (id: string, changes: NewDeal) => void
  onDragStart: (deal: Deal) => void
  onDragEnd: () => void
}

function DealCard({ deal, onMove, onUpdate, onDragStart, onDragEnd }: DealCardProps) {
  const headingId = `deal-${deal.id}`
  const selectId = stageSelectId(deal.id)
  const [editing, setEditing] = useState(false)

  // Closing the form unmounts the field that had focus, so hand it back to
  // the Edit button — but only after a close, not when the card first renders.
  const editButton = useRef<HTMLButtonElement>(null)
  const closed = useRef(false)
  useEffect(() => {
    if (editing || !closed.current) return
    editButton.current?.focus()
    closed.current = false
  }, [editing])

  function close() {
    closed.current = true
    setEditing(false)
  }

  function handleSave(changes: NewDeal) {
    onUpdate(deal.id, changes)
    close()
  }

  function handleDragStart(event: DragEvent<HTMLElement>) {
    // Firefox will not start a drag without data. Nothing reads it back.
    event.dataTransfer.setData('text/plain', deal.id)
    event.dataTransfer.effectAllowed = 'move'
    onDragStart(deal)
  }

  // Not draggable while editing, so dragging inside a field still selects text.
  return (
    <article
      className="deal"
      aria-labelledby={headingId}
      draggable={!editing}
      onDragStart={editing ? undefined : handleDragStart}
      onDragEnd={editing ? undefined : onDragEnd}
    >
      <div className="deal__header">
        <h3 id={headingId} className="deal__company">
          {deal.company}
        </h3>
        {!editing && deal.size !== undefined && <span className="deal__size">{formatSize(deal.size)}</span>}
      </div>
      {editing ? (
        <EditDealForm deal={deal} onSave={handleSave} onCancel={close} />
      ) : (
        <>
          {deal.sector && <p className="deal__sector">{deal.sector}</p>}
          {deal.employees !== undefined && <p className="deal__employees">{formatEmployees(deal.employees)}</p>}
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
          <button type="button" ref={editButton} className="deal__edit" onClick={() => setEditing(true)}>
            Edit<span className="visually-hidden"> {deal.company}</span>
          </button>
        </>
      )}
    </article>
  )
}
