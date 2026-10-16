import { describe, expect, it } from 'vitest'
import { checksToWaitFor, verify } from './verify.ts'
import { FAST, SHA, rule, run, stub, useStubGh } from './verify.stub.ts'

useStubGh()

/**
 * The checks FACTORY_VERIFY_CHECKS names, such as Commit gates: the hooks the
 * agent commits through, run again where it cannot reach them (ADR 0011).
 */

const naming = async (names: string, body: () => unknown): Promise<void> => {
  process.env['FACTORY_VERIFY_CHECKS'] = names
  try {
    await body()
  } finally {
    delete process.env['FACTORY_VERIFY_CHECKS']
  }
}

describe('the checks verify waits for', () => {
  it('are the ones main requires and the ones FACTORY_VERIFY_CHECKS names, once each', async () => {
    stub({ rules: [rule('ci')] })
    await naming(' Commit gates, ,ci ', () => {
      expect(checksToWaitFor()).toEqual(['Commit gates', 'ci'])
    })
    expect(checksToWaitFor()).toEqual(['ci'])
  })

  it('are red when a named check fails that main does not require', async () => {
    await naming('Commit gates', async () => {
      stub({
        rules: [rule('ci')],
        runs: [run(1, 'ci', 'success'), run(2, 'Commit gates', 'failure')],
      })
      const verdict = await verify({ pr: 7, sha: SHA, ...FAST })
      expect(verdict.outcome).toBe('red')
      expect(verdict.checks).toContainEqual(
        expect.objectContaining({ name: 'Commit gates', state: 'fail' }),
      )
    })
  })
})
