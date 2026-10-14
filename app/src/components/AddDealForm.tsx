import type { FormEvent } from 'react'
import type { NewDeal } from '../crm/types'
import type { DealFields } from '../crm/validateDeal'
import { DealFormFields } from './DealFormFields'
import { useDealForm } from './useDealForm'

export interface AddDealFormProps {
  /** Called with a validated deal; the form clears itself afterwards. */
  onAdd: (deal: NewDeal) => void
}

const EMPTY: DealFields = { company: '', sector: '', size: '', owner: '' }

const fieldId = (field: string) => `deal-${field}`

export function AddDealForm({ onAdd }: AddDealFormProps) {
  const form = useDealForm(EMPTY)

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const deal = form.check()
    if (deal === null) return
    onAdd(deal)
    form.reset()
  }

  return (
    <form
      className="add-deal"
      onSubmit={handleSubmit}
      noValidate
      aria-labelledby="add-deal-heading"
    >
      <h2 id="add-deal-heading" className="add-deal__title">
        New opportunity
      </h2>
      <div className="add-deal__fields">
        <DealFormFields form={form} id={fieldId} narrowSize />
        <button type="submit" className="button">
          Add deal
        </button>
      </div>
    </form>
  )
}
