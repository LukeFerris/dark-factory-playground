import { expect, test } from '@playwright/test'
import { uatStep } from './uat'

/**
 * The walkthrough for what the app does today.
 *
 * It exists so the plumbing is exercised from the first turn rather than from
 * whichever card first happens to need it: every part of the chain — the
 * capture switch, the step numbering, the slide builder, the attachment on the
 * card — is proved by this file until a card replaces it.
 *
 * Step numbers are the flattened `acceptance_criteria` steps a build turn
 * writes into `result.json`. A turn that changes those steps renumbers here in
 * the same turn.
 */
test('the page greets the visitor', async ({ page }) => {
  await page.goto('/')

  await uatStep(page, 1, async () => {
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Dark Factory Playground')
  })

  await uatStep(page, 2, async () => {
    await expect(page.getByText(/^Hello, /)).toBeVisible()
  })
})
