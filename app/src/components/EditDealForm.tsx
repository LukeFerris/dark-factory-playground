import { useEffect, type FormEvent, type KeyboardEvent } from 'react'
import type { Deal, NewDeal } from '../crm/types'
import { DealFormFields } from './DealFormFields'
import { useDealForm } from './useDealForm'

export interface EditDealFormProps {
  deal: Deal
  /** Called with the validated changes; the card closes the form afterwards. */
  onSave: (changes: NewDeal) => void
  onCancel: () => void
}

export function EditDealForm({ deal, onSave, onCancel }: EditDealFormProps) {
  const form = useDealForm({
    company: deal.company,
    sector: deal.sector,
    size: deal.size === undefined ? '' : String(deal.size),
    owner: deal.owner,
  })
  const { companyRef } = form

  useEffect(() => {
    companyRef.current?.focus()
  }, [companyRef])

  // Namespaced by deal so the ids clash with neither the add form nor another open card.
  const id = (field: string) => `edit-${deal.id}-${field}`

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const changes = form.check()
    if (changes !== null) onSave(changes)
  }

  function handleKeyDown(event: KeyboardEvent<HTMLFormElement>) {
    if (event.key !== 'Escape') return
    event.preventDefault()
    onCancel()
  }

  return (
    <form
      className="edit-deal"
      onSubmit={handleSubmit}
      onKeyDown={handleKeyDown}
      noValidate
      aria-label={`Edit ${deal.company}`}
    >
      <DealFormFields form={form} id={id} />
      <div className="edit-deal__actions">
        <button type="submit" className="button">
          Save
        </button>
        <button type="button" className="button button--secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  )
}
