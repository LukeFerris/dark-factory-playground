import { expect, test, type Page } from '@playwright/test'
import { uatStep } from './uat'

/**
 * The walkthrough for DF-17: every pipeline column shows how many deals it
 * holds beside its name, and the number keeps up as deals are added, moved,
 * dragged and passed on. An emptied column shows 0. The number is a small grey
 * pill straight after the name, as the reviewer asked on turn 2.
 *
 * Step numbers are the flattened `acceptance_criteria` steps a build turn
 * writes into `result.json`. A turn that changes those steps renumbers here in
 * the same turn.
 *
 * It is one test rather than one per criterion because the reviewer follows
 * the steps in order on one page, so each step starts from whatever the one
 * before it left. Every column holds one seeded deal on a first visit.
 *
 * It replaced DF-14's name-and-icon walkthrough, which the unit tests still
 * cover; the card's walkthrough is this card's.
 */

const STAGES = ['Sourcing', 'Screening', 'Due diligence', 'Investment committee', 'Closed', 'Passed']

function column(page: Page, stage: string) {
  return page.getByRole('region', { name: stage, exact: true })
}

// A column's heading is its name followed by its count, e.g. "Sourcing1".
function header(page: Page, stage: string) {
  return column(page, stage).getByRole('heading', { level: 2 })
}

// The count is a small grey pill straight after the name, not out at the far
// end of the header: its left edge is within a few pixels of the name's end.
async function expectPillBesideName(page: Page, stage: string, count: number) {
  const pill = header(page, stage).getByText(String(count), { exact: true })
  await expect(pill).toHaveCSS('background-color', 'rgb(228, 228, 224)')
  await expect(pill).toHaveCSS('border-top-color', 'rgb(202, 202, 196)')
  await expect(pill).toHaveCSS('border-radius', '999px')
  const nameRight = await header(page, stage).evaluate((heading) => {
    const range = document.createRange()
    range.selectNodeContents(heading.firstChild ?? heading)
    // A wrapped name has one box per line; the pill follows the last one.
    return [...range.getClientRects()].at(-1)?.right ?? 0
  })
  const pillBox = await pill.boundingBox()
  expect(pillBox).not.toBeNull()
  if (pillBox) expect(pillBox.x - nameRight).toBeLessThanOrEqual(12)
}

function stagePicker(page: Page, company: string) {
  return page.getByRole('combobox', { name: `Stage for ${company}` })
}

// Every pipeline column header shows the number of deals in that column.
async function firstVisitCounts(page: Page) {
  await uatStep(page, 1, async () => {
    await page.goto('/')
    await expect(column(page, 'Sourcing')).toBeVisible()
  })

  await uatStep(page, 2, async () => {
    for (const stage of STAGES) await expect(header(page, stage)).toBeVisible()
  })

  await uatStep(page, 3, async () => {
    for (const stage of STAGES) {
      await expect(header(page, stage)).toHaveText(`${stage}1`)
      await expect(column(page, stage).getByRole('article')).toHaveCount(1)
      await expectPillBesideName(page, stage, 1)
    }
  })
}

// The count updates straight away when a deal is added.
async function addingCounts(page: Page) {
  await uatStep(page, 4, async () => {
    await page.getByLabel('Company').fill('Acme Logistics')
    await expect(page.getByLabel('Company')).toHaveValue('Acme Logistics')
  })

  await uatStep(page, 5, async () => {
    await page.getByRole('button', { name: 'Add deal' }).click()
    await expect(column(page, 'Sourcing').getByRole('article', { name: 'Acme Logistics' })).toBeVisible()
  })

  await uatStep(page, 6, async () => {
    await expect(header(page, 'Sourcing')).toHaveText('Sourcing2')
  })
}

// The count updates straight away when a deal is moved with its stage picker.
async function pickerCounts(page: Page) {
  await uatStep(page, 7, async () => {
    await stagePicker(page, 'Harbour Dental Group').selectOption('Due diligence')
    await expect(column(page, 'Due diligence').getByRole('article', { name: 'Harbour Dental Group' })).toBeVisible()
  })

  await uatStep(page, 8, async () => {
    await expect(header(page, 'Screening')).toHaveText('Screening0')
    await expect(header(page, 'Due diligence')).toHaveText('Due diligence2')
  })
}

// The count updates straight away when a deal is dragged to another column.
async function draggingCounts(page: Page) {
  await uatStep(page, 9, async () => {
    await column(page, 'Due diligence')
      .getByRole('article', { name: 'Brightline Packaging' })
      .dragTo(column(page, 'Investment committee'))
    await expect(
      column(page, 'Investment committee').getByRole('article', { name: 'Brightline Packaging' }),
    ).toBeVisible()
  })

  await uatStep(page, 10, async () => {
    await expect(header(page, 'Due diligence')).toHaveText('Due diligence1')
    await expect(header(page, 'Investment committee')).toHaveText('Investment committee2')
  })
}

// The count updates straight away when a deal is passed on.
async function passingCounts(page: Page) {
  await uatStep(page, 11, async () => {
    await stagePicker(page, 'Kestrel Energy Services').selectOption('Passed')
    await expect(column(page, 'Passed').getByRole('article', { name: 'Kestrel Energy Services' })).toBeVisible()
  })

  await uatStep(page, 12, async () => {
    await expect(header(page, 'Investment committee')).toHaveText('Investment committee1')
    await expect(header(page, 'Passed')).toHaveText('Passed2')
  })
}

// An empty column shows 0.
async function emptyColumnCount(page: Page) {
  await uatStep(page, 13, async () => {
    await column(page, 'Screening').scrollIntoViewIfNeeded()
    await expect(column(page, 'Screening').getByRole('article')).toHaveCount(0)
  })

  await uatStep(page, 14, async () => {
    await expect(column(page, 'Screening').getByText('No deals')).toBeVisible()
    await expect(header(page, 'Screening')).toHaveText('Screening0')
    await expectPillBesideName(page, 'Screening', 0)
  })
}

test('every column counts its deals, and the count keeps up', async ({ page }) => {
  await firstVisitCounts(page)
  await addingCounts(page)
  await pickerCounts(page)
  await draggingCounts(page)
  await passingCounts(page)
  await emptyColumnCount(page)
})
