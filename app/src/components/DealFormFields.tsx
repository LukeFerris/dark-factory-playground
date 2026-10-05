import type { RefObject } from 'react'
import type { DealForm } from './useDealForm'

interface FieldProps {
  label: string
  id: string
  value: string
  onChange: (value: string) => void
  className?: string
  inputRef?: RefObject<HTMLInputElement | null>
  inputMode?: 'decimal'
  /** Shown under the input and announced; also marks the input invalid. */
  error?: string
}

function Field({
  label,
  id,
  value,
  onChange,
  className = 'field',
  inputRef,
  inputMode,
  error,
}: FieldProps) {
  const errorId = `${id}-error`
  return (
    <div className={className}>
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        ref={inputRef}
        inputMode={inputMode}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
      />
      {error && (
        <p id={errorId} className="field__error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

export interface DealFormFieldsProps {
  form: DealForm
  /** Builds each input's id, so two forms on one page never share one. */
  id: (field: string) => string
  /** The add form lays its fields out in a row, where the size needs less room. */
  narrowSize?: boolean
}

/** The four deal fields, the same for adding and editing. */
export function DealFormFields({ form, id, narrowSize = false }: DealFormFieldsProps) {
  const { fields, setField, errors } = form
  return (
    <>
      <Field
        label="Company"
        id={id('company')}
        inputRef={form.companyRef}
        value={fields.company}
        onChange={(value) => setField('company', value)}
        error={errors.company}
      />
      <Field
        label="Sector"
        id={id('sector')}
        value={fields.sector}
        onChange={(value) => setField('sector', value)}
      />
      <Field
        label="Deal size (£m)"
        id={id('size')}
        className={narrowSize ? 'field field--narrow' : 'field'}
        inputRef={form.sizeRef}
        inputMode="decimal"
        value={fields.size}
        onChange={(value) => setField('size', value)}
        error={errors.size}
      />
      <Field
        label="Owner"
        id={id('owner')}
        value={fields.owner}
        onChange={(value) => setField('owner', value)}
      />
    </>
  )
}
