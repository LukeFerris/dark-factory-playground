import { defineConfig, devices } from '@playwright/test'

/**
 * The end-to-end suite, which is also the walkthrough.
 *
 * A spec here is run twice and written once. CI runs it as a plain regression
 * test; the preview job runs the same spec with `FACTORY_UAT_EVIDENCE` set, and
 * that run leaves a screenshot per acceptance step. Nothing is written a second
 * time to produce the evidence — no throwaway driver, no copy of the flow with
 * screenshots bolted on. See `.agent/build.md` and `e2e/uat.ts`.
 *
 * Two environment variables, and both are set by the workflow rather than by a
 * spec:
 *
 *   FACTORY_E2E_BASE_URL   where to run. Unset means the local `vite preview`
 *                          server below, which is what an agent gets. The
 *                          preview job sets it to the deployed preview: the
 *                          same build the reviewer opens.
 *   FACTORY_UAT_EVIDENCE   a directory. Set means capture; unset means the
 *                          suite asserts and moves on with no screenshots, no
 *                          holds and no video, so an ordinary run inherits no
 *                          presentation delay.
 *
 * This file is on the agent's denied list. Capture, viewport and base URL are
 * the terms the evidence is produced under, and a turn that could edit them
 * could quietly stop proving anything.
 */

const baseURL = process.env['FACTORY_E2E_BASE_URL'] ?? 'http://localhost:4173'
const capturing = (process.env['FACTORY_UAT_EVIDENCE'] ?? '') !== ''

export default defineConfig({
  testDir: './e2e',
  // A capture run holds each result on screen to be legible in the slides, so
  // it is slower than a plain run by design. The timeout covers both.
  timeout: 60_000,
  expect: { timeout: 10_000 },
  // Serial. The screenshots are numbered by acceptance step and land in one
  // directory; two workers would interleave two runs into one evidence set.
  workers: 1,
  forbidOnly: true,
  retries: 0,
  reporter: [['list']],
  outputDir: './e2e/.results',
  use: {
    baseURL,
    // Fixed, and the same shape the slide builder letterboxes into. A
    // screenshot whose size moves between turns makes a video whose frames
    // jump.
    viewport: { width: 1280, height: 720 },
    video: capturing ? 'on' : 'off',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  // Only when nothing else is serving. `reuseExistingServer` is false so a run
  // never silently tests whatever happened to be on the port already.
  ...(process.env['FACTORY_E2E_BASE_URL'] === undefined
    ? {
        webServer: {
          command: 'npm run build && npm run preview -- --port 4173 --strictPort',
          url: 'http://localhost:4173',
          reuseExistingServer: false,
          timeout: 120_000,
        },
      }
    : {}),
})
