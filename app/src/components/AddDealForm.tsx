import { useRef, useState, type FormEvent } from 'react'
import type { NewDeal } from '../crm/types'

export interface AddDealFormProps {
  /** Called with a validated deal; the form clears itself afterwards. */
  onAdd: (deal: NewDeal) => void
}

interface Errors {
  company?: string
  size?: string
}

/** Blank is allowed; anything else must be a number above 0. */
function parseSize(value: string): number | undefined | null {
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  const size = Number(trimmed)
  return Number.isFinite(size) && size > 0 ? size : null
}

export function AddDealForm({ onAdd }: AddDealFormProps) {
  const [company, setCompany] = useState('')
  const [sector, setSector] = useState('')
  const [size, setSize] = useState('')
  const [owner, setOwner] = useState('')
  const [errors, setErrors] = useState<Errors>({})
  const companyRef = useRef<HTMLInputElement>(null)
  const sizeRef = useRef<HTMLInputElement>(null)

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const parsedSize = parseSize(size)
    const nextErrors: Errors = {}
    if (company.trim() === '') nextErrors.company = 'Enter a company name'
    if (parsedSize === null) nextErrors.size = 'Enter a size above 0'
    setErrors(nextErrors)

    if (nextErrors.company) {
      companyRef.current?.focus()
      return
    }
    if (parsedSize === null) {
      sizeRef.current?.focus()
      return
    }

    onAdd({ company: company.trim(), sector: sector.trim(), size: parsedSize, owner: owner.trim() })
    setCompany('')
    setSector('')
    setSize('')
    setOwner('')
    companyRef.current?.focus()
  }

  return (
    <form className="add-deal" onSubmit={handleSubmit} noValidate aria-labelledby="add-deal-heading">
      <h2 id="add-deal-heading" className="add-deal__title">
        New opportunity
      </h2>
      <div className="add-deal__fields">
        <div className="field">
          <label htmlFor="deal-company">Company</label>
          <input
            id="deal-company"
            ref={companyRef}
            value={company}
            onChange={(event) => setCompany(event.target.value)}
            aria-invalid={errors.company ? true : undefined}
            aria-describedby={errors.company ? 'deal-company-error' : undefined}
          />
          {errors.company && (
            <p id="deal-company-error" className="field__error" role="alert">
              {errors.company}
            </p>
          )}
        </div>
        <div className="field">
          <label htmlFor="deal-sector">Sector</label>
          <input id="deal-sector" value={sector} onChange={(event) => setSector(event.target.value)} />
        </div>
        <div className="field field--narrow">
          <label htmlFor="deal-size">Deal size (£m)</label>
          <input
            id="deal-size"
            ref={sizeRef}
            inputMode="decimal"
            value={size}
            onChange={(event) => setSize(event.target.value)}
            aria-invalid={errors.size ? true : undefined}
            aria-describedby={errors.size ? 'deal-size-error' : undefined}
          />
          {errors.size && (
            <p id="deal-size-error" className="field__error" role="alert">
              {errors.size}
            </p>
          )}
        </div>
        <div className="field">
          <label htmlFor="deal-owner">Owner</label>
          <input id="deal-owner" value={owner} onChange={(event) => setOwner(event.target.value)} />
        </div>
        <button type="submit" className="button">
          Add deal
        </button>
      </div>
    </form>
  )
}
