import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AddDealForm } from './AddDealForm'

function setup() {
  const onAdd = vi.fn()
  render(<AddDealForm onAdd={onAdd} />)
  return { onAdd, user: userEvent.setup() }
}

describe('AddDealForm', () => {
  it.each(['', '   '])('rejects a company of %j', async (company) => {
    const { onAdd, user } = setup()
    if (company) await user.type(screen.getByLabelText('Company'), company)
    await user.click(screen.getByRole('button', { name: 'Add deal' }))

    const field = screen.getByLabelText('Company')
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a company name')
    expect(field).toHaveAttribute('aria-invalid', 'true')
    expect(field).toHaveAccessibleDescription('Enter a company name')
    expect(onAdd).not.toHaveBeenCalled()
  })

  it.each(['0', '-5', 'abc'])('rejects a size of %j', async (size) => {
    const { onAdd, user } = setup()
    await user.type(screen.getByLabelText('Company'), 'Zero Co')
    await user.type(screen.getByLabelText('Deal size (£m)'), size)
    await user.click(screen.getByRole('button', { name: 'Add deal' }))

    const field = screen.getByLabelText('Deal size (£m)')
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a size above 0')
    expect(field).toHaveAttribute('aria-invalid', 'true')
    expect(field).toHaveAccessibleDescription('Enter a size above 0')
    expect(onAdd).not.toHaveBeenCalled()
  })

  it.each(['0', '12.5', 'abc'])('rejects employees of %j and focuses it', async (employees) => {
    const { onAdd, user } = setup()
    await user.type(screen.getByLabelText('Company'), 'Bad Count Ltd')
    await user.type(screen.getByLabelText('Employees'), employees)
    await user.click(screen.getByRole('button', { name: 'Add deal' }))

    const field = screen.getByLabelText('Employees')
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a whole number above 0')
    expect(field).toHaveAttribute('aria-invalid', 'true')
    expect(field).toHaveAccessibleDescription('Enter a whole number above 0')
    expect(field).toHaveFocus()
    expect(onAdd).not.toHaveBeenCalled()
  })

  it('focuses Employees, the first wrong field on screen, when size is wrong too', async () => {
    const { user } = setup()
    await user.type(screen.getByLabelText('Company'), 'Bad Count Ltd')
    await user.type(screen.getByLabelText('Employees'), '0')
    await user.type(screen.getByLabelText('Deal size (£m)'), '0')
    await user.click(screen.getByRole('button', { name: 'Add deal' }))
    expect(screen.getByLabelText('Employees')).toHaveFocus()
  })

  it('focuses Company when it is wrong as well as Employees and size', async () => {
    const { user } = setup()
    await user.type(screen.getByLabelText('Employees'), '0')
    await user.type(screen.getByLabelText('Deal size (£m)'), '0')
    await user.click(screen.getByRole('button', { name: 'Add deal' }))
    expect(screen.getByLabelText('Company')).toHaveFocus()
  })

  it('tabs through the fields in screen order', async () => {
    const { user } = setup()
    const order: string[] = []
    for (let i = 0; i < 5; i++) {
      await user.tab()
      order.push(document.activeElement?.id ?? '')
    }
    expect(order).toEqual(['deal-company', 'deal-sector', 'deal-employees', 'deal-size', 'deal-owner'])
  })

  it('allows a blank size and a blank Employees', async () => {
    const { onAdd, user } = setup()
    await user.type(screen.getByLabelText('Company'), 'No Size Ltd')
    await user.click(screen.getByRole('button', { name: 'Add deal' }))
    expect(onAdd).toHaveBeenCalledWith({ company: 'No Size Ltd', sector: '', employees: undefined, size: undefined, owner: '' })
  })

  it('submits the parsed values, clears the fields and returns focus to Company', async () => {
    const { onAdd, user } = setup()
    await user.type(screen.getByLabelText('Company'), 'Acme Logistics')
    await user.type(screen.getByLabelText('Sector'), 'Industrials')
    await user.type(screen.getByLabelText('Employees'), '1,200')
    await user.type(screen.getByLabelText('Deal size (£m)'), '12.5')
    await user.type(screen.getByLabelText('Owner'), 'Sam Patel')
    await user.click(screen.getByRole('button', { name: 'Add deal' }))

    expect(onAdd).toHaveBeenCalledWith({
      company: 'Acme Logistics',
      sector: 'Industrials',
      employees: 1200,
      size: 12.5,
      owner: 'Sam Patel',
    })
    for (const label of ['Company', 'Sector', 'Employees', 'Deal size (£m)', 'Owner']) {
      expect(screen.getByLabelText(label)).toHaveValue('')
    }
    expect(screen.getByLabelText('Company')).toHaveFocus()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
