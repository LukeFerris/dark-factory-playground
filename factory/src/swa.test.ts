import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ghRunner, setRunner, type Runner } from './github.ts'
import { previewBackend } from './preview.ts'
import type { WorkflowRun } from './runs.ts'
import { bundleHasMarker, raiseSwa, swaConfig, swaUrl, type SwaConfig } from './swa.ts'

const SHA = 'a'.repeat(40)
const CONFIG: SwaConfig = {
  workflow: 'azure-static-web-apps.yml',
  urlTemplate: 'https://gentle-forest-0cd2b7603-{pr}.westeurope.7.azurestaticapps.net',
  notReadyMarker: 'preview-not-found',
}
const URL_183 = 'https://gentle-forest-0cd2b7603-183.westeurope.7.azurestaticapps.net'
const FAST = { gapMs: 0, rerunDelayMs: 0, runBudgetMs: 50 }

const run = (over: Partial<WorkflowRun> = {}): WorkflowRun => ({
  id: 77,
  name: 'Azure Static Web Apps CI/CD',
  status: 'completed',
  conclusion: 'success',
  run_attempt: 1,
  html_url: 'https://github.com/o/r/actions/runs/77',
  ...over,
})

/** A site whose bundle is `bundles[n]` once it has been redeployed n times. */
function site(bundles: string[]): { fetchImpl: typeof fetch; deployed: () => number } {
  let deployed = 0
  const fetchImpl = (async (input: string | URL | Request) => {
    const href = String(input)
    if (href.endsWith('/')) {
      return new Response('<html><script type="module" crossorigin src="/assets/index-AbC.js"></script></html>')
    }
    if (href.endsWith('/assets/index-AbC.js')) return new Response(bundles[Math.min(deployed, bundles.length - 1)])
    return new Response('', { status: 404 })
  }) as typeof fetch
  return { fetchImpl, deployed: () => deployed++ }
}

let calls: string[][]
const repository = process.env['GITHUB_REPOSITORY']
beforeEach(() => {
  calls = []
  process.env['GITHUB_REPOSITORY'] = 'o/r'
})
afterEach(() => {
  setRunner(ghRunner)
  if (repository === undefined) delete process.env['GITHUB_REPOSITORY']
  else process.env['GITHUB_REPOSITORY'] = repository
})

function stub(respond: (args: string[]) => unknown): void {
  const runner: Runner = (args) => {
    calls.push(args)
    const out = respond(args)
    return { status: 0, stdout: out === undefined ? '' : JSON.stringify(out), stderr: '' }
  }
  setRunner(runner)
}

describe('configuration', () => {
  const keys = ['SWA_PREVIEW_URL', 'SWA_PREVIEW_WORKFLOW', 'SWA_PREVIEW_NOT_READY', 'FACTORY_PREVIEW_BACKEND']
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]))
  afterEach(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  it('is a backend', () => {
    process.env['FACTORY_PREVIEW_BACKEND'] = 'swa'
    expect(previewBackend()).toBe('swa')
    process.env['FACTORY_PREVIEW_BACKEND'] = 'netlify'
    expect(() => previewBackend()).toThrow(/"ghcr", "azure" or "swa"/)
  })

  it('fills the PR number into the URL', () => {
    expect(swaUrl(CONFIG.urlTemplate, 183)).toBe(URL_183)
    expect(swaUrl('https://x-{pr}.example/', 4)).toBe('https://x-4.example')
  })

  it('refuses a URL with nowhere to put the PR number', () => {
    process.env['SWA_PREVIEW_WORKFLOW'] = 'swa.yml'
    process.env['SWA_PREVIEW_URL'] = 'https://gentle-forest.example'
    expect(() => swaConfig()).toThrow(/\{pr\}/)
  })
})

