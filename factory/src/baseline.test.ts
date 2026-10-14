import { describe, expect, it } from 'vitest'
import { parseFailedTests } from './dispatched.ts'
import { getRunner, setRunner } from './github.ts'
import { verify } from './verify.ts'
import { BASE, FAST, SHA, dispatched, failing, rule, run, stub, useStubGh } from './verify.stub.ts'

useStubGh()

describe('a dispatched workflow that fails (ADR 0010)', () => {
  const e2e = { pr: 7, sha: SHA, ...FAST, workflows: ['e2e.yml'] }

  it('runs the failed tests again on main, at the merge base, and holds those that pass there against the card', async () => {
    stub({ outcome: failing({ failed: ['[chromium] › a.spec.ts › one', 'b'], errors: 0 }) })
    const verdict = await verify(e2e)
    expect(verdict.outcome).toBe('red')
    expect(verdict.workflows[0]).toMatchObject({
      state: 'fail',
      failed: ['[chromium] › a.spec.ts › one', 'b'],
      excused: [],
      baseline: { sha: BASE, url: 'https://github.com/o/r/actions/runs/101' },
    })
    expect(dispatched[1]).toMatchObject({
      branch: 'main',
      inputs: {
        pr: '7',
        sha: BASE,
        tests: '["[chromium] › a.spec.ts › one","b"]',
        tag: 'verify-55-1-baseline',
      },
    })
  })

  it('excuses a failure main has too, and is green when that is all there is', async () => {
    stub({
      outcome: failing({ failed: ['a', 'b'], errors: 0 }, { failed: ['a', 'b', 'c'], errors: 0 }),
    })
    const verdict = await verify(e2e)
    expect(verdict.outcome).toBe('green')
    expect(verdict.workflows[0]).toMatchObject({
      state: 'excused',
      failed: [],
      excused: ['a', 'b'],
    })
  })

  it('is red on what is left when main fails only some of them', async () => {
    stub({ outcome: failing({ failed: ['a', 'b'], errors: 0 }, { failed: ['a'], errors: 0 }) })
    const verdict = await verify(e2e)
    expect(verdict.outcome).toBe('red')
    expect(verdict.workflows[0]).toMatchObject({ state: 'fail', failed: ['b'], excused: ['a'] })
  })

  it('a required check that fails is red whatever main does', async () => {
    stub({
      rules: [rule('ci')],
      runs: [run(1, 'ci', 'failure')],
      outcome: failing({ failed: ['a'], errors: 0 }, { failed: ['a'], errors: 0 }),
    })
    expect((await verify(e2e)).outcome).toBe('red')
  })
})

describe('a failure verify cannot excuse', () => {
  const e2e = { pr: 7, sha: SHA, ...FAST, workflows: ['e2e.yml'] }

  it.each([
    ['left no list', undefined],
    ['failed outside its tests', { failed: ['a'], errors: 1 }],
    ['failed with no test failing', { failed: [], errors: 0 }],
    ['left a list that is not one', { failed: ['a\nb'], errors: 0 }],
  ])(
    'counts against the card, and runs nothing on main, when the run %s',
    async (_why, artifact) => {
      stub({
        outcome: (_inputs, ref) =>
          ref === 'main'
            ? { conclusion: 'failure', artifact: { failed: ['a'], errors: 0 } }
            : { conclusion: 'failure', artifact },
      })
      const verdict = await verify(e2e)
      expect(verdict.outcome).toBe('red')
      expect(verdict.workflows[0]?.state).toBe('fail')
      expect(verdict.workflows[0]?.note).not.toBeNull()
      expect(dispatched.filter((r) => r.branch === 'main')).toEqual([])
    },
  )

  it("counts against the card when main's run could not be read", async () => {
    stub({ outcome: failing({ failed: ['a'], errors: 0 }, { failed: ['a'], errors: 2 }) })
    const verdict = await verify(e2e)
    expect(verdict.outcome).toBe('red')
    expect(verdict.workflows[0]).toMatchObject({ state: 'fail', failed: ['a'], excused: [] })
  })
})

describe("main's side of the comparison", () => {
  const e2e = { pr: 7, sha: SHA, ...FAST, workflows: ['e2e.yml'] }

  it("counts against the card when main's copy of the workflow cannot take the baseline", async () => {
    stub({ outcome: failing({ failed: ['a'], errors: 0 }), workflows: ['e2e.yml'] })
    setRunner(
      ((inner) => (args, input, env) =>
        args[0] === 'workflow' && args.includes('main')
          ? {
              status: 1,
              stdout: '',
              stderr: 'HTTP 422: Unexpected inputs provided: ["sha","tests","tag"]',
            }
          : inner(args, input, env))(getRunner()),
    )
    const verdict = await verify(e2e)
    expect(verdict.outcome).toBe('red')
    expect(verdict.workflows[0]?.note).toContain('could not be run again on main')
  })

  it('starts a workflow that takes no tag without one, finds its run by commit, and excuses nothing', async () => {
    stub({
      untagged: ['e2e.yml'],
      outcome: failing({ failed: ['a'], errors: 0 }, { failed: ['a'], errors: 0 }),
    })
    const verdict = await verify(e2e)
    expect(dispatched.map((r) => r.inputs)).toEqual([{ pr: '7' }])
    expect(verdict.outcome).toBe('red')
    expect(verdict.workflows[0]).toMatchObject({
      state: 'fail',
      failed: ['a'],
      url: 'https://github.com/o/r/actions/runs/100',
    })
  })
})

describe('a run verify did not ask for', () => {
  const e2e = { pr: 7, sha: SHA, ...FAST, workflows: ['e2e.yml'] }

  it('does not take a run another verify started for its own', async () => {
    stub({})
    dispatched.push({
      databaseId: 90,
      displayTitle: 'E2E Tests for #7 verify-54-1',
      headSha: SHA,
      status: 'completed',
      conclusion: 'failure',
      url: 'https://github.com/o/r/actions/runs/90',
      createdAt: new Date().toISOString(),
      branch: 'card/DF-1-thing',
      workflow: 'e2e.yml',
      inputs: {},
    })
    const verdict = await verify(e2e)
    expect(verdict.workflows[0]).toMatchObject({
      state: 'pass',
      url: 'https://github.com/o/r/actions/runs/101',
    })
  })

  it('runs the whole suite on main when the list is too long to send', async () => {
    const many = Array.from(
      { length: 200 },
      (_, i) => `[chromium] › spec-${i}.spec.ts › ${'x'.repeat(400)}`,
    )
    stub({ outcome: failing({ failed: many, errors: 0 }, { failed: many, errors: 0 }) })
    expect((await verify(e2e)).outcome).toBe('green')
    expect(dispatched[1]?.inputs['tests']).toBe('')
  })
})

describe('the failed-tests list', () => {
  it('is sorted and has no repeats', () => {
    expect(parseFailedTests('{"failed":["b","a","b"],"errors":0}')).toEqual({
      failed: ['a', 'b'],
      errors: 0,
    })
  })

  it.each([
    'not json',
    'null',
    '{"failed":"a","errors":0}',
    '{"failed":["a"]}',
    '{"failed":["a"],"errors":-1}',
    '{"failed":[1],"errors":0}',
    '{"failed":[""],"errors":0}',
    `{"failed":["${'x'.repeat(501)}"],"errors":0}`,
  ])('is refused when it is %s', (text) => {
    expect(parseFailedTests(text)).toBeNull()
  })
})
