import { afterEach, describe, expect, it } from 'vitest'
import { adfToText } from './jira.ts'
import { SHIPPED_STATUS, productionSupported, shippedComment } from './production.ts'

describe('where production can exist', () => {
  const previous = process.env['FACTORY_PREVIEW_BACKEND']

  afterEach(() => {
    if (previous === undefined) delete process.env['FACTORY_PREVIEW_BACKEND']
    else process.env['FACTORY_PREVIEW_BACKEND'] = previous
  })

  /**
   * The ghcr stub pushes an image nobody serves. Shipping on the strength of
   * that would move a card to Done on the basis of a package page, so the
   * workflow skips instead and the card stays in review.
   */
  it('is azure only, because the stub serves nothing', () => {
    process.env['FACTORY_PREVIEW_BACKEND'] = 'azure'
    expect(productionSupported()).toBe(true)
    process.env['FACTORY_PREVIEW_BACKEND'] = 'ghcr'
    expect(productionSupported()).toBe(false)
    delete process.env['FACTORY_PREVIEW_BACKEND']
    expect(productionSupported()).toBe(false)
  })
})

describe('the shipped comment', () => {
  const url = 'https://df-production.kindsky.uksouth.azurecontainerapps.io'
  const comment = shippedComment('DF-6', url, 'https://github.com/o/r/pull/20', 'https://run')
  const flat = adfToText(comment)

  it('says the card was closed by the factory and why it was allowed to', () => {
    expect(flat).toContain('DF-6')
    expect(flat).toContain('production is serving it')
    expect(flat).toContain(SHIPPED_STATUS)
  })

  /**
   * The live URL is the point of the comment — it is the only place a person
   * reading the card learns where the thing they asked for ended up.
   */
  it('carries the production URL, unwrapped', () => {
    expect(flat).toContain(url)
    // No launcher. Production never sleeps, so there is no cold start to hide
    // behind a loading page, and a redirect would only be in the way.
    expect(flat).not.toContain('?u=')
  })

  it('links the pull request and the run that shipped it', () => {
    expect(flat).toContain('Pull request')
    expect(flat).toContain('Actions run')
  })

  it('omits the links it was not given rather than printing empty ones', () => {
    const bare = adfToText(shippedComment('DF-6', url, null, null))
    expect(bare).not.toContain('Pull request')
    expect(bare).not.toContain('Actions run')
    expect(bare).toContain(url)
  })
})
