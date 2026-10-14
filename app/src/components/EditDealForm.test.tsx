import { describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { EditDealForm } from './EditDealForm'
import type { Deal } from '../crm/types'

const beta: Deal = { id: 'b', company: 'Beta Health', sector: 'Healthcare', stage: 'Screening', employees: 420, size: 12.5, owner: 'Jo Lee' }

function setup(deal: Deal = beta) {
  const onSave = vi.fn()
  const onCancel = vi.fn()
  render(<EditDealForm deal={deal} onSave={onSave} onCancel={onCancel} />)
  const form = within(screen.getByRole('form', { name: `Edit ${deal.company}` }))
  return { onSave, onCancel, form, user: userEvent.setup() }
}

describe('EditDealForm', () => {
  it('fills the fields from the deal and focuses Company', () => {
    const { form } = setup()
    expect(form.getByLabelText('Company')).toHaveValue('Beta Health')
    expect(form.getByLabelText('Sector')).toHaveValue('Healthcare')
    expect(form.getByLabelText('Employees')).toHaveValue('420')
    expect(form.getByLabelText('Deal size (£m)')).toHaveValue('12.5')
    expect(form.getByLabelText('Owner')).toHaveValue('Jo Lee')
    expect(form.getByLabelText('Company')).toHaveFocus()
  })

  it('shows an empty size for a deal without one', () => {
    const { form } = setup({ ...beta, size: undefined })
    expect(form.getByLabelText('Deal size (£m)')).toHaveValue('')
  })

  it('shows an empty Employees for a deal without one', () => {
    const { form } = setup({ ...beta, employees: undefined })
    expect(form.getByLabelText('Employees')).toHaveValue('')
  })

  it('saves a changed number of employees', async () => {
    const { form, onSave, user } = setup()
    await user.clear(form.getByLabelText('Employees'))
    await user.type(form.getByLabelText('Employees'), '1,050')
    await user.click(form.getByRole('button', { name: 'Save' }))
    expect(onSave).toHaveBeenCalledWith({
      company: 'Beta Health',
      sector: 'Healthcare',
      employees: 1050,
      size: 12.5,
      owner: 'Jo Lee',
    })
  })

  it('saves a cleared Employees as not known', async () => {
    const { form, onSave, user } = setup()
    await user.clear(form.getByLabelText('Employees'))
    await user.click(form.getByRole('button', { name: 'Save' }))
    expect(onSave).toHaveBeenCalledWith({
      company: 'Beta Health',
      sector: 'Healthcare',
      employees: undefined,
      size: 12.5,
      owner: 'Jo Lee',
    })
  })

  it.each(['0', '12.5', 'abc'])('rejects employees of %j and focuses it', async (employees) => {
    const { form, onSave, user } = setup()
    await user.clear(form.getByLabelText('Employees'))
    await user.type(form.getByLabelText('Employees'), employees)
    await user.click(form.getByRole('button', { name: 'Save' }))
    const field = form.getByLabelText('Employees')
    expect(form.getByRole('alert')).toHaveTextContent('Enter a whole number above 0')
    expect(field).toHaveAttribute('aria-invalid', 'true')
    expect(field).toHaveAccessibleDescription('Enter a whole number above 0')
    expect(field).toHaveFocus()
    expect(onSave).not.toHaveBeenCalled()
  })

  it('saves the trimmed changes', async () => {
    const { form, onSave, user } = setup()
    await user.clear(form.getByLabelText('Company'))
    await user.type(form.getByLabelText('Company'), '  Beta Care  ')
    await user.clear(form.getByLabelText('Deal size (£m)'))
    await user.type(form.getByLabelText('Deal size (£m)'), '20')
    await user.click(form.getByRole('button', { name: 'Save' }))
    expect(onSave).toHaveBeenCalledWith({ company: 'Beta Care', sector: 'Healthcare', employees: 420, size: 20, owner: 'Jo Lee' })
  })

  it('saves a cleared size as no size', async () => {
    const { form, onSave, user } = setup()
    await user.clear(form.getByLabelText('Deal size (£m)'))
    await user.click(form.getByRole('button', { name: 'Save' }))
    expect(onSave).toHaveBeenCalledWith({
      company: 'Beta Health',
      sector: 'Healthcare',
      employees: 420,
      size: undefined,
      owner: 'Jo Lee',
    })
  })

  it('rejects a blank company and focuses it', async () => {
    const { form, onSave, user } = setup()
    await user.clear(form.getByLabelText('Company'))
    await user.click(form.getByRole('button', { name: 'Save' }))
    const field = form.getByLabelText('Company')
    expect(form.getByRole('alert')).toHaveTextContent('Enter a company name')
    expect(field).toHaveAttribute('aria-invalid', 'true')
    expect(field).toHaveAccessibleDescription('Enter a company name')
    expect(field).toHaveFocus()
    expect(onSave).not.toHaveBeenCalled()
  })

  it.each(['0', '-5', 'abc'])('rejects a size of %j and focuses it', async (size) => {
    const { form, onSave, user } = setup()
    await user.clear(form.getByLabelText('Deal size (£m)'))
    await user.type(form.getByLabelText('Deal size (£m)'), size)
    await user.click(form.getByRole('button', { name: 'Save' }))
    const field = form.getByLabelText('Deal size (£m)')
    expect(form.getByRole('alert')).toHaveTextContent('Enter a size above 0')
    expect(field).toHaveAttribute('aria-invalid', 'true')
    expect(field).toHaveAccessibleDescription('Enter a size above 0')
    expect(field).toHaveFocus()
    expect(onSave).not.toHaveBeenCalled()
  })

  it('cancels from the Cancel button', async () => {
    const { form, onSave, onCancel, user } = setup()
    await user.type(form.getByLabelText('Company'), 'x')
    await user.click(form.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalledOnce()
    expect(onSave).not.toHaveBeenCalled()
  })

  it('cancels on Escape', async () => {
    const { form, onSave, onCancel, user } = setup()
    await user.click(form.getByLabelText('Owner'))
    await user.keyboard('{Escape}')
    expect(onCancel).toHaveBeenCalledOnce()
    expect(onSave).not.toHaveBeenCalled()
  })
})
