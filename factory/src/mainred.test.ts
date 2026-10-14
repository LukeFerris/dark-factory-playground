import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { setupServer } from 'msw/node'
import { http, HttpResponse } from 'msw'
import type { WorkflowResult } from './baseline.ts'
import type { JiraConfig } from './jira.ts'
import {
  MAIN_RED_END,
  MAIN_RED_START,
  MAX_RAISED,
  labelFor,
  raiseMainRed,
  withMainRed,
  type Raised,
} from './mainred.ts'

const BASE = 'https://example.atlassian.net'
const cfg: JiraConfig = { base: BASE, user: 'me@example.com', token: 'token' }

const server = setupServer()
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

const excused = (...tests: string[]): WorkflowResult => ({
  workflow: 'e2e-tests.yml',
  state: 'excused',
  conclusion: 'failure',
  url: 'https://github.com/o/r/actions/runs/100',
  failed: [],
  excused: tests,
  baseline: { sha: 'm'.repeat(40), url: 'https://github.com/o/r/actions/runs/101' },
  note: null,
})

/** Jira, holding open cards by label, and recording what it is asked to create. */
function jira(open: Record<string, string> = {}): {
  created: Array<Record<string, unknown>>
  searched: string[]
} {
  const created: Array<Record<string, unknown>> = []
  const searched: string[] = []
  server.use(
    http.get(`${BASE}/rest/api/3/issue/DF-7`, () =>
      HttpResponse.json({ key: 'DF-7', fields: { issuetype: { id: '10001' } } }),
    ),
    http.post(`${BASE}/rest/api/3/search/jql`, async ({ request }) => {
      const { jql } = (await request.json()) as { jql: string }
      searched.push(jql)
      const label = /labels = "([^"]+)"/.exec(jql)?.[1] ?? ''
      return HttpResponse.json({
        issues: open[label] === undefined ? [] : [{ key: open[label], fields: {} }],
        isLast: true,
      })
    }),
    http.post(`${BASE}/rest/api/3/issue`, async ({ request }) => {
      const { fields } = (await request.json()) as { fields: Record<string, unknown> }
      created.push(fields)
      return HttpResponse.json({ key: `DF-${100 + created.length}` }, { status: 201 })
    }),
  )
  return { created, searched }
}

describe('a card for each failure main has', () => {
  it('is labelled by workflow and test, the same every time', () => {
    expect(labelFor('e2e-tests.yml', 'a')).toMatch(/^enki-main-red-[0-9a-f]{12}$/)
    expect(labelFor('e2e-tests.yml', 'a')).toBe(labelFor('e2e-tests.yml', 'a'))
    expect(labelFor('e2e-tests.yml', 'a')).not.toBe(labelFor('other.yml', 'a'))
  })

  it("is raised in the card's space, as its work type, with the label, assigned to nobody", async () => {
    const { created, searched } = jira()
    const raised = await raiseMainRed(
      cfg,
      'DF-7',
      [excused('[chromium] › a.spec.ts › logs in')],
      'https://github.com/o/r/pull/9',
    )
    expect(raised).toEqual([
      {
        workflow: 'e2e-tests.yml',
        test: '[chromium] › a.spec.ts › logs in',
        key: 'DF-101',
        created: true,
      },
    ])
    expect(searched[0]).toContain('project = "DF"')
    expect(searched[0]).toContain('statusCategory != Done')
    expect(created[0]).toMatchObject({
      project: { key: 'DF' },
      issuetype: { id: '10001' },
      summary: 'Failing on main: [chromium] › a.spec.ts › logs in',
      labels: [labelFor('e2e-tests.yml', '[chromium] › a.spec.ts › logs in')],
    })
    expect(created[0]).toHaveProperty('assignee', null)
    expect(JSON.stringify(created[0]?.['description'])).toContain('https://github.com/o/r/pull/9')
  })

  it('is found, not raised again, while it is open', async () => {
    const { created } = jira({ [labelFor('e2e-tests.yml', 'a')]: 'DF-50' })
    expect(await raiseMainRed(cfg, 'DF-7', [excused('a', 'b')], null)).toEqual([
      { workflow: 'e2e-tests.yml', test: 'a', key: 'DF-50', created: false },
      { workflow: 'e2e-tests.yml', test: 'b', key: 'DF-101', created: true },
    ])
    expect(created).toHaveLength(1)
  })
})

