import { optional, required } from './env.ts'
import { gh, repoSlug } from './github.ts'
import { findRun, getRun, waitForRun, type RunWaitOptions } from './runs.ts'

/**
 * Previews a repository already raises for itself, on Azure Static Web Apps.
 *
 * A repository with an SWA workflow gets a staging environment per pull
 * request without the factory doing anything: the workflow runs on every push
 * to the PR, builds the site and uploads it. So this backend builds nothing. It
 * waits for that workflow to finish on the commit the factory just pushed,
 * checks the site it deployed is usable, and hands back the URL.
 *
 * It is a stopgap. Staging environments are capped per Static Web App, which
 * is why the factory's own previews run on Container Apps (the `azure`
 * backend). This is for a repository that has not moved yet.
 *
 * Configured by variables, because none of it is the factory's to know:
 *
 * - `SWA_PREVIEW_WORKFLOW`: the workflow file that deploys previews, such as
 *   `azure-static-web-apps.yml`.
 * - `SWA_PREVIEW_URL`: the preview's URL with `{pr}` for the PR number, such as
 *   `https://gentle-forest-0cd2b7603-{pr}.westeurope.7.azurestaticapps.net`.
 * - `SWA_PREVIEW_NOT_READY` (optional): text that appears in the deployed
 *   bundle when the workflow built it before something it depends on was ready,
 *   such as a database branch. When it is found, the workflow is run again.
 * - `SWA_PREVIEW_MAX_RERUNS` (optional, default 3) and
 *   `SWA_PREVIEW_RERUN_DELAY_SECONDS` (optional, default 60): how many times to
 *   run it again, and how long to wait before each. Size them to what the
 *   bundle waits on: a Supabase preview branch takes about 13 minutes.
 */

export interface SwaConfig {
  workflow: string
  urlTemplate: string
  notReadyMarker: string
  maxReruns: number
  rerunDelayMs: number
}

const MAX_RERUNS = 3
const RERUN_DELAY_SECONDS = 60

function count(name: string, fallback: number): number {
  const raw = optional(name, String(fallback))
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a whole number of 0 or more: ${raw}`)
  return value
}

export function swaConfig(): SwaConfig {
  const urlTemplate = required('SWA_PREVIEW_URL')
  if (!urlTemplate.includes('{pr}')) {
    throw new Error(`SWA_PREVIEW_URL must contain {pr} where the pull request number goes: ${urlTemplate}`)
  }
  return {
    workflow: required('SWA_PREVIEW_WORKFLOW'),
    urlTemplate,
    notReadyMarker: optional('SWA_PREVIEW_NOT_READY'),
    maxReruns: count('SWA_PREVIEW_MAX_RERUNS', MAX_RERUNS),
    rerunDelayMs: count('SWA_PREVIEW_RERUN_DELAY_SECONDS', RERUN_DELAY_SECONDS) * 1000,
  }
}

export function swaUrl(template: string, prNumber: number): string {
  return template.replaceAll('{pr}', String(prNumber)).replace(/\/+$/, '')
}

export interface SwaWaitOptions extends RunWaitOptions {
  /** Overrides `config.maxReruns`. */
  maxReruns?: number
  /** Overrides `config.rerunDelayMs`. */
  rerunDelayMs?: number
  fetchImpl?: typeof fetch
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Whether the site at `url` was built before what it depends on was ready.
 *
 * Reads the page and every script it loads from the same site, and looks for
 * the marker in each. A site that does not answer is not "not ready" in this
 * sense; `waitUntilAwake` deals with that afterwards.
 */
export async function bundleHasMarker(url: string, marker: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  if (marker === '') return false
  const read = async (target: string): Promise<string> => {
    try {
      const response = await fetchImpl(target, { signal: AbortSignal.timeout(30_000) })
      return response.ok ? await response.text() : ''
    } catch {
      return ''
    }
  }

  const page = await read(`${url}/`)
  if (page.includes(marker)) return true
  const scripts = [...page.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)]
    .map((m) => new URL(m[1] ?? '', `${url}/`))
    .filter((src) => src.origin === new URL(url).origin)
  for (const src of scripts) {
    if ((await read(src.href)).includes(marker)) return true
  }
  return false
}

/**
 * Waits for the repository's own preview of `sha`, runs it again while it is
 * not ready, and returns its URL.
 */
export async function raiseSwa(
  prNumber: number,
  sha: string,
  config: SwaConfig = swaConfig(),
  options: SwaWaitOptions = {},
): Promise<string> {
  const url = swaUrl(config.urlTemplate, prNumber)
  const maxReruns = options.maxReruns ?? config.maxReruns
  const rerunDelayMs = options.rerunDelayMs ?? config.rerunDelayMs

  let run = await waitForRun(config.workflow, () => findRun(config.workflow, sha, 'pull_request'), 1, options)
  console.log(`preview-up: ${config.workflow} deployed ${sha.slice(0, 7)} (${run.html_url})`)

  for (let rerun = 1; await bundleHasMarker(url, config.notReadyMarker, options.fetchImpl); rerun++) {
    if (rerun > maxReruns) {
      throw new Error(
        `The preview at ${url} still contains "${config.notReadyMarker}" after ${maxReruns} reruns of ` +
          `${config.workflow}, so it was built against something that is not ready. Last run: ${run.html_url}`,
      )
    }
    console.log(
      `preview-up: ${url} was built before it was ready ("${config.notReadyMarker}"); ` +
        `running ${config.workflow} again (${rerun} of ${maxReruns}).`,
    )
    await sleep(rerunDelayMs)
    gh(['api', '-X', 'POST', `repos/${repoSlug()}/actions/runs/${run.id}/rerun`])
    const id = run.id
    run = await waitForRun(config.workflow, () => getRun(id), run.run_attempt + 1, options)
  }

  return url
}
