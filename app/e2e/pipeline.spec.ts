import { expect, test, type Locator, type Page } from '@playwright/test'
import { uatStep } from './uat'

/**
 * The walkthrough for DF-14: the app is called "Deal CRM", with a briefcase
 * icon beside the name in the header.
 *
 * Step numbers are the flattened `acceptance_criteria` steps a build turn
 * writes into `result.json`. A turn that changes those steps renumbers here in
 * the same turn.
 *
 * It is one test rather than one per criterion because the reviewer follows
 * the steps in order on one page, so each step starts from whatever the one
 * before it left.
 *
 * Steps 5 and 7 have no `uatStep`: one is looking at the browser tab, which a
 * page screenshot does not show, and the other is the browser's own find bar,
 * which a page cannot open. The steps after each assert what the reviewer sees.
 *
 * It replaced DF-11's drag-and-drop walkthrough. Dragging is still covered by
 * the unit tests; the card's walkthrough is this card's.
 */

type Box = { x: number; y: number; width: number; height: number }

function heading(page: Page) {
  return page.getByRole('heading', { level: 1 })
}

function icon(page: Page) {
  return heading(page).locator('svg')
}

async function box(locator: Locator): Promise<Box> {
  const found = await locator.boundingBox()
  if (found === null) throw new Error('not on screen')
  return found
}

// The box around the heading's words alone, without the icon beside them.
function textBox(page: Page): Promise<Box> {
  return heading(page).evaluate((element) => {
    const range = document.createRange()
    const text = [...element.childNodes].find((node) => node.nodeType === Node.TEXT_NODE)
    if (text === undefined) throw new Error('heading has no text')
    range.selectNodeContents(text)
    const { x, y, width, height } = range.getBoundingClientRect()
    return { x, y, width, height }
  })
}

// The icon sits wholly to the left of the words, and the two share a line.
async function iconBesideName(page: Page) {
  await expect(icon(page)).toBeVisible()
  const glyph = await box(icon(page))
  const words = await textBox(page)
  expect(glyph.x + glyph.width).toBeLessThanOrEqual(words.x)
  expect(glyph.y).toBeLessThan(words.y + words.height)
  expect(words.y).toBeLessThan(glyph.y + glyph.height)
}

test('the app is called Deal CRM, with a briefcase beside the name', async ({ page }) => {
  await page.goto('/')

  // The header shows the name "Deal CRM" with a briefcase icon beside it.
  await uatStep(page, 1, async () => {
    await expect(heading(page)).toHaveText('Deal CRM')
  })

  await uatStep(page, 2, async () => {
    await expect(heading(page)).toHaveAccessibleName('Deal CRM')
    await iconBesideName(page)
  })

  // The summary line still sits beneath the name.
  const summary = page.getByText(/active deals? · /)

  await uatStep(page, 3, async () => {
    await expect(summary).toBeVisible()
    const name = await box(heading(page))
    expect((await box(summary)).y).toBeGreaterThanOrEqual(name.y + name.height)
  })

  await uatStep(page, 4, async () => {
    await expect(summary).toHaveText('4 active deals · £210m in pipeline')
  })

  // The browser tab is titled "Deal CRM".
  await uatStep(page, 6, async () => {
    await expect(page).toHaveTitle('Deal CRM')
  })

  // The old name "Deal Pipeline" appears nowhere on the page.
  await uatStep(page, 8, async () => {
    await expect(page.getByText('Deal Pipeline')).toHaveCount(0)
  })

  // The name and icon stay together on one line in a narrow window.
  await uatStep(page, 9, async () => {
    await page.setViewportSize({ width: 375, height: 800 })
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(375)
  })

  await uatStep(page, 10, async () => {
    await expect(heading(page)).toHaveText('Deal CRM')
    await iconBesideName(page)
  })
})
