import { describe, expect, it } from 'vitest'
import { failureReport } from './failure-report.ts'
import { verify } from './verify.ts'
import { FAST, SHA, failing, rule, run, stub, useStubGh } from './verify.stub.ts'

useStubGh()

describe('the failure report the next turn reads', () => {
  it("gives the end of a failed Actions job's log, without the timestamps", () => {
    const log = Array.from(
      { length: 200 },
      (_, i) => `2026-10-13T10:00:00.1234567Z line ${i}`,
    ).join('\n')
    stub({ rules: [rule('ci')], runs: [run(41, 'ci', 'failure')], logs: { 41: log } })
    const text = failureReport(SHA).join('\n')
    expect(text).toContain('### ci — failure')
    expect(text).toContain('line 199')
    expect(text).not.toContain('line 100\n')
    expect(text).not.toContain('2026-10-13T')
  })

  it('gives what a check from another app said of itself', () => {
    stub({
      rules: [rule('Datadog')],
      runs: [
        run(9, 'Datadog', 'failure', {
          app: { slug: 'datadog' },
          output: { title: 'Path traversal', summary: 'in x.ts' },
        }),
      ],
    })
    expect(failureReport(SHA).join('\n')).toContain('Path traversal\n\nin x.ts')
  })

  it("splits a dispatched workflow's failures into the card's and main's, with the end of each failed job's log", async () => {
    stub({
      outcome: failing({ failed: ['a', 'b'], errors: 0 }, { failed: ['a'], errors: 0 }),
      jobs: { 100: [77] },
      logs: { 77: '  1 failed\n    b' },
    })
    await verify({ pr: 7, sha: SHA, ...FAST, workflows: ['e2e.yml'] })
    const text = failureReport(SHA, ['e2e.yml']).join('\n')
    expect(text).toContain('### e2e.yml — failure')
    expect(text).toMatch(/yours to fix:\n\n- b\n/)
    expect(text).toMatch(/leave them alone:\n\n- a\n/)
    expect(text).toContain('1 failed\n    b')
  })

  it('says nothing of a workflow whose failures main has too', async () => {
    stub({ outcome: failing({ failed: ['a'], errors: 0 }, { failed: ['a'], errors: 0 }) })
    await verify({ pr: 7, sha: SHA, ...FAST, workflows: ['e2e.yml'] })
    expect(failureReport(SHA, ['e2e.yml'])).toEqual([])
  })

  it('is empty when nothing required is failing', () => {
    stub({ rules: [rule('ci')], runs: [run(1, 'ci', 'success')] })
    expect(failureReport(SHA)).toEqual([])
  })
})
