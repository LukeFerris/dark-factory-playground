import { useRef, useState } from 'react'
import type { NewDeal } from '../crm/types'
import { validateDeal, type DealErrors, type DealFields } from '../crm/validateDeal'

/**
 * The state both deal forms keep: the four fields as typed, the errors from the
 * last submit, and the two inputs a failed submit can send focus back to. The
 * forms differ only in what they do with a valid deal.
 */
export function useDealForm(initial: DealFields) {
  const [fields, setFields] = useState(initial)
  const [errors, setErrors] = useState<DealErrors>({})
  const companyRef = useRef<HTMLInputElement>(null)
  const sizeRef = useRef<HTMLInputElement>(null)

  function setField(name: keyof DealFields, value: string) {
    setFields((current) => ({ ...current, [name]: value }))
  }

  /**
   * The validated deal, or null after showing what is wrong and focusing the
   * first field at fault, so the fix starts where the problem is.
   */
  function check(): NewDeal | null {
    const result = validateDeal(fields)
    if ('errors' in result) {
      setErrors(result.errors)
      if (result.errors.company) companyRef.current?.focus()
      else sizeRef.current?.focus()
      return null
    }
    return result.deal
  }

  /** Back to the starting fields with no errors, ready for the next entry. */
  function reset() {
    setErrors({})
    setFields(initial)
    companyRef.current?.focus()
  }

  return { fields, setField, errors, companyRef, sizeRef, check, reset }
}

export type DealForm = ReturnType<typeof useDealForm>
