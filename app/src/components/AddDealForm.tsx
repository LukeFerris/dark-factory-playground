import { useRef, useState, type FormEvent } from 'react'
import type { NewDeal } from '../crm/types'
import { validateDeal, type DealErrors } from '../crm/validateDeal'

export interface AddDealFormProps {
  /** Called with a validated deal; the form clears itself afterwards. */
  onAdd: (deal: NewDeal) => void
}

export function AddDealForm({ onAdd }: AddDealFormProps) {
  const [company, setCompany] = useState('')
  const [sector, setSector] = useState('')
  const [employees, setEmployees] = useState('')
  const [size, setSize] = useState('')
  const [owner, setOwner] = useState('')
  const [errors, setErrors] = useState<DealErrors>({})
  const companyRef = useRef<HTMLInputElement>(null)
  const employeesRef = useRef<HTMLInputElement>(null)
  const sizeRef = useRef<HTMLInputElement>(null)

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const result = validateDeal({ company, sector, employees, size, owner })
    if ('errors' in result) {
      setErrors(result.errors)
      // Focus the first wrong field in the order they appear on screen.
      if (result.errors.company) companyRef.current?.focus()
      else if (result.errors.employees) employeesRef.current?.focus()
      else sizeRef.current?.focus()
      return
    }

    setErrors({})
    onAdd(result.deal)
    setCompany('')
    setSector('')
    setEmployees('')
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
          <label htmlFor="deal-employees">Employees</label>
          <input
            id="deal-employees"
            ref={employeesRef}
            inputMode="numeric"
            value={employees}
            onChange={(event) => setEmployees(event.target.value)}
            aria-invalid={errors.employees ? true : undefined}
            aria-describedby={errors.employees ? 'deal-employees-error' : undefined}
          />
          {errors.employees && (
            <p id="deal-employees-error" className="field__error" role="alert">
              {errors.employees}
            </p>
          )}
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
