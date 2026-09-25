import { afterEach, describe, expect, it } from 'vitest'
import { launcherBase, launcherFor } from './launcher.ts'

const LAUNCHER = 'https://stfactory1234.z33.web.core.windows.net'
const PREVIEW = 'https://df-preview-pr-16.redbush-3ff4fb61.uksouth.azurecontainerapps.io'

describe('launcherBase', () => {
  const previous = process.env['AZURE_PREVIEW_LAUNCHER']

  afterEach(() => {
    if (previous === undefined) delete process.env['AZURE_PREVIEW_LAUNCHER']
    else process.env['AZURE_PREVIEW_LAUNCHER'] = previous
  })

  it('is empty when no launcher is configured', () => {
    delete process.env['AZURE_PREVIEW_LAUNCHER']
    expect(launcherBase()).toBe('')
  })

  /** Azure's static website endpoint ends in a slash; the code appends one. */
  it('drops the trailing slash Azure hands out', () => {
    process.env['AZURE_PREVIEW_LAUNCHER'] = `${LAUNCHER}/`
    expect(launcherBase()).toBe(LAUNCHER)
  })
})

describe('launcherFor', () => {
  it('wraps a preview URL, round-tripping it through the query string', () => {
    const wrapped = launcherFor(PREVIEW, LAUNCHER)
    expect(wrapped).toBe(`${LAUNCHER}/?u=${encodeURIComponent(PREVIEW)}`)
    expect(new URL(wrapped).searchParams.get('u')).toBe(PREVIEW)
  })

  /**
   * Every fallback here returns the original URL rather than nothing. A
   * launcher is an improvement on a link, not a precondition for having one —
   * a clone with no Azure estate still gets working preview links.
   */
  it('returns the URL untouched when no launcher is configured', () => {
    expect(launcherFor(PREVIEW, '')).toBe(PREVIEW)
  })

  it('passes null through, because a PR with no preview has no link to wrap', () => {
    expect(launcherFor(null, LAUNCHER)).toBeNull()
  })

  /**
   * The `ghcr` stub's URL is a GHCR package page, which is always awake and
   * was never the app. Wrapping it would put a "waking the preview" page in
   * front of something that does not wake.
   */
  it('leaves a non-Container-App URL alone', () => {
    const packagePage = 'https://github.com/acme/repo/pkgs/container/repo'
    expect(launcherFor(packagePage, LAUNCHER)).toBe(packagePage)
  })

  it('leaves anything that is not an https URL alone', () => {
    expect(launcherFor('not a url', LAUNCHER)).toBe('not a url')
    expect(launcherFor('http://df-preview.azurecontainerapps.io', LAUNCHER)).toBe(
      'http://df-preview.azurecontainerapps.io',
    )
  })

  /**
   * The suffix check is anchored at the end. `azurecontainerapps.io.evil.test`
   * ends with neither, and must not be wrapped — the launcher redirects to
   * whatever it is handed after running the same check client-side, so a host
   * that slips past here is the whole open-redirect question.
   */
  it('is not fooled by a hostname that merely contains the suffix', () => {
    const lookalike = 'https://df.azurecontainerapps.io.evil.test/'
    expect(launcherFor(lookalike, LAUNCHER)).toBe(lookalike)
  })
})
