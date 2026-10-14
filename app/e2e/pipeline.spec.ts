import { expect, test, type Page } from '@playwright/test'
import { uatStep } from './uat'

/**
 * The walkthrough for DF-15: each opportunity has an optional "Employees"
 * field, typed in either form and shown on the card as "1,200 employees".
 *
 * Step numbers are the flattened `acceptance_criteria` steps a build turn
 * writes into `result.json`. A turn that changes those steps renumbers here in
 * the same turn.
 *
 * It is one test rather than one per criterion because the reviewer follows
 * the steps in order on one page, so each step starts from whatever the one
 * before it left.
 *
 * It replaced DF-14's walkthrough of the app's name and icon. Those checks
 * remain covered by `App.test.tsx` and `index.html.test.ts`; the card's
 * walkthrough is this card's.
 */

function card(page: Page, stage: string, company: string) {
  return page.getByRole('region', { name: stage }).getByRole('article', { name: company })
}

function addForm(page: Page) {
  return page.getByRole('form', { name: 'New opportunity' })
}

test('each opportunity can record its number of employees', async ({ page }) => {
  await page.goto('/')
  const add = addForm(page)
  const employees = add.getByLabel('Employees')
  const addDeal = add.getByRole('button', { name: 'Add deal' })

  // Each sample deal shows its company's number of employees.
  const northwind = card(page, 'Sourcing', 'Northwind Analytics')
  await uatStep(page, 1, async () => {
    await expect(northwind).toBeVisible()
  })

  await uatStep(page, 2, async () => {
    await expect(northwind.getByText('Software')).toBeVisible()
    await expect(northwind.getByText('180 employees')).toBeVisible()
  })

  const kestrel = card(page, 'Investment committee', 'Kestrel Energy Services')
  await uatStep(page, 3, async () => {
    await expect(kestrel).toBeVisible()
  })

  await uatStep(page, 4, async () => {
    await expect(kestrel.getByText('1,300 employees')).toBeVisible()
  })

  // A new opportunity can be added with a number of employees.
  await uatStep(page, 5, async () => {
    await add.getByLabel('Company').fill('Acme Logistics')
    await expect(add.getByLabel('Company')).toHaveValue('Acme Logistics')
  })

  await uatStep(page, 6, async () => {
    await employees.fill('1,200')
    await expect(employees).toHaveValue('1,200')
  })

  const acme = card(page, 'Sourcing', 'Acme Logistics')
  await uatStep(page, 7, async () => {
    await addDeal.click()
    await expect(acme).toBeVisible()
  })

  await uatStep(page, 8, async () => {
    await expect(acme.getByText('1,200 employees')).toBeVisible()
    await expect(employees).toHaveValue('')
  })

  // A new opportunity can be added without a number of employees.
  await uatStep(page, 9, async () => {
    await add.getByLabel('Company').fill('Quiet Co')
    await expect(add.getByLabel('Company')).toHaveValue('Quiet Co')
    await expect(employees).toHaveValue('')
  })

  const quiet = card(page, 'Sourcing', 'Quiet Co')
  await uatStep(page, 10, async () => {
    await addDeal.click()
    await expect(quiet).toBeVisible()
  })

  await uatStep(page, 11, async () => {
    await expect(quiet.getByText(/employee/)).toHaveCount(0)
  })

  // A number of employees that isn't a whole number above 0 is refused.
  const message = add.getByRole('alert')
  const badCount = page.getByRole('article', { name: 'Bad Count Ltd' })

  await uatStep(page, 12, async () => {
    await add.getByLabel('Company').fill('Bad Count Ltd')
    await employees.fill('0')
    await expect(employees).toHaveValue('0')
  })

  await uatStep(page, 13, async () => {
    await addDeal.click()
    await expect(message).toBeVisible()
  })

  await uatStep(page, 14, async () => {
    await expect(message).toHaveText('Enter a whole number above 0')
    await expect(employees).toHaveAccessibleDescription('Enter a whole number above 0')
    await expect(employees).toBeFocused()
    await expect(badCount).toHaveCount(0)
  })

  await uatStep(page, 15, async () => {
    await employees.fill('12.5')
    await addDeal.click()
    await expect(employees).toHaveValue('12.5')
  })

  await uatStep(page, 16, async () => {
    await expect(message).toHaveText('Enter a whole number above 0')
    await expect(badCount).toHaveCount(0)
  })

  await uatStep(page, 17, async () => {
    await employees.fill('40')
    await addDeal.click()
    await expect(card(page, 'Sourcing', 'Bad Count Ltd')).toBeVisible()
  })

  await uatStep(page, 18, async () => {
    await expect(message).toHaveCount(0)
    await expect(card(page, 'Sourcing', 'Bad Count Ltd').getByText('40 employees')).toBeVisible()
  })

  // A single employee reads "1 employee".
  await uatStep(page, 19, async () => {
    await add.getByLabel('Company').fill('Solo Ventures')
    await employees.fill('1')
    await expect(employees).toHaveValue('1')
  })

  const solo = card(page, 'Sourcing', 'Solo Ventures')
  await uatStep(page, 20, async () => {
    await addDeal.click()
    await expect(solo).toBeVisible()
  })

  await uatStep(page, 21, async () => {
    // The card's only mention of employees is exactly "1 employee".
    await expect(solo.getByText(/employee/)).toHaveText(['1 employee'])
  })

  // The number of employees can be changed or removed when editing a deal.
  const editForm = page.getByRole('form', { name: 'Edit Northwind Analytics' })
  const editEmployees = editForm.getByLabel('Employees')
  const editButton = page.getByRole('button', { name: 'Edit Northwind Analytics' })

  await uatStep(page, 22, async () => {
    await editButton.click()
    await expect(editForm).toBeVisible()
  })

  await uatStep(page, 23, async () => {
    await expect(editEmployees).toHaveValue('180')
  })

  await uatStep(page, 24, async () => {
    await editEmployees.fill('210')
    await editForm.getByRole('button', { name: 'Save' }).click()
    await expect(editForm).toHaveCount(0)
  })

  await uatStep(page, 25, async () => {
    await expect(northwind.getByText('210 employees')).toBeVisible()
  })

  await uatStep(page, 26, async () => {
    await editButton.click()
    await editEmployees.clear()
    await editForm.getByRole('button', { name: 'Save' }).click()
    await expect(editForm).toHaveCount(0)
  })

  await uatStep(page, 27, async () => {
    await expect(northwind.getByText('Software')).toBeVisible()
    await expect(northwind.getByText(/employee/)).toHaveCount(0)
  })

  // Numbers of employees survive a reload.
  await uatStep(page, 28, async () => {
    await page.reload()
    await expect(acme).toBeVisible()
  })

  await uatStep(page, 29, async () => {
    await expect(acme.getByText('1,200 employees')).toBeVisible()
    await expect(kestrel.getByText('1,300 employees')).toBeVisible()
    await expect(northwind).toBeVisible()
    await expect(northwind.getByText(/employee/)).toHaveCount(0)
  })
})
