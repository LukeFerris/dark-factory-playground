import { expect, test, type Page } from '@playwright/test'
import { uatStep } from './uat'

/**
 * The walkthrough for DF-9: editing a deal from inside its card.
 *
 * Step numbers are the flattened `acceptance_criteria` steps a build turn
 * writes into `result.json`. A turn that changes those steps renumbers here in
 * the same turn.
 *
 * It is one test rather than one per criterion because the reviewer follows
 * the steps in order on one page, so each step starts from whatever the one
 * before it left — the summary totals below are the ones they will see.
 *
 * It replaced DF-8's "a new deal joins the pipeline" walkthrough. Adding a deal
 * is still covered by the unit tests; the card's walkthrough is this card's.
 */

function card(page: Page, company: string) {
  return page.getByRole('article', { name: company })
}

function editForm(page: Page, company: string) {
  return page.getByRole('form', { name: `Edit ${company}` })
}

// "New opportunity" is a form too, so count only the ones opened from a card.
function openEditForms(page: Page) {
  return page.getByRole('form', { name: /^Edit / })
}

function summary(page: Page) {
  return page.getByText(/active deals? · /)
}

test('a deal is edited from inside its card', async ({ page }) => {
  await page.goto('/')

  // Every deal card has an "Edit" button.
  await uatStep(page, 1, async () => {
    await expect(page.getByRole('region', { name: 'Sourcing' }).getByRole('article', { name: 'Northwind Analytics' })).toBeVisible()
  })

  await uatStep(page, 2, async () => {
    await expect(card(page, 'Northwind Analytics').getByRole('button', { name: 'Edit Northwind Analytics' })).toHaveText('Edit Northwind Analytics')
    await expect(page.getByRole('button', { name: /^Edit / })).toHaveCount(6)
  })

  // Pressing "Edit" shows the deal's current details, ready to change.
  await uatStep(page, 3, async () => {
    await page.getByRole('button', { name: 'Edit Northwind Analytics' }).click()
    await expect(editForm(page, 'Northwind Analytics')).toBeVisible()
  })

  await uatStep(page, 4, async () => {
    const form = editForm(page, 'Northwind Analytics')
    await expect(form.getByLabel('Company')).toHaveValue('Northwind Analytics')
    await expect(form.getByLabel('Sector')).toHaveValue('Software')
    await expect(form.getByLabel('Deal size (£m)')).toHaveValue('40')
    await expect(form.getByLabel('Owner')).toHaveValue('Priya Shah')
    await expect(form.getByRole('button', { name: 'Save' })).toBeVisible()
    await expect(form.getByRole('button', { name: 'Cancel' })).toBeVisible()
    await expect(form.getByLabel('Company')).toBeFocused()
  })

  // Saved changes appear on the card, which stays in its column, and the summary updates.
  await uatStep(page, 5, async () => {
    await expect(summary(page)).toHaveText('4 active deals · £210m in pipeline')
  })

  await uatStep(page, 6, async () => {
    const form = editForm(page, 'Northwind Analytics')
    await form.getByLabel('Company').fill('Northwind Data')
    await form.getByLabel('Deal size (£m)').fill('55')
    await form.getByLabel('Owner').fill('Sam Patel')
    await expect(form.getByLabel('Owner')).toHaveValue('Sam Patel')
  })

  await uatStep(page, 7, async () => {
    await editForm(page, 'Northwind Analytics').getByRole('button', { name: 'Save' }).click()
    await expect(openEditForms(page)).toHaveCount(0)
  })

  await uatStep(page, 8, async () => {
    const saved = page.getByRole('region', { name: 'Sourcing' }).getByRole('article', { name: 'Northwind Data' })
    await expect(saved.getByText('£55m')).toBeVisible()
    await expect(saved.getByText('Software')).toBeVisible()
    await expect(saved.getByText('Sam Patel')).toBeVisible()
    await expect(saved.getByRole('textbox')).toHaveCount(0)
    await expect(summary(page)).toHaveText('4 active deals · £225m in pipeline')
  })

  // "Cancel" throws away any changes.
  await uatStep(page, 9, async () => {
    await page.getByRole('button', { name: 'Edit Harbour Dental Group' }).click()
    await expect(editForm(page, 'Harbour Dental Group')).toBeVisible()
  })

  await uatStep(page, 10, async () => {
    await editForm(page, 'Harbour Dental Group').getByLabel('Company').fill('Something Else')
    await expect(editForm(page, 'Harbour Dental Group').getByLabel('Company')).toHaveValue('Something Else')
  })

  await uatStep(page, 11, async () => {
    await editForm(page, 'Harbour Dental Group').getByRole('button', { name: 'Cancel' }).click()
    await expect(openEditForms(page)).toHaveCount(0)
  })

  await uatStep(page, 12, async () => {
    const harbour = card(page, 'Harbour Dental Group')
    await expect(harbour.getByText('£25m')).toBeVisible()
    await expect(harbour.getByText('Healthcare')).toBeVisible()
    await expect(harbour.getByText('Tom Okafor')).toBeVisible()
    await expect(page.getByText('Something Else')).toHaveCount(0)
  })

  // Pressing Escape while editing also throws away the changes.
  await uatStep(page, 13, async () => {
    await page.getByRole('button', { name: 'Edit Harbour Dental Group' }).click()
    await expect(editForm(page, 'Harbour Dental Group')).toBeVisible()
  })

  await uatStep(page, 14, async () => {
    await editForm(page, 'Harbour Dental Group').getByLabel('Owner').fill('Nobody')
    await expect(editForm(page, 'Harbour Dental Group').getByLabel('Owner')).toHaveValue('Nobody')
  })

  await uatStep(page, 15, async () => {
    await page.keyboard.press('Escape')
    await expect(openEditForms(page)).toHaveCount(0)
  })

  await uatStep(page, 16, async () => {
    await expect(card(page, 'Harbour Dental Group').getByText('Tom Okafor')).toBeVisible()
    await expect(page.getByText('Nobody')).toHaveCount(0)
  })

  // A deal cannot be saved without a company name.
  await uatStep(page, 17, async () => {
    await page.getByRole('button', { name: 'Edit Brightline Packaging' }).click()
    await expect(editForm(page, 'Brightline Packaging')).toBeVisible()
  })

  await uatStep(page, 18, async () => {
    await editForm(page, 'Brightline Packaging').getByLabel('Company').fill('')
    await expect(editForm(page, 'Brightline Packaging').getByLabel('Company')).toHaveValue('')
  })

  await uatStep(page, 19, async () => {
    await editForm(page, 'Brightline Packaging').getByRole('button', { name: 'Save' }).click()
    await expect(editForm(page, 'Brightline Packaging').getByRole('alert')).toBeVisible()
  })

  await uatStep(page, 20, async () => {
    const company = editForm(page, 'Brightline Packaging').getByLabel('Company')
    await expect(company).toHaveAccessibleDescription('Enter a company name')
    await expect(editForm(page, 'Brightline Packaging').getByRole('alert')).toHaveText('Enter a company name')
    await expect(company).toBeFocused()
  })

  // A deal cannot be saved with a size of zero or less.
  await uatStep(page, 21, async () => {
    await page.getByRole('button', { name: 'Edit Harbour Dental Group' }).click()
    await expect(editForm(page, 'Harbour Dental Group')).toBeVisible()
  })

  await uatStep(page, 22, async () => {
    await editForm(page, 'Harbour Dental Group').getByLabel('Deal size (£m)').fill('0')
    await expect(editForm(page, 'Harbour Dental Group').getByLabel('Deal size (£m)')).toHaveValue('0')
  })

  await uatStep(page, 23, async () => {
    await editForm(page, 'Harbour Dental Group').getByRole('button', { name: 'Save' }).click()
    await expect(editForm(page, 'Harbour Dental Group').getByRole('alert')).toBeVisible()
  })

  await uatStep(page, 24, async () => {
    const size = editForm(page, 'Harbour Dental Group').getByLabel('Deal size (£m)')
    await expect(size).toHaveAccessibleDescription('Enter a size above 0')
    await expect(editForm(page, 'Harbour Dental Group').getByRole('alert')).toHaveText('Enter a size above 0')
  })

  // Clearing the size and saving removes the size from the card and from the total.
  await uatStep(page, 25, async () => {
    await page.getByRole('button', { name: 'Edit Kestrel Energy Services' }).click()
    await expect(editForm(page, 'Kestrel Energy Services')).toBeVisible()
  })

  await uatStep(page, 26, async () => {
    await editForm(page, 'Kestrel Energy Services').getByLabel('Deal size (£m)').fill('')
    await expect(editForm(page, 'Kestrel Energy Services').getByLabel('Deal size (£m)')).toHaveValue('')
  })

  await uatStep(page, 27, async () => {
    await editForm(page, 'Kestrel Energy Services').getByRole('button', { name: 'Save' }).click()
    await expect(editForm(page, 'Kestrel Energy Services')).toHaveCount(0)
  })

  await uatStep(page, 28, async () => {
    await expect(card(page, 'Kestrel Energy Services').getByText(/£/)).toHaveCount(0)
    await expect(summary(page)).toHaveText('4 active deals · £140m in pipeline')
  })

  // Edits are kept after a reload.
  await uatStep(page, 29, async () => {
    await page.getByRole('button', { name: 'Edit Meridian Foods' }).click()
    await expect(editForm(page, 'Meridian Foods')).toBeVisible()
  })

  await uatStep(page, 30, async () => {
    await editForm(page, 'Meridian Foods').getByLabel('Sector').fill('Food & Drink')
    await expect(editForm(page, 'Meridian Foods').getByLabel('Sector')).toHaveValue('Food & Drink')
  })

  await uatStep(page, 31, async () => {
    await editForm(page, 'Meridian Foods').getByRole('button', { name: 'Save' }).click()
    await expect(card(page, 'Meridian Foods').getByText('Food & Drink')).toBeVisible()
  })

  await uatStep(page, 32, async () => {
    await page.reload()
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Deal Pipeline')
  })

  await uatStep(page, 33, async () => {
    const meridian = page.getByRole('region', { name: 'Closed' }).getByRole('article', { name: 'Meridian Foods' })
    await expect(meridian.getByText('Food & Drink')).toBeVisible()
  })

  // A deal can be edited using the keyboard alone.
  await uatStep(page, 34, async () => {
    const edit = page.getByRole('button', { name: 'Edit Atlas Freight Tech' })
    // Bounded, so a broken tab order fails here rather than looping forever.
    for (let presses = 0; presses < 40; presses++) {
      if (await edit.evaluate((element) => element === document.activeElement)) break
      await page.keyboard.press('Tab')
    }
    await expect(edit).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(editForm(page, 'Atlas Freight Tech').getByLabel('Company')).toBeFocused()
  })

  await uatStep(page, 35, async () => {
    await page.keyboard.press('End')
    await page.keyboard.type(' Ltd')
    await page.keyboard.press('Enter')
    await expect(openEditForms(page)).toHaveCount(0)
  })

  await uatStep(page, 36, async () => {
    await expect(card(page, 'Atlas Freight Tech Ltd')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Edit Atlas Freight Tech Ltd' })).toBeFocused()
  })
})
