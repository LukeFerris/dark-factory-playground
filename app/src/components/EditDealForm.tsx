import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import type { Deal, NewDeal } from '../crm/types'
import { validateDeal, type DealErrors } from '../crm/validateDeal'

export interface EditDealFormProps {
  deal: Deal
  /** Called with the validated changes; the card closes the form afterwards. */
  onSave: (changes: NewDeal) => void
  onCancel: () => void
}

export function EditDealForm({ deal, onSave, onCancel }: EditDealFormProps) {
  const [company, setCompany] = useState(deal.company)
  const [sector, setSector] = useState(deal.sector)
  const [size, setSize] = useState(deal.size === undefined ? '' : String(deal.size))
  const [owner, setOwner] = useState(deal.owner)
  const [errors, setErrors] = useState<DealErrors>({})
  const companyRef = useRef<HTMLInputElement>(null)
  const sizeRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    companyRef.current?.focus()
  }, [])

  // Namespaced by deal so the ids clash with neither the add form nor another open card.
  const id = (field: string) => `edit-${deal.id}-${field}`

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const result = validateDeal({ company, sector, size, owner })
    if ('errors' in result) {
      setErrors(result.errors)
      if (result.errors.company) companyRef.current?.focus()
      else sizeRef.current?.focus()
      return
    }
    onSave(result.deal)
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
      <div className="field">
        <label htmlFor={id('company')}>Company</label>
        <input
          id={id('company')}
          ref={companyRef}
          value={company}
          onChange={(event) => setCompany(event.target.value)}
          aria-invalid={errors.company ? true : undefined}
          aria-describedby={errors.company ? id('company-error') : undefined}
        />
        {errors.company && (
          <p id={id('company-error')} className="field__error" role="alert">
            {errors.company}
          </p>
        )}
      </div>
      <div className="field">
        <label htmlFor={id('sector')}>Sector</label>
        <input
          id={id('sector')}
          value={sector}
          onChange={(event) => setSector(event.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor={id('size')}>Deal size (£m)</label>
        <input
          id={id('size')}
          ref={sizeRef}
          inputMode="decimal"
          value={size}
          onChange={(event) => setSize(event.target.value)}
          aria-invalid={errors.size ? true : undefined}
          aria-describedby={errors.size ? id('size-error') : undefined}
        />
        {errors.size && (
          <p id={id('size-error')} className="field__error" role="alert">
            {errors.size}
          </p>
        )}
      </div>
      <div className="field">
        <label htmlFor={id('owner')}>Owner</label>
        <input id={id('owner')} value={owner} onChange={(event) => setOwner(event.target.value)} />
      </div>
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
