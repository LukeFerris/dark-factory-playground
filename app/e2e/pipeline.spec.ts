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
 *
 * It was `greeting.spec.ts` against the hello-world app until DF-8 replaced
 * that app with this one. The two landed minutes apart and neither branch
 * could see the other, so both were green alone and the merge was not: a spec
 * that names what is on screen is one another card can invalidate without
 * touching it.
 */
test('a new deal joins the pipeline', async ({ page }) => {
  await page.goto('/')

  await uatStep(page, 1, async () => {
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Deal Pipeline')
  })

  await uatStep(page, 2, async () => {
    // A name no seeded deal shares: "Northwind" matched "Northwind Analytics"
    // and four other nodes, and the strict-mode failure that caused reads as a
    // broken app rather than a careless fixture.
    await page.getByLabel('Company').fill('Calderwood Robotics')
  })

  await uatStep(page, 3, async () => {
    await page.getByLabel('Deal size (£m)').fill('12')
  })

  await uatStep(page, 4, async () => {
    await page.getByRole('button', { name: 'Add deal' }).click()
    await expect(page.getByRole('heading', { name: 'Calderwood Robotics' })).toBeVisible()
  })
})