describe('a card that cannot be raised', () => {
  it(`is raised for ${MAX_RAISED} at most in one report`, async () => {
    const { created } = jira()
    const tests = Array.from({ length: MAX_RAISED + 3 }, (_, i) => `t${i}`)
    const raised = await raiseMainRed(cfg, 'DF-7', [excused(...tests)], null)
    expect(created).toHaveLength(MAX_RAISED)
    expect(raised.filter((r) => r.key === null)).toHaveLength(3)
  })

  it('never throws when Jira will not have it', async () => {
    server.use(
      http.get(`${BASE}/rest/api/3/issue/DF-7`, () =>
        HttpResponse.json({ key: 'DF-7', fields: { issuetype: { id: '1' } } }),
      ),
      http.post(`${BASE}/rest/api/3/search/jql`, () =>
        HttpResponse.json({ issues: [], isLast: true }),
      ),
      http.post(`${BASE}/rest/api/3/issue`, () =>
        HttpResponse.json({ errors: { summary: 'no' } }, { status: 400 }),
      ),
    )
    expect(await raiseMainRed(cfg, 'DF-7', [excused('a')], null)).toEqual([
      { workflow: 'e2e-tests.yml', test: 'a', key: null, created: false },
    ])
  })

  it('raises none for a subtask, whose type needs a parent, but still finds an open one', async () => {
    const { created } = jira({ [labelFor('e2e-tests.yml', 'a')]: 'DF-50' })
    server.use(
      http.get(`${BASE}/rest/api/3/issue/DF-7`, () =>
        HttpResponse.json({ key: 'DF-7', fields: { issuetype: { id: '12313', subtask: true } } }),
      ),
    )
    expect((await raiseMainRed(cfg, 'DF-7', [excused('a', 'b')], null)).map((r) => r.key)).toEqual([
      'DF-50',
      null,
    ])
    expect(created).toEqual([])
  })

  it('asks Jira nothing when nothing was excused', async () => {
    expect(await raiseMainRed(cfg, 'DF-7', [{ ...excused(), state: 'pass' }], null)).toEqual([])
  })
})

describe('the list in the pull request body', () => {
  const raised: Raised[] = [
    { workflow: 'e2e-tests.yml', test: 'logs `in`', key: 'DF-50', created: false },
  ]
  const block = '<!-- factory\n{"key":"DF-7"}\nfactory -->'

  it('goes above the factory block, which stays last', () => {
    const body = withMainRed(`Prose.\n\n${block}\n`, raised, 'm'.repeat(40))
    expect(body.indexOf(MAIN_RED_START)).toBeGreaterThan(body.indexOf('Prose.'))
    expect(body.indexOf(MAIN_RED_END)).toBeLessThan(body.indexOf('<!-- factory'))
    expect(body).toContain("- `logs 'in'` (e2e-tests.yml) — DF-50")
    expect(body).toContain('on main at mmmmmmm')
  })

  it('is rewritten in place, and taken out once there is nothing to list', () => {
    const once = withMainRed(`Prose.\n\n${block}\n`, raised, null)
    const twice = withMainRed(once, [{ ...raised[0]!, key: 'DF-51' }], null)
    expect(twice.split(MAIN_RED_START)).toHaveLength(2)
    expect(twice).toContain('DF-51')
    expect(twice).not.toContain('DF-50')
    const gone = withMainRed(twice, [], null)
    expect(gone).not.toContain(MAIN_RED_START)
    expect(gone).toBe(`Prose.\n\n${block}\n`)
  })
})
