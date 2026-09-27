import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'

/**
 * The bridge between the end-to-end suite and the Jira card.
 *
 * `result.json` carries `acceptance_criteria`, each with the browser steps that
 * prove it. Flattened in order, those steps are numbered 1..N across the whole
 * card — that is the numbering the reviewer sees under "Proving it" in the
 * comment, and it is the numbering used here. `uatStep(page, 7, …)` is step 7
 * of that list and nothing else.
 *
 * The numbers are the only thing tying the two together, so they have to agree.
 * When a turn changes the steps it also changes the numbers in the spec, in the
 * same turn. A screenshot matching no step is dropped by the slide builder with
 * a warning, and a step with no screenshot is simply one the reviewer does
 * themselves — neither is an error, because evidence must never be the thing
 * that stops a finished card reaching a human.
 */

const EVIDENCE_DIR = process.env['FACTORY_UAT_EVIDENCE'] ?? ''

/** Whether this run is the evidence run. Unset outside the preview job. */
export function capturing(): boolean {
  return EVIDENCE_DIR !== ''
}

/**
 * One numbered acceptance step.
 *
 * `body` does the step's action **and asserts its expected outcome**. That
 * assertion is the readiness wait, and it is why the screenshot is worth
 * keeping: a raw runner races ahead and shoots a half-drawn page. Wait for the
 * step's own result — the new row is present, the heading reads the new text —
 * not for a generic signal like the network going idle, which background
 * requests can defer forever and which says nothing about whether this step's
 * write landed.
 *
 * If the assertion fails the step fails. Nothing is captured, and that is the
 * correct outcome: a screenshot of a step that did not pass is worse than no
 * screenshot, because it looks like evidence.
 */
export async function uatStep(page: Page, n: number, body: () => Promise<void>): Promise<void> {
  await body()

  if (!capturing()) return

  mkdirSync(EVIDENCE_DIR, { recursive: true })
  await page.screenshot({ path: join(EVIDENCE_DIR, `step-${String(n).padStart(2, '0')}.png`) })

  // A deliberate hold, so the recorded video is legible rather than a blur.
  // It is for the viewer only and never stands in for the assertion above;
  // padding a video afterwards cannot recover a state that was never reached.
  await page.waitForTimeout(600)
}
