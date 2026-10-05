import { expect, test, type Locator, type Page } from '@playwright/test'
import { uatStep } from './uat'

/**
 * The walkthrough for DF-11: dragging deal cards between stage columns.
 *
 * Step numbers are the flattened `acceptance_criteria` steps a build turn
 * writes into `result.json`. A turn that changes those steps renumbers here in
 * the same turn.
 *
 * It is one test rather than one per criterion because the reviewer follows
 * the steps in order on one page, so each step starts from whatever the one
 * before it left — the summary totals below are the ones they will see.
 *
 * It replaced DF-9's "a deal is edited from inside its card" walkthrough.
 * Editing is still covered by the unit tests; the card's walkthrough is this
 * card's.
 */

const STAGES = [
  'Sourcing',
  'Screening',
  'Due diligence',
  'Investment committee',
  'Closed',
  'Passed',
]

function column(page: Page, stage: string) {
  return page.getByRole('region', { name: stage })
}

function cardIn(page: Page, stage: string, company: string) {
  return column(page, stage).getByRole('article', { name: company })
}

function count(page: Page, stage: string) {
  return column(page, stage).getByRole('heading', { level: 2 }).locator('span')
}

function summary(page: Page) {
  return page.getByText(/active deals? · /)
}

// The columns drawn with the dashed drop outline, read from what is painted
// rather than from a class name.
function outlined(page: Page) {
  return expect.poll(async () => {
    const dashed: string[] = []
    for (const stage of STAGES) {
      const style = await column(page, stage).evaluate(
        (element) => getComputedStyle(element).outlineStyle,
      )
      if (style === 'dashed') dashed.push(stage)
    }
    return dashed
  })
}

