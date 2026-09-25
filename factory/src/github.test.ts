import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  packageVersionsPath,
  parseFactoryBlock,
  renderFactoryBlock,
  upsertFactoryBlock,
  setRunner,
  ghRunner,
  gh,
  type FactoryBlock,
} from './github.ts'

describe('the factory block', () => {
  const block: FactoryBlock = { key: 'DF-1', stage: 'build', turn: 3, preview_url: 'https://x/y' }

  it('round-trips through render and parse', () => {
    expect(parseFactoryBlock(renderFactoryBlock(block))).toEqual(block)
  })

  it('appends a block to a body that has none, leaving the prose intact', () => {
    const body = upsertFactoryBlock('Some human prose.', block)
    expect(body).toContain('Some human prose.')
    expect(parseFactoryBlock(body)).toEqual(block)
  })

  it('replaces an existing block without duplicating it', () => {
    const first = upsertFactoryBlock('Prose.', block)
    const second = upsertFactoryBlock(first, { ...block, turn: 4 })

    expect(parseFactoryBlock(second)?.turn).toBe(4)
    expect(second.match(/<!-- factory/g)).toHaveLength(1)
    expect(second).toContain('Prose.')
  })

  it('returns null for a body with no block', () => {
    expect(parseFactoryBlock('No block here.')).toBeNull()
  })

  it('returns null rather than throwing when the block is corrupt', () => {
    expect(parseFactoryBlock('<!-- factory\nnot json\nfactory -->')).toBeNull()
  })

  /**
   * The prose the factory itself writes above the block quotes the marker, so
   * a search for the bare string finds the sentence rather than the block.
   * That is not hypothetical: it is why PR #16's preview URL was never
   * recorded, and it fails silently in both directions.
   */
  describe('when the prose mentions the marker', () => {
    const prose = 'The `<!-- factory … -->` block below is machine-read — leave it alone.'
    const body = `${prose}\n\n${renderFactoryBlock(block)}\n`

    it('reads the real block and not the sentence', () => {
      expect(parseFactoryBlock(body)).toEqual(block)
    })

    it('rewrites the real block and leaves the sentence alone', () => {
      const next = upsertFactoryBlock(body, { ...block, turn: 4 })
      expect(next).toContain(prose)
      expect(parseFactoryBlock(next)?.turn).toBe(4)
    })

    it('does not mistake an inline mention for a block of its own', () => {
      expect(parseFactoryBlock(prose)).toBeNull()
      expect(upsertFactoryBlock(prose, block)).toContain(prose)
    })
  })
})

describe('the GHCR package route', () => {
  const previous = process.env['GITHUB_REPOSITORY']

  beforeEach(() => {
    process.env['GITHUB_REPOSITORY'] = 'acme/dark-factory-playground'
  })

  afterEach(() => {
    if (previous === undefined) delete process.env['GITHUB_REPOSITORY']
    else process.env['GITHUB_REPOSITORY'] = previous
    setRunner(ghRunner)
  })

  /**
   * The user and org package routes are different endpoints, not aliases, so
   * guessing wrong is a 404 — and teardown swallows it, which would leak a
   * container image per merged card rather than fail loudly.
   */
  it('uses the org route when the owner is an organisation', () => {
    setRunner(() => ({ status: 0, stdout: '{"owner":{"type":"Organization"}}', stderr: '' }))
    expect(packageVersionsPath()).toBe(
      'orgs/acme/packages/container/dark-factory-playground/versions',
    )
  })

  it('uses the user route when the owner is a user', () => {
    setRunner(() => ({ status: 0, stdout: '{"owner":{"type":"User"}}', stderr: '' }))
    expect(packageVersionsPath()).toBe(
      'users/acme/packages/container/dark-factory-playground/versions',
    )
  })

  it('asks the repo itself which kind the owner is, rather than assuming', () => {
    const calls: string[][] = []
    setRunner((args) => {
      calls.push(args)
      return { status: 0, stdout: '{"owner":{"type":"User"}}', stderr: '' }
    })
    packageVersionsPath()
    expect(calls).toEqual([['api', 'repos/acme/dark-factory-playground']])
  })
})

describe('gh runner', () => {
  it('throws with stderr when the command fails', () => {
    setRunner(() => ({ status: 1, stdout: '', stderr: 'gh: not authenticated' }))
    expect(() => gh(['pr', 'list'])).toThrow(/not authenticated/)
  })

  it('returns stdout when the command succeeds', () => {
    setRunner(() => ({ status: 0, stdout: 'ok\n', stderr: '' }))
    expect(gh(['pr', 'list'])).toBe('ok\n')
  })
})