describe('bundleHasMarker', () => {
  it('finds the marker in a script the page loads', async () => {
    const { fetchImpl } = site(['const url="https://preview-not-found.supabase.co"'])
    expect(await bundleHasMarker(URL_183, 'preview-not-found', fetchImpl)).toBe(true)
  })

  it('is false for a bundle built against a real database', async () => {
    const { fetchImpl } = site(['const url="https://abcd.supabase.co"'])
    expect(await bundleHasMarker(URL_183, 'preview-not-found', fetchImpl)).toBe(false)
  })

  it('looks for nothing when there is no marker', async () => {
    const { fetchImpl } = site(['preview-not-found'])
    expect(await bundleHasMarker(URL_183, '', fetchImpl)).toBe(false)
  })

  it('does not fetch scripts from other sites', async () => {
    const seen: string[] = []
    const fetchImpl = (async (input: string | URL | Request) => {
      seen.push(String(input))
      return new Response('<script src="https://cdn.example/x.js"></script>')
    }) as typeof fetch
    await bundleHasMarker(URL_183, 'preview-not-found', fetchImpl)
    expect(seen).toEqual([`${URL_183}/`])
  })
})

describe('raiseSwa', () => {
  it('waits for the run on the pushed commit and returns the preview URL', async () => {
    let polls = 0
    stub((args) => {
      if (args[1]?.includes('/workflows/')) {
        polls++
        return polls < 3 ? (polls === 1 ? [] : [run({ status: 'in_progress', conclusion: null })]) : [run()]
      }
      return undefined
    })
    const { fetchImpl } = site(['ok'])
    expect(await raiseSwa(183, SHA, CONFIG, { ...FAST, fetchImpl, runBudgetMs: 5_000 })).toBe(URL_183)
    expect(polls).toBe(3)
    expect(calls[0]?.[1]).toBe(
      `repos/o/r/actions/workflows/azure-static-web-apps.yml/runs?head_sha=${SHA}&event=pull_request&per_page=10`,
    )
  })

  it('fails when the workflow failed, rather than publishing a broken preview', async () => {
    stub(() => [run({ conclusion: 'failure' })])
    const { fetchImpl } = site(['ok'])
    await expect(raiseSwa(183, SHA, CONFIG, { ...FAST, fetchImpl })).rejects.toThrow(/finished "failure"/)
  })

  it('says so when no run ever appears', async () => {
    stub(() => [])
    const { fetchImpl } = site(['ok'])
    await expect(raiseSwa(183, SHA, CONFIG, { ...FAST, fetchImpl })).rejects.toThrow(/No run of azure-static-web-apps.yml appeared/)
  })

  it('runs the workflow again while the bundle is not ready, and waits for the new attempt', async () => {
    const { fetchImpl, deployed } = site(['preview-not-found', 'https://abcd.supabase.co'])
    let attempt = 1
    let pollsSinceRerun = 0
    stub((args) => {
      if (args[1]?.includes('/workflows/')) return [run()]
      if (args.includes('POST')) {
        attempt++
        pollsSinceRerun = 0
        deployed()
        return undefined
      }
      // The first poll after a rerun still sees the old, completed attempt.
      pollsSinceRerun++
      return pollsSinceRerun === 1 ? run({ run_attempt: attempt - 1 }) : run({ run_attempt: attempt })
    })
    expect(await raiseSwa(183, SHA, CONFIG, { ...FAST, fetchImpl, runBudgetMs: 5_000 })).toBe(URL_183)
    expect(calls.filter((a) => a.includes('POST')).map((a) => a.at(-1))).toEqual(['repos/o/r/actions/runs/77/rerun'])
    expect(pollsSinceRerun).toBe(2)
  })

  it('gives up after the last rerun', async () => {
    let attempt = 1
    stub((args) => {
      if (args.includes('POST')) attempt++
      return args[1]?.includes('/workflows/') ? [run()] : run({ run_attempt: attempt })
    })
    const { fetchImpl } = site(['preview-not-found'])
    await expect(raiseSwa(183, SHA, CONFIG, { ...FAST, fetchImpl, maxReruns: 2 })).rejects.toThrow(
      /still contains "preview-not-found" after 2 reruns/,
    )
    expect(calls.filter((a) => a.includes('POST'))).toHaveLength(2)
  })
})