async function centre(locator: Locator) {
  const box = await locator.boundingBox()
  if (box === null) throw new Error('not on screen')
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

// A point in the column's empty space, just below `last`. Not the column's
// bottom edge: every column is as tall as the tallest, which runs off screen.
async function below(columnLocator: Locator, last: Locator) {
  const box = await columnLocator.boundingBox()
  const lastBox = await last.boundingBox()
  if (box === null || lastBox === null) throw new Error('not on screen')
  return { x: box.width / 2, y: lastBox.y + lastBox.height + 20 - box.y }
}

test('deal cards are dragged between stage columns', async ({ page }) => {
  await page.goto('/')

  // While a card is being dragged, the column it would land in is highlighted,
  // and letting go outside every column leaves the card where it was.
  await uatStep(page, 1, async () => {
    const from = await centre(cardIn(page, 'Sourcing', 'Northwind Analytics'))
    const to = await centre(column(page, 'Screening'))
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(to.x, to.y, { steps: 10 })
    await outlined(page).toEqual(['Screening'])
  })

  await uatStep(page, 2, async () => {
    await expect(column(page, 'Screening')).toHaveCSS('outline-style', 'dashed')
    await outlined(page).toEqual(['Screening'])
  })

  await uatStep(page, 3, async () => {
    const heading = await centre(page.getByRole('heading', { level: 1, name: 'Deal Pipeline' }))
    await page.mouse.move(heading.x, heading.y, { steps: 10 })
    await outlined(page).toEqual([])
  })

  await uatStep(page, 4, async () => {
    await outlined(page).toEqual([])
  })

  await uatStep(page, 5, async () => {
    await page.mouse.up()
    await expect(cardIn(page, 'Sourcing', 'Northwind Analytics')).toBeVisible()
  })

  await uatStep(page, 6, async () => {
    await expect(cardIn(page, 'Sourcing', 'Northwind Analytics')).toBeVisible()
    await expect(count(page, 'Sourcing')).toHaveText('1')
    await outlined(page).toEqual([])
  })

  // Dropping a card on another column moves the deal to that stage.
  await uatStep(page, 7, async () => {
    await cardIn(page, 'Sourcing', 'Northwind Analytics').dragTo(column(page, 'Screening'))
    await expect(cardIn(page, 'Screening', 'Northwind Analytics')).toBeVisible()
  })

  await uatStep(page, 8, async () => {
    await expect(count(page, 'Screening')).toHaveText('2')
    await expect(column(page, 'Sourcing').getByText('No deals')).toBeVisible()
    await expect(count(page, 'Sourcing')).toHaveText('0')
    await expect(page.getByRole('combobox', { name: 'Stage for Northwind Analytics' })).toHaveValue(
      'Screening',
    )
  })

  // A card can be dropped on an empty column.
  await uatStep(page, 9, async () => {
    const sourcing = column(page, 'Sourcing')
    await cardIn(page, 'Due diligence', 'Brightline Packaging').dragTo(sourcing, {
      targetPosition: await below(sourcing, sourcing.getByText('No deals')),
    })
    await expect(cardIn(page, 'Sourcing', 'Brightline Packaging')).toBeVisible()
  })

  await uatStep(page, 10, async () => {
    await expect(column(page, 'Sourcing').getByText('No deals')).toHaveCount(0)
    await expect(column(page, 'Due diligence').getByText('No deals')).toBeVisible()
  })

  // Dropping a card on "Closed" or "Passed" updates the summary.
  await uatStep(page, 11, async () => {
    await expect(summary(page)).toHaveText('4 active deals · £210m in pipeline')
  })

  // At 1280 wide the six columns overflow and the board scrolls sideways, so
  // "Passed" has to be brought into view before anything can be dropped on it.
  await uatStep(page, 12, async () => {
    const heading = column(page, 'Passed').getByRole('heading', { level: 2 })
    await heading.scrollIntoViewIfNeeded()
    await expect(heading).toBeInViewport({ ratio: 1 })
  })

  await uatStep(page, 13, async () => {
    const passed = column(page, 'Passed')
    await cardIn(page, 'Screening', 'Harbour Dental Group').dragTo(passed, {
      targetPosition: await below(passed, cardIn(page, 'Passed', 'Atlas Freight Tech')),
    })
    await expect(cardIn(page, 'Passed', 'Harbour Dental Group')).toBeVisible()
  })

  await uatStep(page, 14, async () => {
    await expect(cardIn(page, 'Passed', 'Harbour Dental Group')).toBeVisible()
    await expect(summary(page)).toHaveText('3 active deals · £185m in pipeline')
  })

  // Dropping a card back on its own column changes nothing.
  await uatStep(page, 15, async () => {
    const committee = column(page, 'Investment committee')
    const kestrel = cardIn(page, 'Investment committee', 'Kestrel Energy Services')
    await kestrel.dragTo(committee, { targetPosition: await below(committee, kestrel) })
    await expect(cardIn(page, 'Investment committee', 'Kestrel Energy Services')).toBeVisible()
  })

  await uatStep(page, 16, async () => {
    await expect(cardIn(page, 'Investment committee', 'Kestrel Energy Services')).toBeVisible()
    await expect(count(page, 'Investment committee')).toHaveText('1')
    await expect(summary(page)).toHaveText('3 active deals · £185m in pipeline')
  })

  // A card whose edit form is open can't be dragged.
  await uatStep(page, 17, async () => {
    await page.getByRole('button', { name: 'Edit Meridian Foods' }).click()
    await expect(page.getByRole('form', { name: 'Edit Meridian Foods' })).toBeVisible()
  })

  await uatStep(page, 18, async () => {
    const passed = column(page, 'Passed')
    await column(page, 'Closed')
      .getByRole('heading', { name: 'Meridian Foods' })
      .dragTo(passed, {
        targetPosition: await below(passed, cardIn(page, 'Passed', 'Harbour Dental Group')),
      })
    await expect(cardIn(page, 'Closed', 'Meridian Foods')).toBeVisible()
  })

  await uatStep(page, 19, async () => {
    await expect(cardIn(page, 'Closed', 'Meridian Foods')).toBeVisible()
    await expect(
      column(page, 'Passed').getByRole('article', { name: 'Meridian Foods' }),
    ).toHaveCount(0)
    await expect(
      cardIn(page, 'Closed', 'Meridian Foods').getByRole('form', { name: 'Edit Meridian Foods' }),
    ).toBeVisible()
  })

  // Moves made by dragging survive a reload.
  await uatStep(page, 20, async () => {
    await page.reload()
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Deal Pipeline')
  })

  await uatStep(page, 21, async () => {
    await expect(cardIn(page, 'Screening', 'Northwind Analytics')).toBeVisible()
    await expect(cardIn(page, 'Sourcing', 'Brightline Packaging')).toBeVisible()
    await expect(cardIn(page, 'Passed', 'Harbour Dental Group')).toBeVisible()
  })

  // The "Stage" picker still moves a card.
  await uatStep(page, 22, async () => {
    await page
      .getByRole('combobox', { name: 'Stage for Kestrel Energy Services' })
      .selectOption('Closed')
    await expect(cardIn(page, 'Closed', 'Kestrel Energy Services')).toBeVisible()
  })

  await uatStep(page, 23, async () => {
    await expect(cardIn(page, 'Closed', 'Kestrel Energy Services')).toBeVisible()
    await expect(summary(page)).toHaveText('2 active deals · £100m in pipeline')
  })
})
